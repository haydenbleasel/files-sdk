import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type {
  Adapter,
  DeleteManyOptions,
  DeleteManyResult,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  resolveUrlStrategy,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface S3AdapterOptions {
  /** S3 bucket name. The adapter scopes all operations to it. */
  bucket: string;
  /**
   * AWS region the bucket lives in (e.g. `us-east-1`). Falls back to
   * `AWS_REGION`; required if no env var is set.
   */
  region?: string;
  /**
   * Override the S3 service endpoint. Use this to point at S3-compatible
   * services (DigitalOcean Spaces, Wasabi, Backblaze B2, LocalStack, etc.).
   */
  endpoint?: string;
  /**
   * Use path-style addressing (`https://endpoint/bucket/key`) instead of
   * virtual-hosted style (`https://bucket.endpoint/key`). Required by some
   * S3-compatible services and by LocalStack.
   */
  forcePathStyle?: boolean;
  /**
   * Static credentials. Skip to use the AWS credential chain (env vars,
   * IAM role, shared profile, EC2/ECS/EKS instance metadata).
   */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — appropriate for buckets
   * fronted by a CDN, public-read policy, or custom domain. When unset,
   * `url()` falls back to a presigned `GetObject` URL (see
   * {@link defaultUrlExpiresIn}).
   *
   * The base is concatenated as-is. Trailing slashes are tolerated. Keys
   * are embedded literally — caller is responsible for URL-encoding
   * untrusted segments.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the presigned URLs returned by
   * `url()` when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   * Per-call `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
  /**
   * Override the fallback message used when an unknown error has no
   * `message` of its own. Internal — set by the r2-http adapter so its
   * users see "R2 error" instead of "S3 error".
   * @internal
   */
  defaultProviderMessage?: string;
}

export type S3Adapter = Adapter<S3Client> & {
  readonly bucket: string;
};

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

// `@aws-sdk/lib-storage` is an optional peer dependency, pulled in only when an
// upload requests progress. Loaded lazily (the return type is inferred from the
// dynamic import) so it isn't required by callers who never pass `onProgress`;
// surfaces a clear error when it's missing.
const loadLibStorage = async () => {
  try {
    return await import("@aws-sdk/lib-storage");
  } catch {
    throw new FilesError(
      "Provider",
      "Upload progress on S3 requires the optional peer dependency '@aws-sdk/lib-storage'. Install it to use the onProgress option."
    );
  }
};

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

const S3_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "NoSuchKey",
  "NotFound",
]);
const S3_UNAUTH_CODES: ReadonlySet<string> = new Set(["AccessDenied"]);
const S3_CONFLICT_CODES: ReadonlySet<string> = new Set(["PreconditionFailed"]);
// `DeleteObjects` rejects requests with more than 1000 keys, so the bulk path
// has to chunk longer key lists into separate requests.
const S3_DELETE_BATCH_LIMIT = 1000;

const extractS3Error = (
  err: unknown
): { code?: string; status?: number; message?: string } => {
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
    message?: string;
  };
  return {
    ...((e?.name ?? e?.Code) ? { code: e?.name ?? e?.Code } : {}),
    ...(e?.message && { message: e.message }),
    ...(e?.$metadata?.httpStatusCode !== undefined && {
      status: e.$metadata.httpStatusCode,
    }),
  };
};

const buildMapS3Error = (providerLabel = "S3 error") =>
  makeErrorMapper({
    codes: {
      conflict: S3_CONFLICT_CODES,
      notFound: S3_NOT_FOUND_CODES,
      unauthorized: S3_UNAUTH_CODES,
    },
    extract: extractS3Error,
    providerLabel,
  });

const _defaultMapS3Error = buildMapS3Error();

/**
 * Map an `@aws-sdk/client-s3` error (or any thrown value with the same
 * shape) to a {@link FilesError}. The optional `messages` argument
 * overrides the per-code fallback strings — used by the S3-compatible
 * wrappers (R2 HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai)
 * so their unknown-error messages read with the right provider name.
 */
export const mapS3Error = (
  err: unknown,
  messages?: Record<FilesErrorCode, string>
): FilesError => {
  if (!messages) {
    return _defaultMapS3Error(err);
  }
  if (err instanceof FilesError) {
    return err;
  }
  // 2-arg form: the caller has provided a full per-code fallback table.
  // Re-derive code/status, then prefer the original error's own message
  // (so server-side reasons surface) and fall back to the caller's table.
  const e = err as { name?: string; Code?: string; message?: string };
  const wrapped = _defaultMapS3Error({
    ...(typeof err === "object" && err ? err : {}),
    message: undefined,
  });
  return new FilesError(
    wrapped.code,
    e?.message ?? messages[wrapped.code],
    err
  );
};

export const s3 = (opts: S3AdapterOptions): S3Adapter => {
  const region =
    opts.region ?? readEnv("AWS_REGION") ?? readEnv("AWS_DEFAULT_REGION");
  if (!region) {
    throw new FilesError(
      "Provider",
      "s3 adapter: missing region. Pass `region` or set AWS_REGION."
    );
  }

  const config: S3ClientConfig = {
    region,
    ...(opts.endpoint && { endpoint: opts.endpoint }),
    ...(opts.forcePathStyle !== undefined && {
      forcePathStyle: opts.forcePathStyle,
    }),
    ...(opts.credentials && { credentials: opts.credentials }),
  };

  const client = new S3Client(config);
  const { bucket } = opts;
  const { publicBaseUrl } = opts;
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;
  const wrapErr = opts.defaultProviderMessage
    ? buildMapS3Error(opts.defaultProviderMessage)
    : mapS3Error;

  const signGet = (
    key: string,
    expiresIn: number,
    responseContentDisposition?: string
  ): Promise<string> =>
    getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(responseContentDisposition && {
          ResponseContentDisposition: responseContentDisposition,
        }),
      }),
      { expiresIn }
    );

  return {
    bucket,
    async copy(from, to, operationOpts) {
      try {
        // CopySource must be URL-encoded per
        // https://docs.aws.amazon.com/AmazonS3/latest/API/API_CopyObject.html.
        // S3 bucket naming rules don't require encoding in practice, but we
        // encode both halves defensively in case a custom endpoint (e.g.
        // MinIO) accepts looser names. `Key:` is passed unencoded — the SDK
        // signs and serializes it as part of the request, not as a URL value.
        await client.send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${encodeURIComponent(bucket)}/${encodeURIComponent(from)}`,
            Key: to,
          }),
          operationOpts?.signal
            ? { abortSignal: operationOpts.signal }
            : undefined
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async delete(key, operationOpts) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
          operationOpts?.signal
            ? { abortSignal: operationOpts.signal }
            : undefined
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async deleteMany(
      keys: string[],
      deleteOpts?: DeleteManyOptions
    ): Promise<DeleteManyResult> {
      if (keys.length === 0) {
        return { deleted: [] };
      }
      if (deleteOpts?.stopOnError) {
        const deleted: string[] = [];
        const errors: NonNullable<DeleteManyResult["errors"]> = [];
        for (const key of keys) {
          try {
            await client.send(
              new DeleteObjectCommand({ Bucket: bucket, Key: key })
            );
            deleted.push(key);
          } catch (error) {
            errors.push({ error: wrapErr(error), key });
            return { deleted, errors };
          }
        }
        return { deleted };
      }
      const deletedKeys = new Set<string>();
      const errors: NonNullable<DeleteManyResult["errors"]> = [];
      // `DeleteObjects` caps each request at 1000 keys; send in chunks and
      // merge the per-key results so callers see one combined result.
      for (let start = 0; start < keys.length; start += S3_DELETE_BATCH_LIMIT) {
        const batch = keys.slice(start, start + S3_DELETE_BATCH_LIMIT);
        try {
          const result = await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((key) => ({ Key: key })) },
            })
          );
          for (const item of result.Deleted ?? []) {
            if (item.Key !== undefined) {
              deletedKeys.add(item.Key);
            }
          }
          for (const item of result.Errors ?? []) {
            errors.push({
              error: wrapErr({
                Code: item.Code,
                message: item.Message ?? item.Code ?? "Delete failed",
                name: item.Code,
              }),
              key: item.Key ?? "",
            });
          }
        } catch (error) {
          // The whole batch failed — S3 doesn't tell us which keys, so map
          // the error onto every key in this batch and keep going.
          const mapped = wrapErr(error);
          for (const key of batch) {
            errors.push({ error: mapped, key });
          }
        }
      }
      const deleted = keys.filter((key) => deletedKeys.has(key));
      if (errors.length === 0) {
        return { deleted };
      }
      return { deleted, errors };
    },
    async download(key, downloadOpts) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          downloadOpts?.signal
            ? { abortSignal: downloadOpts.signal }
            : undefined
        );
        const baseMeta = {
          etag: stripEtag(result.ETag),
          key,
          lastModified: result.LastModified?.getTime(),
          metadata: result.Metadata,
          type: result.ContentType ?? "application/octet-stream",
        };
        if (downloadOpts?.as === "stream") {
          const stream = result.Body?.transformToWebStream();
          // Stream path: we trust S3's ContentLength header. Falls back to 0
          // only if the header is missing, which is rare in practice.
          return createStoredFile(
            { ...baseMeta, size: Number(result.ContentLength ?? 0) },
            {
              factory: () => stream ?? emptyStream(),
              kind: "stream",
            }
          );
        }
        const bytes =
          (await result.Body?.transformToByteArray()) ?? new Uint8Array();
        // Buffer path: prefer the real byte length over ContentLength so the
        // size we surface always matches the bytes the caller can actually read.
        return createStoredFile(
          { ...baseMeta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    exists(key, operationOpts) {
      return existsByProbe(
        () =>
          client.send(
            new HeadObjectCommand({ Bucket: bucket, Key: key }),
            operationOpts?.signal
              ? { abortSignal: operationOpts.signal }
              : undefined
          ),
        wrapErr
      );
    },
    async head(key, operationOpts) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
          operationOpts?.signal
            ? { abortSignal: operationOpts.signal }
            : undefined
        );
        return createStoredFile(
          {
            etag: stripEtag(result.ETag),
            key,
            lastModified: result.LastModified?.getTime(),
            metadata: result.Metadata,
            size: Number(result.ContentLength ?? 0),
            type: result.ContentType ?? "application/octet-stream",
          },
          {
            factory: async () => {
              const get = await client.send(
                new GetObjectCommand({ Bucket: bucket, Key: key })
              );
              return (
                (await get.Body?.transformToByteArray()) ?? new Uint8Array()
              );
            },
            kind: "lazy",
          }
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async list(options) {
      try {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            ...(options?.prefix && { Prefix: options.prefix }),
            ...(options?.limit !== undefined && { MaxKeys: options.limit }),
            ...(options?.cursor && { ContinuationToken: options.cursor }),
          }),
          options?.signal ? { abortSignal: options.signal } : undefined
        );
        const items: StoredFile[] = (result.Contents ?? []).map((obj) => {
          const objKey = obj.Key ?? "";
          return createStoredFile(
            {
              etag: stripEtag(obj.ETag),
              key: objKey,
              lastModified: obj.LastModified?.getTime(),
              size: Number(obj.Size ?? 0),
              type: "application/octet-stream",
            },
            {
              factory: async () => {
                const get = await client.send(
                  new GetObjectCommand({ Bucket: bucket, Key: objKey })
                );
                return (
                  (await get.Body?.transformToByteArray()) ?? new Uint8Array()
                );
              },
              kind: "lazy",
            }
          );
        });
        return {
          cursor: result.IsTruncated ? result.NextContinuationToken : undefined,
          items,
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    name: "s3",
    raw: client,
    reportsUploadProgress: true,
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      try {
        if (signOpts.maxSize !== undefined) {
          const minSize = signOpts.minSize ?? 1;
          const conditions: (
            | [string, ...unknown[]]
            | Record<string, string>
          )[] = [["content-length-range", minSize, signOpts.maxSize]];
          if (signOpts.contentType) {
            conditions.push(["eq", "$Content-Type", signOpts.contentType]);
          }
          const post = await createPresignedPost(client, {
            Bucket: bucket,
            Conditions: conditions as Parameters<
              typeof createPresignedPost
            >[1]["Conditions"],
            Expires: signOpts.expiresIn,
            Key: key,
            ...(signOpts.contentType && {
              Fields: { "Content-Type": signOpts.contentType },
            }),
          });
          return { fields: post.fields, method: "POST", url: post.url };
        }
        const url = await getSignedUrl(
          client,
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(signOpts.contentType && { ContentType: signOpts.contentType }),
          }),
          { expiresIn: signOpts.expiresIn }
        );
        return {
          headers: signOpts.contentType
            ? { "Content-Type": signOpts.contentType }
            : undefined,
          method: "PUT",
          url,
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async upload(key, body, options) {
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const params = {
        Body: data,
        Bucket: bucket,
        ContentType: contentType,
        Key: key,
        ...(options?.cacheControl && { CacheControl: options.cacheControl }),
        ...(options?.metadata && { Metadata: options.metadata }),
        ...(contentLength !== undefined && { ContentLength: contentLength }),
      };
      try {
        let etag: string | undefined;
        if (options?.onProgress) {
          // lib-storage's Upload exposes per-byte progress (and transparently
          // switches to multipart for large bodies). Imported lazily so the
          // dependency is only required when progress is actually requested.
          const { Upload } = await loadLibStorage();
          const report = options.onProgress;
          const upload = new Upload({ client, params });
          upload.on("httpUploadProgress", (progress) => {
            report({
              loaded: progress.loaded ?? 0,
              ...(progress.total !== undefined && { total: progress.total }),
            });
          });
          // The Upload runs its own requests, so wire the abort signal to its
          // abort() rather than relying on a per-command abortSignal.
          options.signal?.addEventListener("abort", () => void upload.abort(), {
            once: true,
          });
          const result = await upload.done();
          etag = stripEtag(result.ETag);
        } else {
          const result = await client.send(
            new PutObjectCommand(params),
            options?.signal ? { abortSignal: options.signal } : undefined
          );
          etag = stripEtag(result.ETag);
        }
        let size = contentLength;
        let lastModified: number | undefined;
        // Stream bodies have no locally computed length; PutObject's response
        // doesn't carry size either. Do a follow-up head() to surface the
        // authoritative size and lastModified instead of silently returning 0.
        if (size === undefined) {
          try {
            const head = await client.send(
              new HeadObjectCommand({ Bucket: bucket, Key: key }),
              options?.signal ? { abortSignal: options.signal } : undefined
            );
            size = Number(head.ContentLength ?? 0);
            lastModified = head.LastModified?.getTime();
          } catch {
            size = 0;
          }
        }
        return {
          contentType,
          etag,
          key,
          lastModified,
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async url(key, urlOpts) {
      const strategy = resolveUrlStrategy({
        publicBaseUrl,
        responseContentDisposition: urlOpts?.responseContentDisposition,
      });
      if (strategy === "public" && publicBaseUrl) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      try {
        return await signGet(
          key,
          urlOpts?.expiresIn ?? defaultUrlExpiresIn,
          urlOpts?.responseContentDisposition
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
  };
};
