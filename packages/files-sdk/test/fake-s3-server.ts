// An in-memory, path-style S3 endpoint exposed as an injectable `fetch`
// implementation. Backs the s3-fetch core and r2 `client: "fetch"` tests —
// enough of the REST surface (PutObject, GetObject + Range, HeadObject,
// DeleteObject, CopyObject, ListObjectsV2) to exercise every code path
// without a network.

export interface FakeS3Object {
  bytes: Uint8Array;
  type: string;
  meta: Record<string, string>;
  cacheControl?: string;
  etag: string;
  lastModified: string;
}

export interface FakeS3 {
  fetchImpl: (request: Request) => Promise<Response>;
  requests: Request[];
  store: Map<string, FakeS3Object>;
  /** When set, the next CopyObject returns 200 with an `<Error>` body. */
  failNextCopyWith200: boolean;
  /** When `true`, every request returns 403 AccessDenied. */
  denyAll: boolean;
  seed: (key: string, text: string, type?: string) => void;
}

const escapeXml = (text: string): string =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

const errorXml = (code: string, message: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${escapeXml(message)}</Message></Error>`;

const errorResponse = (
  status: number,
  code: string,
  message: string
): Response =>
  new Response(errorXml(code, message), {
    headers: { "content-type": "application/xml" },
    status,
  });

const objectHeaders = (obj: FakeS3Object): Record<string, string> => ({
  "content-length": String(obj.bytes.byteLength),
  "content-type": obj.type,
  etag: `"${obj.etag}"`,
  "last-modified": obj.lastModified,
  ...Object.fromEntries(
    Object.entries(obj.meta).map(([name, value]) => [
      `x-amz-meta-${name}`,
      value,
    ])
  ),
});

const parseRange = (
  header: string,
  size: number
): { start: number; end: number } | null => {
  const match = /^bytes=(?<from>\d+)-(?<to>\d*)$/u.exec(header);
  if (!match?.groups) {
    return null;
  }
  const start = Number(match.groups.from);
  const end = match.groups.to
    ? Math.min(Number(match.groups.to), size - 1)
    : size - 1;
  return { end, start };
};

const listResponse = (
  store: Map<string, FakeS3Object>,
  params: URLSearchParams
): Response => {
  const prefix = params.get("prefix") ?? "";
  const delimiter = params.get("delimiter");
  const maxKeys = Number(params.get("max-keys") ?? 1000);
  const token = params.get("continuation-token");
  const matching = [...store.keys()]
    .filter((key) => key.startsWith(prefix))
    .toSorted();
  const contents: string[] = [];
  const prefixes = new Set<string>();
  let truncated = false;
  let nextToken = "";
  for (const key of matching) {
    if (token && key <= token) {
      continue;
    }
    if (delimiter) {
      const rest = key.slice(prefix.length);
      const at = rest.indexOf(delimiter);
      if (at !== -1) {
        prefixes.add(prefix + rest.slice(0, at + delimiter.length));
        continue;
      }
    }
    if (contents.length >= maxKeys) {
      truncated = true;
      break;
    }
    const obj = store.get(key) as FakeS3Object;
    contents.push(
      `<Contents><Key>${escapeXml(key)}</Key><Size>${obj.bytes.byteLength}</Size><ETag>&quot;${obj.etag}&quot;</ETag><LastModified>${new Date(obj.lastModified).toISOString()}</LastModified></Contents>`
    );
    nextToken = key;
  }
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult>`,
    `<IsTruncated>${truncated}</IsTruncated>`,
    truncated
      ? `<NextContinuationToken>${escapeXml(nextToken)}</NextContinuationToken>`
      : "",
    ...contents,
    ...[...prefixes].map(
      (p) => `<CommonPrefixes><Prefix>${escapeXml(p)}</Prefix></CommonPrefixes>`
    ),
    "</ListBucketResult>",
  ].join("");
  return new Response(xml, {
    headers: { "content-type": "application/xml" },
    status: 200,
  });
};

