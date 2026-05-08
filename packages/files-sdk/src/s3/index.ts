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

const DEFAULT_S3_MESSAGES: Record<FilesErrorCode, string> = {
  Conflict: "Conflict",
  NotFound: "Not found",
  Provider: "S3 error",
  Unauthorized: "Unauthorized",
};

export const mapS3Error = (err: unknown): FilesError => {
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
  return new FilesError(code, e?.message ?? DEFAULT_S3_MESSAGES[code], err);
};

export const s3 = (opts: S3AdapterOptions): S3Adapter => {
  const region =
    opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
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
        throw mapS3Error(error);
      }
    },
    async delete(key) {
      try {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key })
        );
      } catch (error) {
        throw mapS3Error(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const result = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key })
        );
        const meta = {
          etag: stripEtag(result.ETag),
          key,
          lastModified: result.LastModified?.getTime(),
          metadata: result.Metadata,
          size: Number(result.ContentLength ?? 0),
          type: result.ContentType ?? "application/octet-stream",
        };
        if (downloadOpts?.as === "stream") {
          const stream = result.Body?.transformToWebStream();
          return createStoredFile(meta, {
            factory: () => stream ?? emptyStream(),
            kind: "stream",
          });
        }
        const bytes =
          (await result.Body?.transformToByteArray()) ?? new Uint8Array();
        return createStoredFile(meta, { data: bytes, kind: "buffer" });
      } catch (error) {
        throw mapS3Error(error);
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
        throw mapS3Error(error);
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
        throw mapS3Error(error);
      }
    },
    name: "s3",
    raw: client,
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      try {
        if (signOpts.maxSize !== undefined) {
          const conditions: (
            | [string, ...unknown[]]
            | Record<string, string>
          )[] = [["content-length-range", 0, signOpts.maxSize]];
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
        throw mapS3Error(error);
      }
    },
    async signedUrl(key, signOpts) {
      try {
        return await getSignedUrl(
          client,
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          { expiresIn: signOpts.expiresIn }
        );
      } catch (error) {
        throw mapS3Error(error);
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
        return {
          contentType,
          etag: stripEtag(result.ETag),
          key,
          lastModified: undefined,
          size: contentLength ?? 0,
        } satisfies UploadResult;
      } catch (error) {
        throw mapS3Error(error);
      }
    },
    url(_key) {
      throw new FilesError(
        "Provider",
        "S3 buckets do not expose a public URL by default. Use signedUrl() instead."
      );
    },
  };
};
