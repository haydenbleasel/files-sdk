import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  Bucket,
  FileMetadata,
  GenerateSignedPostPolicyV4Options,
} from "@google-cloud/storage";
import type { App } from "firebase-admin/app";
import {
  applicationDefault,
  cert,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getStorage } from "firebase-admin/storage";

import type {
  Adapter,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  DEFAULT_URL_EXPIRES_IN,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  resolveUrlStrategy,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface FirebaseStorageAdapterOptions {
  /**
   * Storage bucket name. Falls back to `FIREBASE_STORAGE_BUCKET`, then
   * `<projectId>.firebasestorage.app` if `projectId` is known. The Firebase
   * console shows the bucket as `<project>.appspot.com` on older projects
   * and `<project>.firebasestorage.app` on newer ones — pass the literal
   * name from the console rather than relying on the default.
   */
  bucket?: string;
  /**
   * GCP project ID. Falls back to `FIREBASE_PROJECT_ID`, then
   * `GOOGLE_CLOUD_PROJECT`, then `GCLOUD_PROJECT`. Optional — Application
   * Default Credentials carry a project ID and the SDK will discover it
   * automatically.
   */
  projectId?: string;
  /**
   * Inline service-account credentials. Useful when you only have
   * `clientEmail` + `privateKey` available as separate env vars (e.g.
   * Vercel/Netlify) and don't want to materialize a JSON file. When neither
   * this nor `serviceAccountPath` is set, the SDK falls back to ADC.
   * Falls back to `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`.
   */
  credentials?: { clientEmail: string; privateKey: string };
  /**
   * Path to a service-account JSON file. When set, takes precedence over
   * inline `credentials`. Falls back to `GOOGLE_APPLICATION_CREDENTIALS`.
   */
  serviceAccountPath?: string;
  /**
   * Existing Firebase {@link App} or `@google-cloud/storage` {@link Bucket}.
   * Highest precedence — when passed, all other credential options are
   * ignored. Useful when the consumer already initializes Firebase elsewhere
   * (e.g. for Firestore/Auth) and wants to share the app.
   */
  app?: App | Bucket;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — appropriate for a public
   * bucket or a CDN in front of Firebase Storage. When unset, `url()` falls
   * back to a V4 signed read URL (default expiry: 1 hour). Firebase's
   * `?alt=media&token=...` download-token URL form is out of scope for v1;
   * reach for `adapter.raw` if you need it.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the V4 signed URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour). Per-call
   * `url(key, { expiresIn })` overrides. GCS V4 caps at 7 days.
   */
  defaultUrlExpiresIn?: number;
  /**
   * Internal Firebase app name. Allows multiple adapter instances pointing
   * at different projects to coexist without the `initializeApp()` "default
   * app already exists" error. Defaults to a stable name derived from the
   * project ID and bucket; only set this if you have a reason.
   */
  appName?: string;
}

export type FirebaseStorageAdapter = Adapter<Bucket> & {
  readonly bucket: string;
};

const expiresAt = (seconds: number): number => Date.now() + seconds * 1000;