export const makeFakeS3 = (bucket = "uploads"): FakeS3 => {
  const store = new Map<string, FakeS3Object>();
  const requests: Request[] = [];
  let nextEtag = 0;

  const fake: FakeS3 = {
    denyAll: false,
    failNextCopyWith200: false,
    // oxlint-disable-next-line sonarjs/cognitive-complexity -- a flat method+path dispatch table; splitting it hides the request routing this fake exists to model
    fetchImpl: (request: Request): Promise<Response> => {
      requests.push(request);
      const respond = async (): Promise<Response> => {
        if (fake.denyAll) {
          return errorResponse(403, "AccessDenied", "Access Denied");
        }
        const url = new URL(request.url);
        if (
          url.pathname !== `/${bucket}` &&
          !url.pathname.startsWith(`/${bucket}/`)
        ) {
          return errorResponse(404, "NoSuchBucket", "No such bucket");
        }
        const key = decodeURIComponent(
          url.pathname.slice(`/${bucket}/`.length)
        );
        if (request.method === "GET" && url.searchParams.has("list-type")) {
          return listResponse(store, url.searchParams);
        }
        if (request.method === "PUT") {
          const copySource = request.headers.get("x-amz-copy-source");
          if (copySource) {
            if (fake.failNextCopyWith200) {
              fake.failNextCopyWith200 = false;
              return new Response(
                errorXml("InternalError", "Copy failed mid-flight"),
                { status: 200 }
              );
            }
            const sourceKey = decodeURIComponent(
              copySource.replace(`/${bucket}/`, "")
            );
            const source = store.get(sourceKey);
            if (!source) {
              return errorResponse(404, "NoSuchKey", "No such key");
            }
            nextEtag += 1;
            store.set(key, { ...source, etag: `etag-${nextEtag}` });
            return new Response(
              `<CopyObjectResult><ETag>&quot;etag-${nextEtag}&quot;</ETag></CopyObjectResult>`,
              { status: 200 }
            );
          }
          const bytes = new Uint8Array(await request.arrayBuffer());
          const meta: Record<string, string> = {};
          for (const [name, value] of request.headers) {
            if (name.startsWith("x-amz-meta-")) {
              meta[name.slice("x-amz-meta-".length)] = value;
            }
          }
          nextEtag += 1;
          const cacheControl = request.headers.get("cache-control");
          store.set(key, {
            bytes,
            ...(cacheControl && { cacheControl }),
            etag: `etag-${nextEtag}`,
            lastModified: new Date().toUTCString(),
            meta,
            type:
              request.headers.get("content-type") ?? "application/octet-stream",
          });
          return new Response(null, {
            headers: { etag: `"etag-${nextEtag}"` },
            status: 200,
          });
        }
        if (request.method === "DELETE") {
          store.delete(key);
          return new Response(null, { status: 204 });
        }
        // GET / HEAD on an object.
        const obj = store.get(key);
        if (!obj) {
          return request.method === "HEAD"
            ? new Response(null, { status: 404 })
            : errorResponse(404, "NoSuchKey", "No such key");
        }
        if (request.method === "HEAD") {
          return new Response(null, {
            headers: objectHeaders(obj),
            status: 200,
          });
        }
        const rangeHeader = request.headers.get("range");
        if (rangeHeader) {
          const range = parseRange(rangeHeader, obj.bytes.byteLength);
          if (range) {
            const slice = obj.bytes.slice(range.start, range.end + 1);
            return new Response(slice, {
              headers: {
                ...objectHeaders(obj),
                "content-length": String(slice.byteLength),
                "content-range": `bytes ${range.start}-${range.end}/${obj.bytes.byteLength}`,
              },
              status: 206,
            });
          }
        }
        return new Response(new Uint8Array(obj.bytes), {
          headers: objectHeaders(obj),
          status: 200,
        });
      };
      return respond();
    },
    requests,
    seed: (key, text, type = "text/plain") => {
      nextEtag += 1;
      store.set(key, {
        bytes: new TextEncoder().encode(text),
        etag: `etag-${nextEtag}`,
        lastModified: new Date().toUTCString(),
        meta: {},
        type,
      });
    },
    store,
  };
  return fake;
};
