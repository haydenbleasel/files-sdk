import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  File,
  FileMetadata,
  GenerateSignedPostPolicyV4Options,
  Storage as StorageClient,
} from "@google-cloud/storage";
import { Storage } from "@google-cloud/storage";

import type {
  Adapter,
  SignedUpload,
  StoredFile,
  UploadProgress,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  isMultipartRequested,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  rangedSize,
  resolveUrlStrategy,
  resumableChunkSize,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { createGcsResumableDriver } from "../internal/gcs-resumable.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface GCSAdapterOptions {
  /**
   * GCS bucket name. The adapter scopes all operations to it.
   */
  bucket: string;
  /**
   * GCP project ID. Falls back to `GOOGLE_CLOUD_PROJECT` then
   * `GCLOUD_PROJECT`. Optional — Application Default Credentials carry
   * a project ID and the SDK will discover it automatically.
   */
  projectId?: string;
  /**
   * Path to a service-account JSON file. When set, takes precedence over
   * ADC. Mutually exclusive with `credentials` in practice; if both are
   * passed, the SDK uses `credentials`.
   */
  keyFilename?: string;
  /**
   * Inline service-account credentials. Useful when you only have
   * `client_email` + `private_key` available as separate env vars (e.g.
   * Vercel/Netlify) and don't want to materialize a JSON file. When
   * neither this nor `keyFilename` is set, the SDK falls back to ADC
   * (`GOOGLE_APPLICATION_CREDENTIALS`, `gcloud auth`, GCE metadata).
   */
  credentials?: { client_email: string; private_key: string };
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — appropriate for a
   * public bucket or a CDN in front of GCS. When unset, `url()` falls
   * back to a V4 signed read URL (default expiry: 1 hour).
   *
   * For a public GCS bucket, the natural value is
   * `https://storage.googleapis.com/<bucket>`.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the V4 signed URLs returned by
   * `url()` when `publicBaseUrl` is not set. Defaults to 3600 (1 hour).
   * Per-call `url(key, { expiresIn })` overrides. GCS V4 caps at 7 days.
   */
  defaultUrlExpiresIn?: number;
}

export type GCSAdapter = Adapter<StorageClient> & { readonly bucket: string };

const expiresAt = (seconds: number): number => Date.now() + seconds * 1000;

export const mapGCSError = makeErrorMapper({
  codes: {
    conflict: new Set(),
    notFound: new Set(),
    unauthorized: new Set(),
  },
  extract: (err) => {
    const e = err as {
      code?: number | string;
      message?: string;
      status?: number;
    };
    // GCS ApiError carries the HTTP status on `code` (number). Some auth
    // errors and lower-level wrappers use `status` instead. String `code`
    // values (e.g. "ENOTFOUND") fall through to Provider — we don't try to
    // classify network errors as anything more specific.
    let status: number | undefined;
    if (typeof e?.code === "number") {
      status = e.code;
    } else if (typeof e?.status === "number") {
      ({ status } = e);
    }
    return {
      ...(e?.message && { message: e.message }),
      ...(status !== undefined && { status }),
    };
  },
  providerLabel: "GCS error",
});

const uint8ToBuffer = (u8: Uint8Array): Buffer =>
  Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

const bufferToUint8 = (buf: Buffer): Uint8Array =>
  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

const pipeWebToNode = async (
  web: ReadableStream<Uint8Array>,
  node: NodeJS.WritableStream
): Promise<void> => {
  await pipeline(Readable.fromWeb(web as never), node);
};

/**
 * Write a body through a resumable `createWriteStream` — the path used for
 * streams, progress reporting, and multipart. Wires `progress` events to
 * `report` and pipes either the web stream or the buffered body in.
 */
const writeViaResumableStream = async (
  file: File,
  data: Uint8Array | ReadableStream<Uint8Array>,
  writeOpts: Parameters<File["createWriteStream"]>[0],
  report: ((progress: UploadProgress) => void) | undefined,
  contentLength: number | undefined
): Promise<void> => {
  const writeStream = file.createWriteStream(writeOpts);
  if (report) {
    writeStream.on("progress", (evt: { bytesWritten?: number }) =>
      report(
        contentLength === undefined
          ? { loaded: evt.bytesWritten ?? 0 }
          : { loaded: evt.bytesWritten ?? 0, total: contentLength }
      )
    );
  }
  await (data instanceof ReadableStream
    ? pipeWebToNode(data, writeStream)
    : pipeline(Readable.from(uint8ToBuffer(data)), writeStream));
};

