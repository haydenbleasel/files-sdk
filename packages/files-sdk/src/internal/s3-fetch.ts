// A fetch-based S3 protocol client signed with aws4fetch (~2.5 KB gzipped)
// instead of `@aws-sdk/client-s3` (~500 KB+). Built for edge runtimes
// (Cloudflare Workers, Deno Deploy, browsers) where the AWS SDK's bundle
// weight defeats the point of web-standard tooling — see issue #76.
//
// Coverage vs the aws-sdk path: the full required `Adapter` surface plus
// `signedUploadUrl`. Deliberately absent — each needs the S3 multipart/batch
// XML surface or a policy signer this client doesn't carry:
// - `resumableUpload` / `multipart` uploads (CreateMultipartUpload et al.):
//   `upload()` buffers streams and issues a single PUT.
// - `deleteMany` (DeleteObjects needs a Content-MD5 the Web Crypto API can't
//   produce): the SDK's bounded-concurrency `delete()` fan-out applies.
// - presigned POST policies (`signedUploadUrl` with `maxSize` fails closed).

import { AwsClient } from "aws4fetch";

import type {
  Adapter,
  DownloadOptions,
  ListOptions,
  ListResult,
  OperationOptions,
  SignUploadOptions,
  SignedUpload,
  StoredFile,
  UrlOptions,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  collectStream,
  existsByProbe,
  httpRangeHeader,
  isMultipartRequested,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  resolveUrlStrategy,
} from "./core.js";
import { FilesError } from "./errors.js";
import type { StoredFileMeta } from "./stored-file.js";
import { createStoredFile } from "./stored-file.js";

export interface S3FetchAdapterOptions {
  /** Bucket name. All operations are scoped to it. */
  bucket: string;
  /**
   * Service endpoint origin, e.g. `https://ACCOUNT.r2.cloudflarestorage.com`
   * or `https://s3.us-east-1.amazonaws.com`.
   */
  endpoint: string;
  /** SigV4 signing region. Defaults to `us-east-1`; R2 uses `auto`. */
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /**
   * Use path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-hosted style (`https://bucket.endpoint/key`).
   */
  forcePathStyle?: boolean;
  /** See {@link import("../s3/index.js").S3AdapterOptions.publicBaseUrl}. */
  publicBaseUrl?: string;
  /** Default expiry, in seconds, for presigned `url()`s. Defaults to 3600. */
  defaultUrlExpiresIn?: number;
  /** Fallback message for unclassified provider errors, e.g. `"R2 error"`. */
  providerLabel?: string;
  /** Adapter `name` to report, e.g. `"r2-http-fetch"`. */
  name?: string;
  /**
   * Override the `fetch` implementation used for every request — for tests,
   * or runtimes that hand out a bound/instrumented fetch. Defaults to
   * `globalThis.fetch`.
   */
  fetch?: (request: Request) => Promise<Response>;
}

export type S3FetchAdapter = Adapter<AwsClient> & { readonly bucket: string };

const DEFAULT_CONTENT_TYPE = "application/octet-stream";
const METADATA_HEADER_PREFIX = "x-amz-meta-";

const S3_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "NoSuchKey",
  "NotFound",
]);
const S3_UNAUTH_CODES: ReadonlySet<string> = new Set([
  "AccessDenied",
  "InvalidAccessKeyId",
  "SignatureDoesNotMatch",
]);
const S3_CONFLICT_CODES: ReadonlySet<string> = new Set(["PreconditionFailed"]);

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

// S3 XML is flat and predictable, so a handful of literal regexes stand in
// for a real XML parser (which edge runtimes don't ship anyway).
const XML_CODE_RE = /<Code>(?<value>[^<]*)<\/Code>/u;
const XML_MESSAGE_RE = /<Message>(?<value>[^<]*)<\/Message>/u;
const XML_CONTENTS_RE = /<Contents>(?<block>[\s\S]*?)<\/Contents>/gu;
const XML_COMMON_PREFIX_RE =
  /<CommonPrefixes>\s*<Prefix>(?<value>[^<]*)<\/Prefix>\s*<\/CommonPrefixes>/gu;
