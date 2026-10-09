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
  FileInfo,
  SignedUpload,
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
import { isNumber, isObject, isString } from "../internal/is.js";
import { isJsonArray, isJsonObject } from "../internal/json.js";
import { toNodeReadable, toWebStream } from "../internal/node-stream";
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
   * back to a V4 signed read URL (default expiry: 1 hour). Passing
   * `expiresIn` or `responseContentDisposition` still signs.
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

// V4 signing caps a signed URL or POST policy at 7 days, and
// `@google-cloud/storage` throws above that in code on every signing call.
const V4_MAX_EXPIRES_IN = 604_800;

export const mapGCSError = makeErrorMapper({
  codes: {
    conflict: new Set(),
    notFound: new Set(),
    unauthorized: new Set(),
  },
  extract: (cause) => {
    const e = isObject(cause) ? cause : undefined;
    // GCS ApiError carries the HTTP status on `code` (number). Some auth
    // errors and lower-level wrappers use `status` instead. String `code`
    // values (e.g. "ENOTFOUND") fall through to Provider — we don't try to
    // classify network errors as anything more specific.
    let status: number | undefined;
    if (e && "code" in e && isNumber(e.code)) {
      status = e.code;
    } else if (e && "status" in e && isNumber(e.status)) {
      ({ status } = e);
    }
    const message =
      e && "message" in e && isString(e.message) ? e.message : undefined;
    return {
      ...(message && { message }),
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
  await pipeline(toNodeReadable(web), node);
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

interface StoredObjectMeta {
  contentType: string;
  etag?: string;
  lastModified?: number;
  metadata?: Record<string, string>;
  size: number;
}

const metaToStored = (meta: FileMetadata | undefined): StoredObjectMeta => {
  // SAFETY: GCS stores custom metadata as strings on the wire; the SDK's
  // `metadata` type admits numbers, booleans and `null` only on the write
  // side (they are stringified, `null` deletes), so a read-back value is
  // always a string record.
  const userMeta = meta?.metadata as Record<string, string> | undefined;
  const updated = meta?.updated;
  return {
    contentType: meta?.contentType ?? "application/octet-stream",
    ...(meta?.etag && { etag: meta.etag }),
    ...(updated && { lastModified: new Date(updated).getTime() }),
    ...(userMeta && { metadata: userMeta }),
    size: Number(meta?.size ?? 0),
  };
};

export const gcs = (opts: GCSAdapterOptions): GCSAdapter => {
  const { bucket: bucketName, publicBaseUrl } = opts;
  if (!bucketName) {
    throw new FilesError(
      "Invalid",
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
    capabilities: {
      cacheControl: true,
      delimiter: "any",
      metadata: true,
      // A plain `url()` returns the permanent `publicBaseUrl` link when set.
      publicUrl: Boolean(publicBaseUrl),
      rangeRead: true,
      // `copy()` is a server-side GCS object copy.
      serverSideCopy: true,
      // `signedUploadUrl()` mints a V4 signed PUT, or a V4 POST policy whose
      // `content-length-range` enforces `maxSize`; `contentType` is bound into
      // either signature. Both share V4's 7-day ceiling.
      signedUpload: {
        contentType: true,
        maxExpiresIn: V4_MAX_EXPIRES_IN,
        maxSize: true,
        supported: true,
      },
      // `url()` returns a V4 signed URL (or `publicBaseUrl` when set and
      // neither `expiresIn` nor `responseContentDisposition` is passed), with
      // `responseContentDisposition` bound as `responseDisposition`. The SDK
      // rejects an expiry past V4's 7-day limit, so declare that ceiling.
      signedUrl: {
        disposition: true,
        expiry: "exact",
        maxExpiresIn: V4_MAX_EXPIRES_IN,
        supported: true,
      },
      uploadProgress: true,
    },
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
              factory: () => toWebStream(file.createReadStream(rangeOpts)),
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
        const [meta] = await bucket.file(key).getMetadata();
        return { key, ...metaToStored(meta) };
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    async list(options) {
      try {
        // getFiles returns [files, nextQuery, apiResponse]; the third element
        // carries `prefixes` (the common prefixes) when a delimiter is set.
        const [files, nextQuery, apiResponse] = await bucket.getFiles({
          autoPaginate: false,
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.limit !== undefined && { maxResults: options.limit }),
          ...(options?.cursor && { pageToken: options.cursor }),
          ...(options?.delimiter && { delimiter: options.delimiter }),
        });
        const items: FileInfo[] = files.map((f) => ({
          key: f.name,
          ...metaToStored(f.metadata),
        }));
        const cursor = nextQuery?.pageToken;
        // The raw API response is untyped; `prefixes` is the JSON string list
        // of common prefixes for a delimiter listing.
        const prefixes =
          isJsonObject(apiResponse) && isJsonArray(apiResponse.prefixes)
            ? apiResponse.prefixes.filter(isString)
            : undefined;
        return {
          items,
          ...(cursor && { cursor }),
          ...(prefixes?.length && { prefixes }),
        };
      } catch (error) {
        throw mapGCSError(error);
      }
    },
    name: "gcs",
    raw: storage,
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
        const updated = meta?.updated;
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
        expiresIn: urlOpts?.expiresIn,
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