const metaToStored = (
  meta: FileMetadata | undefined
): {
  size: number;
  type: string;
  etag?: string;
  lastModified?: number;
  metadata?: Record<string, string>;
} => {
  const userMeta = meta?.metadata as Record<string, string> | undefined;
  const updated = meta?.updated as string | undefined;
  return {
    ...(meta?.etag && { etag: meta.etag }),
    ...(updated && { lastModified: new Date(updated).getTime() }),
    ...(userMeta && { metadata: userMeta }),
    size: Number(meta?.size ?? 0),
    type: meta?.contentType ?? "application/octet-stream",
  };
};

export const gcs = (opts: GCSAdapterOptions): GCSAdapter => {
  const { bucket: bucketName, publicBaseUrl } = opts;
  if (!bucketName) {
    throw new FilesError(
      "Provider",
      "gcs adapter: missing bucket. Pass `bucket`."
    );
  }
  const projectId =
    opts.projectId ??
    readEnv("GOOGLE_CLOUD_PROJECT") ??
    readEnv("GCLOUD_PROJECT");

  const storage = new Storage({
    ...(projectId && { projectId }),
    ...(opts.keyFilename && { keyFilename: opts.keyFilename }),
    ...(opts.credentials && { credentials: opts.credentials }),
  });
  const bucket = storage.bucket(bucketName);
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  return {
    bucket: bucketName,
    async copy(from, to) {
      try {
        await bucket.file(from).copy(bucket.file(to));
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    async delete(key) {
      try {
        await bucket.file(key).delete();
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const file = bucket.file(key);
        const range = downloadOpts?.range;
        // GCS's `start`/`end` byte offsets are inclusive on both ends, so a
        // ByteRange maps over with no translation.
        const rangeOpts = range
          ? {
              start: range.start,
              ...(range.end !== undefined && { end: range.end }),
            }
          : undefined;
        if (downloadOpts?.as === "stream") {
          // Stream path needs metadata up front for size/type — the stream
          // itself only carries bytes. One extra round trip vs. the buffer
          // path; same trade-off as S3's HEAD-then-GET on stream downloads.
          const [meta] = await file.getMetadata();
          const m = metaToStored(meta);
          return createStoredFile(
            { key, ...m, ...(range && { size: rangedSize(m.size, range) }) },
            {
              factory: () =>
                Readable.toWeb(
                  file.createReadStream(rangeOpts)
                ) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        // Buffer path: parallel fetch of body and metadata so we surface
        // etag/lastModified/contentType without serialized round trips.
        const [downloadResult, metaResult] = await Promise.all([
          file.download(rangeOpts),
          file.getMetadata(),
        ]);
        const [buf] = downloadResult;
        const [meta] = metaResult;
        const m = metaToStored(meta);
        const bytes = bufferToUint8(buf);
        return createStoredFile(
          { key, ...m, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    async exists(key) {
      try {
        const [exists] = await bucket.file(key).exists();
        return exists;
      } catch (error) {
        const mapped = mapGCSError(error);
        if (mapped.code === "NotFound") {
          return false;
        }
        throw mapped;
      }
    },
    async head(key) {
      try {
        const file = bucket.file(key);
        const [meta] = await file.getMetadata();
        const m = metaToStored(meta);
        return createStoredFile(
          { key, ...m },
          {
            factory: async () => {
              const [buf] = await file.download();
              return bufferToUint8(buf);
            },
            kind: "lazy",
          }
        );
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    async list(options) {
      try {
        const [files, nextQuery] = await bucket.getFiles({
          autoPaginate: false,
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.limit !== undefined && { maxResults: options.limit }),
          ...(options?.cursor && { pageToken: options.cursor }),
        });
        const items: StoredFile[] = files.map((f) => {
          const m = metaToStored(f.metadata);
          return createStoredFile(
            { key: f.name, ...m },
            {
              factory: async () => {
                const [buf] = await f.download();
                return bufferToUint8(buf);
              },
              kind: "lazy",
            }
          );
        });
        const cursor = (nextQuery as { pageToken?: string } | null | undefined)
          ?.pageToken;
        return { items, ...(cursor && { cursor }) };
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    name: "gcs",
    raw: storage,
    reportsUploadProgress: true,
    resumableUpload(key, resumableOpts) {
      return createGcsResumableDriver({
        bucket: bucketName,
        file: bucket.file(key),
        key,
        opts: resumableOpts,
        wrapErr: mapGCSError,
      });
    },
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      try {
        const file = bucket.file(key);
        if (signOpts.maxSize !== undefined) {
          const minSize = signOpts.minSize ?? 1;
          const conditions: unknown[][] = [
            ["content-length-range", minSize, signOpts.maxSize],
          ];
          if (signOpts.contentType) {
            conditions.push(["eq", "$Content-Type", signOpts.contentType]);
          }
          const policyOpts: GenerateSignedPostPolicyV4Options = {
            conditions,
            expires: expiresAt(signOpts.expiresIn),
            ...(signOpts.contentType && {
              fields: { "content-type": signOpts.contentType },
            }),
          };
          const [policy] = await file.generateSignedPostPolicyV4(policyOpts);
          return { fields: policy.fields, method: "POST", url: policy.url };
        }
        const [url] = await file.getSignedUrl({
          action: "write",
          expires: expiresAt(signOpts.expiresIn),
          version: "v4",
          ...(signOpts.contentType && { contentType: signOpts.contentType }),
        });
        return {
          ...(signOpts.contentType && {
            headers: { "Content-Type": signOpts.contentType },
          }),
          method: "PUT",
          url,
        };
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    supportsRange: true,
    async upload(key, body, options) {
      const { cacheControl, metadata, multipart, onProgress } = options ?? {};
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const file = bucket.file(key);
      const wantsMultipart = isMultipartRequested(multipart);
      const chunkSize = resumableChunkSize(multipart);
      const writeOpts = {
        contentType,
        metadata: {
          ...(cacheControl && { cacheControl }),
          ...(metadata && { metadata }),
        },
        // Single-request uploads — the SDK chunks small bodies and uses
        // resumable for large ones by default, but we don't know the body
        // size for streams here and the simple-upload code path is what we
        // want for the v1 surface. Two exceptions opt into the resumable
        // path: progress (only it emits `progress` events) and an explicit
        // `multipart` request (chunked/resumable upload for large files).
        resumable: Boolean(onProgress) || wantsMultipart,
        ...(chunkSize !== undefined && { chunkSize }),
      };
      try {
        const viaStream =
          data instanceof ReadableStream ||
          Boolean(onProgress) ||
          wantsMultipart;
        await (viaStream
          ? writeViaResumableStream(
              file,
              data,
              writeOpts,
              onProgress,
              contentLength
            )
          : file.save(uint8ToBuffer(data), writeOpts));
        // GCS doesn't return etag/size from save() — pull authoritative
        // values from a follow-up getMetadata. One extra round trip but
        // simpler than relying on `file.metadata` side effects, which the
        // SDK populates on a best-effort basis.
        const [meta] = await file.getMetadata();
        const updated = meta?.updated as string | undefined;
        return {
          contentType,
          ...(meta?.etag && { etag: meta.etag }),
          key,
          ...(updated && { lastModified: new Date(updated).getTime() }),
          size: contentLength ?? Number(meta?.size ?? 0),
        } satisfies UploadResult;
      } catch (error) {
        throw mapGCSError(error);
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
        const [signed] = await bucket.file(key).getSignedUrl({
          action: "read",
          expires: expiresAt(urlOpts?.expiresIn ?? defaultUrlExpiresIn),
          version: "v4",
          ...(urlOpts?.responseContentDisposition && {
            responseDisposition: urlOpts.responseContentDisposition,
          }),
        });
        return signed;
      } catch (error) {
        throw mapGCSError(error);
      }
    },
  };
};