const XML_KEY_RE = /<Key>(?<value>[^<]*)<\/Key>/u;
const XML_SIZE_RE = /<Size>(?<value>[^<]*)<\/Size>/u;
const XML_ETAG_RE = /<ETag>(?<value>[^<]*)<\/ETag>/u;
const XML_LAST_MODIFIED_RE = /<LastModified>(?<value>[^<]*)<\/LastModified>/u;
const XML_IS_TRUNCATED_RE = /<IsTruncated>true<\/IsTruncated>/u;
const XML_NEXT_TOKEN_RE =
  /<NextContinuationToken>(?<value>[^<]*)<\/NextContinuationToken>/u;
const XML_ERROR_RE = /<Error>/u;
const XML_ENTITY_RE =
  /&(?:amp|lt|gt|quot|apos|#(?<decimal>\d+)|#x(?<hex>[\dA-Fa-f]+));/gu;

const XML_NAMED_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&apos;": "'",
  "&gt;": ">",
  "&lt;": "<",
  "&quot;": '"',
};

/** Decode the XML character entities S3 escapes into list-response text. */
const decodeXmlText = (text: string): string =>
  text.replace(XML_ENTITY_RE, (entity, decimal, hex) => {
    if (decimal) {
      return String.fromCodePoint(Number(decimal));
    }
    if (hex) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }
    return XML_NAMED_ENTITIES[entity] ?? entity;
  });

