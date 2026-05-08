import {
  CopyObjectCommand,
  DeleteObjectCommand,
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
  Body,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface S3AdapterOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
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

const normalizeBody = async (
  body: Body,
  contentTypeHint?: string
): Promise<{
  data: Uint8Array | ReadableStream<Uint8Array> | string;
  contentType: string;
  contentLength?: number;
}> => {
  if (typeof body === "string") {
    const data = new TextEncoder().encode(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data,
    };
  }
  if (body instanceof Uint8Array) {
    return {
      contentLength: body.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data: body,
    };
  }
  if (body instanceof ArrayBuffer) {
    const data = new Uint8Array(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data,
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data,
    };
  }
  if (body instanceof Blob) {
    const buf = new Uint8Array(await body.arrayBuffer());
    return {
      contentLength: buf.byteLength,
      contentType: contentTypeHint ?? body.type ?? "application/octet-stream",
      data: buf,
    };
  }
  // ReadableStream
  return {
    contentType: contentTypeHint ?? "application/octet-stream",
    data: body,
  };
};

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

const emptyStream = (): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });

const NOT_FOUND_CODES = new Set(["NoSuchKey", "NotFound"]);
const NOT_FOUND_STATUS = new Set([404]);
const UNAUTH_STATUS = new Set([401, 403]);
const CONFLICT_STATUS = new Set([409, 412]);

const classifyS3Error = (
  code: string | undefined,
  status: number | undefined
): FilesErrorCode => {
  if (
    (code && NOT_FOUND_CODES.has(code)) ||
    NOT_FOUND_STATUS.has(status ?? 0)
  ) {
    return "NotFound";
  }
  if (code === "AccessDenied" || UNAUTH_STATUS.has(status ?? 0)) {
    return "Unauthorized";
  }
  if (code === "PreconditionFailed" || CONFLICT_STATUS.has(status ?? 0)) {
    return "Conflict";
  }
  return "Provider";
};

const defaultMessages = (
  providerLabel: string
): Record<FilesErrorCode, string> => ({
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: providerLabel,
  Unauthorized: "Unauthorized",
});

const DEFAULT_S3_MESSAGES = defaultMessages("S3 error");

export const mapS3Error = (
  err: unknown,
  messages: Record<FilesErrorCode, string> = DEFAULT_S3_MESSAGES
): FilesError => {
  if (err instanceof FilesError) {
    return err;
  }
  const e = err as {
    name?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
    message?: string;
  };
  const code = classifyS3Error(
    e?.name ?? e?.Code,
    e?.$metadata?.httpStatusCode
  );
  return new FilesError(code, e?.message ?? messages[code], err);
};

// Default expiry for url() in seconds — 1 hour. Long enough for normal
// browser-driven flows, short enough that an accidentally-leaked URL stops
// working before the day is out. Overridable per adapter via
// `defaultUrlExpiresIn` and per call via `url(key, { expiresIn })`.
const DEFAULT_URL_EXPIRES_IN = 3600;

const joinPublicUrl = (base: string, key: string): string => {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}/${key}`;
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
  const messages = opts.defaultProviderMessage
    ? defaultMessages(opts.defaultProviderMessage)
    : DEFAULT_S3_MESSAGES;
  const wrapErr = (err: unknown): FilesError => mapS3Error(err, messages);

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
    async copy(from, to) {
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
          })
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async delete(key) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key })
        );
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
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
    async head(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key })
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
          })
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
      try {
        const result = await client.send(
          new PutObjectCommand({
            Body: data,
            Bucket: bucket,
            ContentType: contentType,
            Key: key,
            ...(options?.cacheControl && {
              CacheControl: options.cacheControl,
            }),
            ...(options?.metadata && { Metadata: options.metadata }),
            ...(contentLength !== undefined && {
              ContentLength: contentLength,
            }),
          })
        );
        let size = contentLength;
        let lastModified: number | undefined;
        // Stream bodies have no locally computed length; PutObject's response
        // doesn't carry size either. Do a follow-up head() to surface the
        // authoritative size and lastModified instead of silently returning 0.
        if (size === undefined) {
          try {
            const head = await client.send(
              new HeadObjectCommand({ Bucket: bucket, Key: key })
            );
            size = Number(head.ContentLength ?? 0);
            lastModified = head.LastModified?.getTime();
          } catch {
            size = 0;
          }
        }
        return {
          contentType,
          etag: stripEtag(result.ETag),
          key,
          lastModified,
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async url(key, urlOpts) {
      // `responseContentDisposition` forces signing even when `publicBaseUrl`
      // is configured — a permanent CDN URL has no signature to bind the
      // override into, and silently dropping the override would be a
      // security regression (uploaded HTML/SVG would render inline at the
      // bucket's origin). The override wins; if the user wanted the CDN URL
      // they wouldn't have asked for the disposition override.
      const wantsDisposition = Boolean(urlOpts?.responseContentDisposition);
      if (publicBaseUrl && !wantsDisposition) {
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