export const mapFirebaseStorageError = makeErrorMapper({
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
    // The underlying client is `@google-cloud/storage`; its ApiError carries
    // the HTTP status on `code` (number). Some auth errors and lower-level
    // wrappers use `status` instead. String `code` values (e.g. "ENOTFOUND")
    // fall through to Provider — we don't classify network errors further.
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
  providerLabel: "Firebase Storage error",
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

// `Bucket` instances expose `file()` and `getFiles()` directly; `App`
// instances need to be threaded through `getStorage().bucket()`. We accept
// either form via `opts.app` for parity with how other adapters accept
// pre-built clients.
const isBucket = (candidate: unknown): candidate is Bucket =>
  typeof candidate === "object" &&
  candidate !== null &&
  "file" in candidate &&
  typeof (candidate as { file?: unknown }).file === "function" &&
  "getFiles" in candidate &&
  typeof (candidate as { getFiles?: unknown }).getFiles === "function";

const resolveBucketName = (
  projectId: string | undefined,
  explicit: string | undefined
): string => {
  const fromOpts = explicit ?? readEnv("FIREBASE_STORAGE_BUCKET");
  if (fromOpts) {
    return fromOpts;
  }
  if (projectId) {
    return `${projectId}.firebasestorage.app`;
  }
  throw new FilesError(
    "Provider",
    "firebase-storage adapter: missing bucket. Pass `bucket` (e.g. `<project>.firebasestorage.app`) or set FIREBASE_STORAGE_BUCKET."
  );
};

const buildBucket = (opts: FirebaseStorageAdapterOptions): Bucket => {
  if (opts.app) {
    if (isBucket(opts.app)) {
      return opts.app;
    }
    const bucketName =
      opts.bucket ??
      readEnv("FIREBASE_STORAGE_BUCKET") ??
      (opts.app.options as { storageBucket?: string }).storageBucket ??
      "";
    return bucketName
      ? getStorage(opts.app).bucket(bucketName)
      : getStorage(opts.app).bucket();
  }

  const projectId =
    opts.projectId ??
    readEnv("FIREBASE_PROJECT_ID") ??
    readEnv("GOOGLE_CLOUD_PROJECT") ??
    readEnv("GCLOUD_PROJECT");

  const serviceAccountPath =
    opts.serviceAccountPath ?? readEnv("GOOGLE_APPLICATION_CREDENTIALS");

  const inlineCredentials = (() => {
    if (opts.credentials) {
      return opts.credentials;
    }
    const clientEmail = readEnv("FIREBASE_CLIENT_EMAIL");
    const privateKey = readEnv("FIREBASE_PRIVATE_KEY");
    if (clientEmail && privateKey) {
      return { clientEmail, privateKey };
    }
  })();

  const storageBucket = resolveBucketName(projectId, opts.bucket);

  // initializeApp() throws if called twice for the same name, so derive a
  // stable name per (project, bucket) pair and reuse an existing app when
  // present. This lets callers construct adapters freely without leaking
  // app instances or fighting Firebase's idempotency rules.
  const appName =
    opts.appName ?? `files-sdk:${projectId ?? "default"}:${storageBucket}`;

  const existing = getApps().find((a) => a.name === appName);
  const app =
    existing ??
    initializeApp(
      {
        ...(projectId && { projectId }),
        credential: (() => {
          if (serviceAccountPath) {
            return cert(serviceAccountPath);
          }
          if (inlineCredentials) {
            // Firebase normalizes \\n -> \n in env-sourced private keys,
            // but only when the env var is read directly. When threaded
            // through user code the escape may survive — handle it here so
            // callers don't have to.
            return cert({
              clientEmail: inlineCredentials.clientEmail,
              privateKey: inlineCredentials.privateKey.replaceAll(
                String.raw`\n`,
                "\n"
              ),
              ...(projectId && { projectId }),
            });
          }
          return applicationDefault();
        })(),
        storageBucket,
      },
      appName
    );

  return getStorage(app).bucket(storageBucket);
};

export const firebaseStorage = (
  opts: FirebaseStorageAdapterOptions = {}
): FirebaseStorageAdapter => {
  const bucket = buildBucket(opts);
  const bucketName = bucket.name;
  const { publicBaseUrl } = opts;
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  return {
    bucket: bucketName,
    async copy(from, to) {
      try {
        await bucket.file(from).copy(bucket.file(to));
      } catch (error) {
        throw mapFirebaseStorageError(error);
      }
    },
    async delete(key) {
      try {
        await bucket.file(key).delete();
      } catch (error) {
        throw mapFirebaseStorageError(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const file = bucket.file(key);
        if (downloadOpts?.as === "stream") {
          // Stream path needs metadata up front for size/type — the stream
          // itself only carries bytes. One extra round trip vs. the buffer
          // path; same trade-off as the GCS adapter.
          const [meta] = await file.getMetadata();
          const m = metaToStored(meta);
          return createStoredFile(
            { key, ...m },
            {
              factory: () =>
                Readable.toWeb(
                  file.createReadStream()
                ) as unknown as ReadableStream<Uint8Array>,
              kind: "stream",
            }
          );
        }
        const [downloadResult, metaResult] = await Promise.all([
          file.download(),
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
        throw mapFirebaseStorageError(error);
      }
    },
    async exists(key) {
      try {
        const [exists] = await bucket.file(key).exists();
        return exists;
      } catch (error) {
        const mapped = mapFirebaseStorageError(error);
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
        throw mapFirebaseStorageError(error);
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
        throw mapFirebaseStorageError(error);
      }
    },
    name: "firebase-storage",
    raw: bucket,
    reportsUploadProgress: true,
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
        throw mapFirebaseStorageError(error);
      }
    },
    async upload(key, body, options) {
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const file = bucket.file(key);
      const report = options?.onProgress;
      const writeOpts = {
        contentType,
        metadata: {
          ...(options?.cacheControl && { cacheControl: options.cacheControl }),
          ...(options?.metadata && { metadata: options.metadata }),
        },
        // Only the resumable path emits `progress` events, so opt into it when
        // the caller wants progress; otherwise keep the simple upload.
        resumable: Boolean(report),
      };
      try {
        if (data instanceof ReadableStream || report) {
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
        } else {
          await file.save(uint8ToBuffer(data), writeOpts);
        }
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
        throw mapFirebaseStorageError(error);
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
        throw mapFirebaseStorageError(error);
      }
    },
  };
};