const parseTimestamp = (value: string | null): number | undefined => {
  if (!value) {
    return;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * Read a response body as text, tolerating unreadable bodies. Also serves as
 * the polite drain for bodies we don't need — leaving them unread can hold
 * the connection open on some runtimes.
 */
const drainText = async (res: Response): Promise<string> => {
  try {
    return await res.text();
  } catch {
    return "";
  }
};

const encodeKey = (key: string): string =>
  key.split("/").map(encodeURIComponent).join("/");

interface ListEntry {
  key: string;
  size: number;
  etag?: string;
  lastModified?: number;
}

/** Pull one object's fields out of a ListObjectsV2 `<Contents>` block. */
const parseListEntry = (block: string): ListEntry | null => {
  const rawKey = XML_KEY_RE.exec(block)?.groups?.value;
  if (rawKey === undefined) {
    return null;
  }
  const etag = stripEtag(
    decodeXmlText(XML_ETAG_RE.exec(block)?.groups?.value ?? "")
  );
  const lastModified = parseTimestamp(
    XML_LAST_MODIFIED_RE.exec(block)?.groups?.value ?? null
  );
  return {
    key: decodeXmlText(rawKey),
    size: Number(XML_SIZE_RE.exec(block)?.groups?.value ?? 0),
    ...(etag && { etag }),
    ...(lastModified !== undefined && { lastModified }),
  };
};

/** Build the signed ListObjectsV2 request URL for a page. */
const listQueryUrl = (baseUrl: string, listOpts?: ListOptions): string => {
  // Path-style resolves to `/bucket`, virtual-hosted to `/` — both the
  // canonical ListObjectsV2 request paths for their addressing style.
  const url = new URL(baseUrl);
  url.searchParams.set("list-type", "2");
  if (listOpts?.prefix) {
    url.searchParams.set("prefix", listOpts.prefix);
  }
  if (listOpts?.limit !== undefined) {
    url.searchParams.set("max-keys", String(listOpts.limit));
  }
  if (listOpts?.cursor) {
    url.searchParams.set("continuation-token", listOpts.cursor);
  }
  if (listOpts?.delimiter) {
    url.searchParams.set("delimiter", listOpts.delimiter);
  }
  return url.toString();
};

// oxlint-disable-next-line sonarjs/cognitive-complexity -- a linear sequence of small per-op closures over one shared signer; splitting them apart would separate each op from the config it closes over
export const s3FetchAdapter = (opts: S3FetchAdapterOptions): S3FetchAdapter => {
  const { bucket } = opts;
  const providerLabel = opts.providerLabel ?? "S3 error";
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;
  const { publicBaseUrl } = opts;
  const fetchImpl =
    opts.fetch ?? ((request: Request) => globalThis.fetch(request));

  const client = new AwsClient({
    accessKeyId: opts.accessKeyId,
    region: opts.region ?? "us-east-1",
    // Retries belong to the SDK's own `retries` operation option — a second
    // layer here would multiply attempts and stretch failure latency.
    retries: 0,
    secretAccessKey: opts.secretAccessKey,
    service: "s3",
    ...(opts.sessionToken && { sessionToken: opts.sessionToken }),
  });

  const endpointUrl = new URL(opts.endpoint);
  const baseUrl = opts.forcePathStyle
    ? `${endpointUrl.origin}/${encodeURIComponent(bucket)}`
    : `${endpointUrl.protocol}//${bucket}.${endpointUrl.host}`;

  const objectUrl = (key: string): string => `${baseUrl}/${encodeKey(key)}`;

  const mapError = makeErrorMapper({
    codes: {
      conflict: S3_CONFLICT_CODES,
      notFound: S3_NOT_FOUND_CODES,
      unauthorized: S3_UNAUTH_CODES,
    },
    extract: (err) =>
      err as { code?: string; status?: number; message?: string },
    providerLabel,
  });

  const errorFromXml = (xml: string, status: number): FilesError => {
    const code = XML_CODE_RE.exec(xml)?.groups?.value;
    const message = XML_MESSAGE_RE.exec(xml)?.groups?.value;
    return mapError({
      ...(code && { code: decodeXmlText(code) }),
      ...(message && { message: decodeXmlText(message) }),
      status,
    });
  };

  const errorFromResponse = async (res: Response): Promise<FilesError> =>
    errorFromXml(await drainText(res), res.status);

  const send = async (
    method: string,
    url: string,
    init: {
      body?: Uint8Array;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    } = {}
  ): Promise<Response> => {
    try {
      const request = await client.sign(url, {
        method,
        ...(init.body !== undefined && { body: init.body as BodyInit }),
        ...(init.headers && { headers: init.headers }),
        ...(init.signal && { signal: init.signal }),
      });
      return await fetchImpl(request);
    } catch (error) {
      throw mapError(error);
    }
  };

  /** Signed GET returning the object's bytes — the lazy-body factory. */
  const fetchBytes = async (key: string): Promise<Uint8Array> => {
    const res = await send("GET", objectUrl(key));
    if (!res.ok) {
      throw await errorFromResponse(res);
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  const headResponse = async (
    key: string,
    operationOpts?: OperationOptions
  ): Promise<Response> => {
    const res = await send("HEAD", objectUrl(key), {
      ...(operationOpts?.signal && { signal: operationOpts.signal }),
    });
    if (!res.ok) {
      // A HEAD response has no body to read an error code from — the HTTP
      // status alone drives classification (404 → NotFound, 403 → Unauthorized).
      throw errorFromXml("", res.status);
    }
    return res;
  };

  const responseMeta = (key: string, headers: Headers): StoredFileMeta => {
    let metadata: Record<string, string> | undefined;
    for (const [name, value] of headers) {
      if (name.startsWith(METADATA_HEADER_PREFIX)) {
        metadata ??= {};
        metadata[name.slice(METADATA_HEADER_PREFIX.length)] = value;
      }
    }
    const etag = stripEtag(headers.get("etag") ?? undefined);
    const lastModified = parseTimestamp(headers.get("last-modified"));
    return {
      key,
      size: Number(headers.get("content-length") ?? 0),
      type: headers.get("content-type") ?? DEFAULT_CONTENT_TYPE,
      ...(etag && { etag }),
      ...(lastModified !== undefined && { lastModified }),
      ...(metadata && { metadata }),
    };
  };

  const presign = async (
    method: string,
    key: string,
    expiresIn: number,
    extras: {
      query?: Record<string, string>;
      headers?: Record<string, string>;
    } = {}
  ): Promise<string> => {
    const url = new URL(objectUrl(key));
    url.searchParams.set("X-Amz-Expires", String(expiresIn));
    for (const [name, value] of Object.entries(extras.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const request = await client.sign(url.toString(), {
      method,
      ...(extras.headers && { headers: extras.headers }),
      // `allHeaders` opts `content-type` into the signed-header set (aws4fetch
      // skips it by default), which is what makes a presigned PUT actually
      // *enforce* the content type rather than merely suggest it.
      aws: { allHeaders: true, signQuery: true },
    });
    return request.url;
  };

  return {
    bucket,
    async copy(from, to, operationOpts) {
      const res = await send("PUT", objectUrl(to), {
        headers: {
          // CopySource must be URL-encoded, mirroring the s3 adapter.
          "x-amz-copy-source": `/${encodeURIComponent(bucket)}/${encodeKey(from)}`,
        },
        ...(operationOpts?.signal && { signal: operationOpts.signal }),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      // CopyObject can fail *after* returning 200 — S3 streams whitespace
      // while copying and reports late failures as an <Error> body. Always
      // read the body and check.
      const xml = await drainText(res);
      if (XML_ERROR_RE.test(xml)) {
        throw errorFromXml(xml, res.status);
      }
    },
    async delete(key, operationOpts) {
      const res = await send("DELETE", objectUrl(key), {
        ...(operationOpts?.signal && { signal: operationOpts.signal }),
      });
      // S3 DeleteObject is idempotent: a missing key still returns 204.
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      await drainText(res);
    },
    async download(key, downloadOpts?: DownloadOptions) {
      const res = await send("GET", objectUrl(key), {
        ...(downloadOpts?.range && {
          headers: { Range: httpRangeHeader(downloadOpts.range) },
        }),
        ...(downloadOpts?.signal && { signal: downloadOpts.signal }),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      const meta = responseMeta(key, res.headers);
      if (downloadOpts?.as === "stream") {
        const stream = res.body;
        // A 200/206 always carries a body; the null branch is type-narrowing
        // for runtimes that model bodyless responses.
        return createStoredFile(
          meta,
          stream
            ? { factory: () => stream, kind: "stream" }
            : { data: new Uint8Array(), kind: "buffer" }
        );
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      // Prefer the real byte length over Content-Length so the size surfaced
      // always matches the bytes the caller can read.
      return createStoredFile(
        { ...meta, size: bytes.byteLength },
        { data: bytes, kind: "buffer" }
      );
    },
    exists(key, operationOpts) {
      return existsByProbe(() => headResponse(key, operationOpts), mapError);
    },
    async head(key, operationOpts) {
      const res = await headResponse(key, operationOpts);
      return createStoredFile(responseMeta(key, res.headers), {
        factory: () => fetchBytes(key),
        kind: "lazy",
      });
    },
    async list(listOpts?: ListOptions): Promise<ListResult> {
      const res = await send("GET", listQueryUrl(baseUrl, listOpts), {
        ...(listOpts?.signal && { signal: listOpts.signal }),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      const xml = await res.text();
      const items: StoredFile[] = [];
      for (const match of xml.matchAll(XML_CONTENTS_RE)) {
        const entry = parseListEntry(match.groups?.block ?? "");
        if (!entry) {
          continue;
        }
        items.push(
          createStoredFile(
            { ...entry, type: DEFAULT_CONTENT_TYPE },
            { factory: () => fetchBytes(entry.key), kind: "lazy" }
          )
        );
      }
      const prefixes = [...xml.matchAll(XML_COMMON_PREFIX_RE)].map((match) =>
        decodeXmlText(match.groups?.value ?? "")
      );
      const nextToken = XML_NEXT_TOKEN_RE.exec(xml)?.groups?.value;
      return {
        cursor:
          XML_IS_TRUNCATED_RE.test(xml) && nextToken
            ? decodeXmlText(nextToken)
            : undefined,
        items,
        ...(prefixes.length && { prefixes }),
      };
    },
    name: opts.name ?? "s3-fetch",
    raw: client,
    async signedUploadUrl(key, signOpts: SignUploadOptions) {
      if (signOpts.maxSize !== undefined) {
        // `permanent`: enforcing maxSize needs a presigned POST policy, which
        // this client deliberately doesn't implement — retrying can't help.
        throw new FilesError(
          "Provider",
          `${providerLabel}: \`maxSize\` requires a presigned POST policy, which the fetch client does not implement. Use the aws-sdk client, or enforce the limit at your application gateway before issuing the URL.`,
          undefined,
          { permanent: true }
        );
      }
      const url = await presign("PUT", key, signOpts.expiresIn, {
        ...(signOpts.contentType && {
          headers: { "content-type": signOpts.contentType },
        }),
      });
      return {
        headers: signOpts.contentType
          ? { "Content-Type": signOpts.contentType }
          : undefined,
        method: "PUT",
        url,
      } satisfies SignedUpload;
    },
    signedUrl: { supported: true },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsRange: true,
    // `copy()` issues a CopyObject — server-side, no body round-trip.
    supportsServerSideCopy: true,
    async upload(key, body, uploadOpts) {
      if (isMultipartRequested(uploadOpts?.multipart)) {
        // `permanent`: fail loudly instead of silently buffering what the
        // caller asked to chunk — a single PUT caps at 5 GB and buffering a
        // body that size is exactly what multipart exists to avoid.
        throw new FilesError(
          "Provider",
          `${providerLabel}: multipart uploads are not supported by the fetch client. Use the aws-sdk client for multipart and resumable uploads.`,
          undefined,
          { permanent: true }
        );
      }
      const { data, contentType } = await normalizeBody(
        body,
        uploadOpts?.contentType
      );
      // Streams are buffered: a single SigV4 PUT needs a Content-Length up
      // front, and the multipart API this would otherwise chunk through is
      // aws-sdk-client territory.
      const bytes =
        data instanceof ReadableStream ? await collectStream(data) : data;
      const metadataHeaders = Object.fromEntries(
        Object.entries(uploadOpts?.metadata ?? {}).map(([name, value]) => [
          `${METADATA_HEADER_PREFIX}${name}`,
          value,
        ])
      );
      const res = await send("PUT", objectUrl(key), {
        body: bytes,
        headers: {
          "content-type": contentType,
          ...(uploadOpts?.cacheControl && {
            "cache-control": uploadOpts.cacheControl,
          }),
          ...metadataHeaders,
        },
        ...(uploadOpts?.signal && { signal: uploadOpts.signal }),
      });
      if (!res.ok) {
        throw await errorFromResponse(res);
      }
      await drainText(res);
      const etag = stripEtag(res.headers.get("etag") ?? undefined);
      return {
        contentType,
        key,
        size: bytes.byteLength,
        ...(etag && { etag }),
      };
    },
    url(key, urlOpts?: UrlOptions): Promise<string> {
      const strategy = resolveUrlStrategy({
        publicBaseUrl,
        ...(urlOpts?.responseContentDisposition && {
          responseContentDisposition: urlOpts.responseContentDisposition,
        }),
      });
      if (strategy === "public" && publicBaseUrl) {
        return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
      }
      return presign("GET", key, urlOpts?.expiresIn ?? defaultUrlExpiresIn, {
        ...(urlOpts?.responseContentDisposition && {
          query: {
            "response-content-disposition": urlOpts.responseContentDisposition,
          },
        }),
      });
    },
  };
};
