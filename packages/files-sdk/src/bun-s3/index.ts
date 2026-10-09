import type {
  Adapter,
  FileInfo,
  OffsetResumableDriver,
  ResumableUploadSession,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  joinPublicUrl,
  makeErrorMapper,
  rangedSize,
  resolveUrlStrategy,
} from "../internal/core.js";
import { FilesError } from "../internal/errors.js";
import { isObject, isString } from "../internal/is.js";
import { inferTypeFromName } from "../internal/mime.js";
import { createStoredFile } from "../internal/stored-file.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// SigV4 caps a presigned URL at one week. Bun signs a longer `expiresIn`
// without complaint, but the server rejects the URL when it's used, so fail
// here instead, matching the rest of the S3 family.
const SIGV4_MAX_EXPIRES_IN = 604_800;

const expiresInError = (expiresIn: number): FilesError | undefined =>
  expiresIn > SIGV4_MAX_EXPIRES_IN
    ? new FilesError(
        "Invalid",
        `Bun S3 error: presigned URLs must expire within ${SIGV4_MAX_EXPIRES_IN} seconds (7 days), the SigV4 limit; got expiresIn ${expiresIn}.`
      )
    : undefined;

export interface BunS3OperationOptions {
  bucket?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
  virtualHostedStyle?: boolean;
  type?: string;
  contentDisposition?: string;
}

export interface BunS3PresignOptions extends BunS3OperationOptions {
  expiresIn?: number;
  // oxlint-disable-next-line sonarjs/max-union-size -- fixed set of HTTP methods; a literal union is the clearest representation
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
}

export interface BunS3Stats {
  size: number;
  lastModified: Date;
  etag: string;
  type: string;
}

export interface BunS3ListObjectsOptions {
  prefix?: string;
  continuationToken?: string;
  delimiter?: string;
  maxKeys?: number;
  startAfter?: string;
  encodingType?: "url";
  fetchOwner?: boolean;
}

export interface BunS3ListObjectsResponse {
  /** Folder groupings, present only when the request set a `delimiter`. */
  commonPrefixes?: { prefix: string }[];
  contents?: {
    eTag?: string;
    key: string;
    lastModified?: string | Date;
    size?: number;
  }[];
  isTruncated?: boolean;
  nextContinuationToken?: string;
}

export type BunS3WritableBody =
  | string
  | ArrayBuffer
  | ArrayBufferView
  | Blob
  | Request
  | Response;

export interface BunS3FileLike {
  bytes?: () => Promise<Uint8Array>;
  arrayBuffer: () => Promise<ArrayBuffer>;
  stream: () => ReadableStream<Uint8Array>;
  stat: () => Promise<BunS3Stats>;
  /**
   * Bun's `S3File.slice(begin, end)` — `Blob`-style, so `end` is exclusive.
   * Returns a handle that fetches only that byte range when read. Used to
   * honor {@link DownloadOptions.range}.
   */
  slice: (begin?: number, end?: number, contentType?: string) => BunS3FileLike;
}

export interface BunS3ClientLike {
  file: (path: string) => BunS3FileLike;
  write: (
    path: string,
    data: BunS3WritableBody,
    options?: BunS3OperationOptions
  ) => Promise<number>;
  delete: (path: string) => Promise<void>;
  exists: (path: string) => Promise<boolean>;
  stat: (path: string) => Promise<BunS3Stats>;
  list: (
    input?: BunS3ListObjectsOptions | null
  ) => Promise<BunS3ListObjectsResponse>;
  presign: (path: string, options?: BunS3PresignOptions) => string;
}

