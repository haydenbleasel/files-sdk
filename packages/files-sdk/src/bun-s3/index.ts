import type {
  Adapter,
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
import { createStoredFile } from "../internal/stored-file.js";

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
  bytes?(): Promise<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  stream(): ReadableStream<Uint8Array>;
  stat(): Promise<BunS3Stats>;
  /**
   * Bun's `S3File.slice(begin, end)` — `Blob`-style, so `end` is exclusive.
   * Returns a handle that fetches only that byte range when read. Used to
   * honor {@link DownloadOptions.range}.
   */
  slice(begin?: number, end?: number, contentType?: string): BunS3FileLike;
}

export interface BunS3ClientLike {
  file(path: string): BunS3FileLike;
  write(
    path: string,
    data: BunS3WritableBody,
    options?: BunS3OperationOptions
  ): Promise<number>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<BunS3Stats>;
  list(
    input?: BunS3ListObjectsOptions | null
  ): Promise<BunS3ListObjectsResponse>;
  presign(path: string, options?: BunS3PresignOptions): string;
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
   * fronted by a CDN or has a public-read policy. Passing
   * `responseContentDisposition` still forces a signed URL even when this is
   * set, because a permanent CDN URL has no signature in which to bind the
   * override. When unset, `url()` returns a presigned GetObject (1-hour
   * default).
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by `url()`
   * when `publicBaseUrl` isn't set. Defaults to 3600 (1 hour). Per-call
   * `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
}

export type BunS3Adapter = Adapter<BunS3ClientLike> & {
  readonly bucket?: string;
};

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
  extract: (err) => {
    const e = err as {
      code?: string;
      Code?: string;
      status?: number;
      statusCode?: number;
      $metadata?: { httpStatusCode?: number };
      message?: string;
    };
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

const storedFromStat = (
  key: string,
  stat: BunS3Stats,
  body:
    | { kind: "buffer"; data: Uint8Array }
    | { kind: "lazy"; factory: () => Promise<Uint8Array> }
    | { kind: "stream"; factory: () => ReadableStream<Uint8Array> }
): StoredFile =>
  createStoredFile(
    {
      etag: stripEtag(stat.etag),
      key,
      lastModified: stat.lastModified.getTime(),
      size: stat.size,
      type: stat.type || "application/octet-stream",
    },
    body
  );

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
        "Provider",
        `bun-s3 adapter: when \`client\` is provided, the client owns its bucket/region/credentials. Remove these conflicting options: ${conflicting.join(", ")}.`
      );
    }
  }
  const client =
    opts.client ??
    (() => {
      const bun = (
        globalThis as unknown as {
          Bun?: {
            S3Client?: new (options?: BunS3OperationOptions) => BunS3ClientLike;
          };
        }
      ).Bun;
      if (!bun?.S3Client) {
        throw new FilesError(
          "Provider",
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
          type: stat.type || "application/octet-stream",
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
        const target = range
          ? file.slice(
              range.start,
              range.end === undefined ? undefined : range.end + 1
            )
          : file;
        if (downloadOpts?.as === "stream") {
          return storedFromStat(
            key,
            range ? { ...stat, size: rangedSize(stat.size, range) } : stat,
            { factory: () => target.stream(), kind: "stream" }
          );
        }
        const bytes = await bytesFromFile(target);
        return storedFromStat(
          key,
          range ? { ...stat, size: bytes.byteLength } : stat,
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
        return storedFromStat(key, await client.stat(key), {
          factory: () => bytesFromFile(client.file(key)),
          kind: "lazy",
        });
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
        });
        const items = (result.contents ?? []).map((obj) => {
          const lastModified = obj.lastModified
            ? new Date(obj.lastModified).getTime()
            : undefined;
          return createStoredFile(
            {
              etag: stripEtag(obj.eTag),
              key: obj.key,
              lastModified:
                lastModified === undefined || Number.isNaN(lastModified)
                  ? undefined
                  : lastModified,
              size: obj.size ?? 0,
              type: "application/octet-stream",
            },
            {
              factory: () => bytesFromFile(client.file(obj.key)),
              kind: "lazy",
            }
          );
        });
        return {
          cursor: result.isTruncated ? result.nextContinuationToken : undefined,
          items,
        };
      } catch (error) {
        throw mapBunS3Error(error);
      }
    },
    name: "bun-s3",
    raw: client,
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      if (resumableOpts.cacheControl) {
        throw new FilesError(
          "Provider",
          "bun-s3 adapter: `cacheControl` is not supported by Bun.s3."
        );
      }
      if (resumableOpts.metadata) {
        throw new FilesError(
          "Provider",
          "bun-s3 adapter: `metadata` is not supported by Bun.s3."
        );
      }
      let uploadId: string | undefined;
      let contentType = "application/octet-stream";
      const requirePending = () => {
        const entry =
          uploadId === undefined ? undefined : pending.get(uploadId);
        if (!entry) {
          throw new FilesError(
            "Provider",
            "bun-s3: resumable session not found — bun-s3 uploads are in-process only and can't resume in a new instance."
          );
        }
        return entry;
      };
      return {
        adopt(session: ResumableUploadSession) {
          if (session.provider !== "bun-s3") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${session.provider} session on a bun-s3 adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Provider",
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
          typeof resumableOpts.multipart === "object" &&
          resumableOpts.multipart.partSize
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
            "Provider",
            "bun-s3 adapter: `maxSize` is not supported because Bun.s3 exposes presigned URLs, not S3 POST policy fields."
          )
        );
      }
      try {
        const url = client.presign(key, {
          expiresIn: signOpts.expiresIn,
          method: "PUT",
          ...(signOpts.contentType && { type: signOpts.contentType }),
        });
        return Promise.resolve({
          headers: signOpts.contentType
            ? { "Content-Type": signOpts.contentType }
            : undefined,
          method: "PUT",
          url,
        });
      } catch (error) {
        return Promise.reject(mapBunS3Error(error));
      }
    },
    supportsRange: true,
    async upload(key, body, options) {
      if (options?.cacheControl) {
        throw new FilesError(
          "Provider",
          "bun-s3 adapter: `cacheControl` is not supported by Bun.s3. Use `raw` if Bun adds this option."
        );
      }
      if (options?.metadata) {
        throw new FilesError(
          "Provider",
          "bun-s3 adapter: `metadata` is not supported by Bun.s3. Use `raw` if Bun adds this option."
        );
      }

      let contentType = options?.contentType;
      if (!contentType) {
        contentType =
          typeof body === "string"
            ? "text/plain; charset=utf-8"
            : "application/octet-stream";
        if (body instanceof Blob && body.type) {
          contentType = body.type;
        }
      }

      try {
        const size = await client.write(
          key,
          body instanceof ReadableStream
            ? new Response(body)
            : (body as BunS3WritableBody),
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
        publicBaseUrl,
        responseContentDisposition: urlOpts?.responseContentDisposition,
      });
      if (strategy === "public" && publicBaseUrl) {
        return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
      }
      try {
        return Promise.resolve(
          client.presign(key, {
            expiresIn: urlOpts?.expiresIn ?? defaultUrlExpiresIn,
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