export interface BunS3AdapterOptions {
  /**
   * A pre-configured `Bun.S3Client`-shaped instance — for example the global
   * `Bun.s3`, or one constructed with specific credentials elsewhere in your
   * app. When set, the adapter uses it as-is and rejects any of `bucket`,
   * `region`, `endpoint`, `virtualHostedStyle`, `accessKeyId`,
   * `secretAccessKey`, `sessionToken` at construction (they would be silently
   * ignored otherwise). When unset, the adapter constructs its own client
   * from the options below.
   */
  client?: BunS3ClientLike;
  /**
   * S3 bucket name. Scopes operations and is exposed as `adapter.bucket`.
   * Falls back to `S3_BUCKET` / `AWS_BUCKET` via Bun's built-in resolution.
   */
  bucket?: string;
  /**
   * AWS region (e.g. `us-east-1`). Falls back to `S3_REGION` / `AWS_REGION`
   * via Bun's resolution.
   */
  region?: string;
  /**
   * Override the S3 service endpoint. Use this to point at S3-compatible
   * services (R2, DigitalOcean Spaces, Wasabi, MinIO, ...).
   */
  endpoint?: string;
  /**
   * Use virtual-hosted-style addressing (`https://<bucket>.<endpoint>`)
   * instead of path-style. Defaults to `false` — flip on for endpoints that
   * require it.
   */
  virtualHostedStyle?: boolean;
  /**
   * Static access key ID. Skip to let Bun resolve it from
   * `S3_ACCESS_KEY_ID` / `AWS_ACCESS_KEY_ID`.
   */
  accessKeyId?: string;
  /**
   * Static secret access key. Skip to let Bun resolve it from
   * `S3_SECRET_ACCESS_KEY` / `AWS_SECRET_ACCESS_KEY`.
   */
  secretAccessKey?: string;
  /**
   * Static session token for temporary credentials. Skip to let Bun resolve
   * it from `S3_SESSION_TOKEN` / `AWS_SESSION_TOKEN`.
   */
  sessionToken?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — use this if your bucket is
   * fronted by a CDN or has a public-read policy. Passing `expiresIn` or
   * `responseContentDisposition` still forces a signed URL even when this is
   * set, because a permanent CDN URL can't expire and has no signature in
   * which to bind the override. When unset, `url()` returns a presigned
   * GetObject (1-hour default).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when no per-call `expiresIn` is given. Defaults to 3600 (1 hour). Per-call
   * `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
}

export type BunS3Adapter = Adapter<BunS3ClientLike> & {
  readonly bucket?: string;
};

/** The fields of a Bun `S3Error` (or an S3-shaped rejection) we classify on. */
interface BunS3ErrorFields {
  $metadata?: { httpStatusCode?: number };
  Code?: string;
  code?: string;
  message?: string;
  status?: number;
  statusCode?: number;
}

export const mapBunS3Error = makeErrorMapper({
  codes: {
    conflict: new Set(["PreconditionFailed"]),
    notFound: new Set(["NoSuchKey", "NotFound"]),
    unauthorized: new Set([
      "AccessDenied",
      "ERR_S3_INVALID_SIGNATURE",
      "ERR_S3_INVALID_SESSION_TOKEN",
      "ERR_S3_MISSING_CREDENTIALS",
    ]),
  },
  extract: (cause) => {
    // SAFETY: every field is read optionally; a thrown value that is not a
    // Bun S3 error (or not even an object) just yields no code/status/message.
    const e = cause as BunS3ErrorFields | null | undefined;
    const code = e?.code ?? e?.Code;
    const status = e?.status ?? e?.statusCode ?? e?.$metadata?.httpStatusCode;
    return {
      ...(code && { code }),
      ...(e?.message && { message: e.message }),
      ...(status !== undefined && { status }),
    };
  },
  providerLabel: "Bun S3 error",
});

const stripEtag = (etag: string | undefined): string | undefined =>
  etag?.replaceAll(/^"+|"+$/gu, "");

const bytesFromFile = async (file: BunS3FileLike): Promise<Uint8Array> =>
  file.bytes ? file.bytes() : new Uint8Array(await file.arrayBuffer());

const infoFromStat = (key: string, stat: BunS3Stats): FileInfo => ({
  contentType: stat.type || DEFAULT_CONTENT_TYPE,
  etag: stripEtag(stat.etag),
  key,
  lastModified: stat.lastModified.getTime(),
  size: stat.size,
});

const storedFromStat = (
  key: string,
  stat: BunS3Stats,
  body:
    | { kind: "buffer"; data: Uint8Array }
    | { kind: "stream"; factory: () => ReadableStream<Uint8Array> }
): StoredFile => createStoredFile(infoFromStat(key, stat), body);

// Bun's `S3Stats` exposes its fields as prototype getters, so `{ ...stat }`
// copies none of them (`lastModified` comes back undefined). Copy each field
// explicitly when overriding the size for a ranged read.
const statWithSize = (stat: BunS3Stats, size: number): BunS3Stats => ({
  etag: stat.etag,
  lastModified: stat.lastModified,
  size,
  type: stat.type,
});

const CLIENT_CONSTRUCTION_OPTS = [
  "bucket",
  "region",
  "endpoint",
  "virtualHostedStyle",
  "accessKeyId",
  "secretAccessKey",
  "sessionToken",
] as const satisfies readonly (keyof BunS3AdapterOptions)[];

export const bunS3 = (opts: BunS3AdapterOptions = {}): BunS3Adapter => {
  if (opts.client) {
    // A caller-provided client already owns its bucket/region/credentials.
    // Accepting these alongside would silently ignore them — and worse, the
    // adapter's `.bucket` accessor would report a value the client doesn't
    // actually use. Reject at construction so the mismatch surfaces immediately.
    const conflicting = CLIENT_CONSTRUCTION_OPTS.filter(
      (key) => opts[key] !== undefined
    );
    if (conflicting.length > 0) {
      throw new FilesError(
        "Invalid",
        `bun-s3 adapter: when \`client\` is provided, the client owns its bucket/region/credentials. Remove these conflicting options: ${conflicting.join(", ")}.`
      );
    }
  }
  const client =
    opts.client ??
    (() => {
      // SAFETY: the `Bun` global exists only under the Bun runtime; reading it
      // as optional is what makes its absence checkable below.
      const bun = (
        globalThis as {
          Bun?: {
            S3Client?: new (options?: BunS3OperationOptions) => BunS3ClientLike;
          };
        }
      ).Bun;
      if (!bun?.S3Client) {
        throw new FilesError(
          "Invalid",
          "bun-s3 adapter: Bun.S3Client is only available in the Bun runtime. Pass `client: Bun.s3` or run under Bun."
        );
      }
      return new bun.S3Client({
        ...(opts.bucket && { bucket: opts.bucket }),
        ...(opts.region && { region: opts.region }),
        ...(opts.endpoint && { endpoint: opts.endpoint }),
        ...(opts.virtualHostedStyle !== undefined && {
          virtualHostedStyle: opts.virtualHostedStyle,
        }),
        ...(opts.accessKeyId && { accessKeyId: opts.accessKeyId }),
        ...(opts.secretAccessKey && { secretAccessKey: opts.secretAccessKey }),
        ...(opts.sessionToken && { sessionToken: opts.sessionToken }),
      });
    })();
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;
  const { publicBaseUrl } = opts;

  // In-flight resumable uploads. Bun's S3 client exposes no multipart
  // upload-id, so chunks are buffered in-process and written in one call at
  // complete — pause/resume works within a process, but a token can't be
  // resumed in a new one (see `adopt`).
  const pending = new Map<string, { chunks: Uint8Array[]; received: number }>();
  let uploadSeq = 0;

  return {
    bucket: opts.bucket,
    // No `cacheControl` / `metadata`: Bun.s3 exposes no API for either, so the
    // Files wrapper rejects both before a call reaches this adapter.
    capabilities: {
      // Bun's list forwards `delimiter` and returns `commonPrefixes`.
      delimiter: "any",
      // No `events`: Bun resolves its endpoint from env vars or a caller's
      // client, so whether this is AWS S3 (S3 notifications) isn't knowable
      // here. Opt in with `events({ format: "s3" })`.
      // A plain `url(key)` returns the permanent `publicBaseUrl` link when one
      // is configured; an explicit `expiresIn` still presigns.
      publicUrl: Boolean(publicBaseUrl),
      rangeRead: true,
      // Bun's S3 client has no CopyObject helper — `copy()` streams
      // source→dest through this process, so it's not a server-side copy.
      serverSideCopy: false,
      // A presigned PUT capped at SigV4's one-week lifetime. Bun signs only
      // the `host` header and exposes no POST policy, so neither `contentType`
      // nor `maxSize` can be enforced — `signedUploadUrl()` throws on both.
      signedUpload: {
        contentType: false,
        maxExpiresIn: SIGV4_MAX_EXPIRES_IN,
        maxSize: false,
        supported: true,
      },
      // `url()` presigns a GET via Bun's S3 client (or `publicBaseUrl`),
      // capped at SigV4's one-week lifetime. Bun's `presign({ contentDisposition })`
      // signs it in as `response-content-disposition`.
      signedUrl: {
        disposition: true,
        expiry: "exact",
        maxExpiresIn: SIGV4_MAX_EXPIRES_IN,
        supported: true,
      },
    },
    /**
     * Client-side stream copy: reads the source through this process and
     * writes it to the destination. Bun's `S3Client` does not expose a
     * server-side `CopyObject` primitive, so unlike the `s3()` adapter
     * (which uses `CopyObjectCommand`) this round-trips bytes through the
     * caller — doubled bandwidth, no atomicity, bounded by your network.
     * Only the source `Content-Type` is preserved; `Content-Disposition`,
     * cache headers, custom user metadata, and ACL are dropped. For
     * server-side copy on the same bucket, reach for the `s3()` adapter.
     */
    async copy(from, to) {
      try {
        const source = client.file(from);
        const stat = await source.stat();
        await client.write(to, new Response(source.stream()), {
          type: stat.type || DEFAULT_CONTENT_TYPE,
        });
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    async delete(key) {
      try {
        await client.delete(key);
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const file = client.file(key);
        const stat = await file.stat();
        const range = downloadOpts?.range;
        // Bun's slice() is Blob-style (exclusive end), so an inclusive
        // ByteRange.end maps to end + 1; the sliced handle issues a ranged GET
        // when read. stat() already happened, so derive the slice length from
        // it rather than a second round trip.
        const sliceEnd = range?.end === undefined ? undefined : range.end + 1;
        const target = range ? file.slice(range.start, sliceEnd) : file;
        if (downloadOpts?.as === "stream") {
          return storedFromStat(
            key,
            range ? statWithSize(stat, rangedSize(stat.size, range)) : stat,
            { factory: () => target.stream(), kind: "stream" }
          );
        }
        const bytes = await bytesFromFile(target);
        return storedFromStat(
          key,
          range ? statWithSize(stat, bytes.byteLength) : stat,
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    async exists(key) {
      try {
        return await client.exists(key);
      } catch (error) {
        const mapped = mapBunS3Error(error);
        if (mapped.code === "NotFound") {
          return false;
        }
        throw mapped;
      }
    },
    async head(key) {
      try {
        return infoFromStat(key, await client.stat(key));
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    async list(options) {
      try {
        const result = await client.list({
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.limit !== undefined && { maxKeys: options.limit }),
          ...(options?.cursor && { continuationToken: options.cursor }),
          ...(options?.delimiter && { delimiter: options.delimiter }),
        });
        const items = (result.contents ?? []).map((obj): FileInfo => {
          const lastModified = obj.lastModified
            ? new Date(obj.lastModified).getTime()
            : undefined;
          return {
            // A list response carries no `Content-Type`, so approximate it
            // from the key like the rest of the S3 family (`s3()`,
            // `s3Fetch()`) instead of labelling every object a binary blob.
            // Unknown extensions still fall back to `DEFAULT_CONTENT_TYPE`.
            contentType: inferTypeFromName(obj.key),
            etag: stripEtag(obj.eTag),
            key: obj.key,
            lastModified:
              lastModified === undefined || Number.isNaN(lastModified)
                ? undefined
                : lastModified,
            size: obj.size ?? 0,
          };
        });
        const prefixes = (result.commonPrefixes ?? []).map((p) => p.prefix);
        return {
          cursor: result.isTruncated ? result.nextContinuationToken : undefined,
          items,
          ...(prefixes.length && { prefixes }),
        };
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    name: "bun-s3",
    raw: client,
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // before a resumable upload reaches here — Bun.s3 exposes neither.
      let uploadId: string | undefined;
      let contentType = DEFAULT_CONTENT_TYPE;
      const requirePending = () => {
        const entry =
          uploadId === undefined ? undefined : pending.get(uploadId);
        if (!entry) {
          throw new FilesError(
            "Unsupported",
            "bun-s3: resumable session not found — bun-s3 uploads are in-process only and can't resume in a new instance."
          );
        }
        return entry;
      };
      return {
        adopt(session: ResumableUploadSession) {
          if (session.provider !== "bun-s3") {
            throw new FilesError(
              "Invalid",
              `Cannot resume a ${session.provider} session on a bun-s3 adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Invalid",
              "Resume token does not match this upload's key."
            );
          }
          ({ uploadId } = session);
          ({ contentType } = session);
        },
        begin(meta): Promise<ResumableUploadSession> {
          uploadSeq += 1;
          uploadId = `bun-${uploadSeq}`;
          ({ contentType } = meta);
          pending.set(uploadId, { chunks: [], received: 0 });
          return Promise.resolve({
            contentType,
            key,
            provider: "bun-s3",
            uploadId,
          });
        },
        async complete(): Promise<UploadResult> {
          const entry = requirePending();
          const bytes = new Uint8Array(entry.received);
          let offset = 0;
          for (const chunk of entry.chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          try {
            await client.write(key, bytes, { type: contentType });
            const stat = await client.stat(key);
            // SAFETY: `requirePending()` above throws unless a session was
            // begun or adopted, which is what sets `uploadId`.
            pending.delete(uploadId as string);
            return {
              contentType: stat.type || contentType,
              etag: stripEtag(stat.etag),
              key,
              lastModified: stat.lastModified.getTime(),
              size: stat.size,
            };
          } catch (error) {
            throw mapBunS3Error(error);
          }
        },
        discard() {
          if (uploadId !== undefined) {
            pending.delete(uploadId);
          }
          return Promise.resolve();
        },
        mode: "offset",
        partSize:
          isObject(resumableOpts.multipart) && resumableOpts.multipart.partSize
            ? resumableOpts.multipart.partSize
            : 8 * 1024 * 1024,
        probe(): Promise<{ nextOffset: number }> {
          return Promise.resolve({ nextOffset: requirePending().received });
        },
        uploadAt({ offset, data }): Promise<{ nextOffset: number }> {
          const entry = requirePending();
          entry.chunks.push(new Uint8Array(data));
          entry.received = offset + data.byteLength;
          return Promise.resolve({ nextOffset: entry.received });
        },
      };
    },
    signedUploadUrl(key, signOpts) {
      if (signOpts.maxSize !== undefined) {
        return Promise.reject(
          new FilesError(
            "Unsupported",
            "bun-s3 adapter: `maxSize` is not supported because Bun.s3 exposes presigned URLs, not S3 POST policy fields."
          )
        );
      }
      // Bun's presign signs only the `host` header. Its `type` option becomes
      // a `response-content-type` query parameter, which binds nothing on an
      // upload, so a presigned PUT can't enforce a Content-Type. Fail loud
      // rather than hand back a header the server never checks.
      if (signOpts.contentType !== undefined) {
        return Promise.reject(
          new FilesError(
            "Unsupported",
            "bun-s3 adapter: `contentType` is not supported because Bun.s3 presigned PUT URLs sign only the host header, so the Content-Type can't be enforced. Omit `contentType`, or use the `s3()` or `s3Fetch()` adapter, which sign it."
          )
        );
      }
      const tooLong = expiresInError(signOpts.expiresIn);
      if (tooLong) {
        return Promise.reject(tooLong);
      }
      try {
        const url = client.presign(key, {
          expiresIn: signOpts.expiresIn,
          method: "PUT",
        });
        return Promise.resolve({ method: "PUT", url });
      } catch (error) {
        return Promise.reject(mapBunS3Error(error));
      }
    },
    async upload(key, body, options) {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — Bun.s3 exposes no API for either.

      let contentType = options?.contentType;
      if (!contentType) {
        contentType = isString(body)
          ? "text/plain; charset=utf-8"
          : DEFAULT_CONTENT_TYPE;
        if (body instanceof Blob && body.type) {
          contentType = body.type;
        }
      }

      try {
        const size = await client.write(
          key,
          body instanceof ReadableStream ? new Response(body) : body,
          { type: contentType }
        );
        try {
          const stat = await client.stat(key);
          return {
            contentType: stat.type || contentType,
            etag: stripEtag(stat.etag),
            key,
            lastModified: stat.lastModified.getTime(),
            size: stat.size,
          };
        } catch {
          return { contentType, key, size };
        }
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    url(key, urlOpts) {
      const strategy = resolveUrlStrategy({
        expiresIn: urlOpts?.expiresIn,
        publicBaseUrl,
        responseContentDisposition: urlOpts?.responseContentDisposition,
      });
      if (strategy === "public" && publicBaseUrl) {
        return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
      }
      const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
      const tooLong = expiresInError(expiresIn);
      if (tooLong) {
        return Promise.reject(tooLong);
      }
      try {
        return Promise.resolve(
          client.presign(key, {
            expiresIn,
            method: "GET",
            ...(urlOpts?.responseContentDisposition && {
              contentDisposition: urlOpts.responseContentDisposition,
            }),
          })
        );
      } catch (error) {
        return Promise.reject(mapBunS3Error(error));
      }
    },
  };
};
