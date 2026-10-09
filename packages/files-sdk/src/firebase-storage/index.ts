import { Buffer } from "node:buffer";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type {
  Bucket,
  File,
  FileMetadata,
  GenerateSignedPostPolicyV4Options,
} from "@google-cloud/storage";
import type { App } from "firebase-admin/app";

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
import { isFunction, isNumber, isObject, isString } from "../internal/is.js";
import { isJsonArray, isJsonObject } from "../internal/json.js";
import { toNodeReadable, toWebStream } from "../internal/node-stream";
import { createStoredFile } from "../internal/stored-file.js";
import {
  loadFirebaseAdminApp,
  loadFirebaseAdminStorage,
} from "./firebase-admin-loader.js";

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
   * Vercel/Netlify) and don't want to materialize a JSON file.
   *
   * Credential precedence: `app`, then `serviceAccountPath`, then this
   * option, then `GOOGLE_APPLICATION_CREDENTIALS` (read through Application
   * Default Credentials, so any ADC file type works: service account,
   * workload identity federation, or `authorized_user`), then
   * `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY`, then ambient ADC
   * (e.g. the metadata server). Explicit options always beat environment
   * variables.
   */
  credentials?: { clientEmail: string; privateKey: string };
  /**
   * Path to a service-account JSON file (passed to `cert()`, so it must be a
   * service-account key). Takes precedence over inline `credentials` and
   * every environment variable. For other credential files (workload
   * identity federation, `authorized_user`), set
   * `GOOGLE_APPLICATION_CREDENTIALS` instead, which the adapter reads
   * through Application Default Credentials.
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
   * back to a V4 signed read URL (default expiry: 1 hour); passing
   * `expiresIn` or `responseContentDisposition` still signs. Firebase's
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

// V4 signing caps a signed URL or POST policy at 7 days, and
// `@google-cloud/storage` throws above that in code on every signing call.
const V4_MAX_EXPIRES_IN = 604_800;

/**
 * Reject an expiry past V4's 7-day ceiling up front. The SDK's own refusal is
 * a plain `Error`, which would map to a retryable `Provider` — retrying a
 * request that can never be signed. Matches the S3 adapters' SigV4 check.
 */
const assertV4ExpiresIn = (expiresIn: number): void => {
  if (expiresIn > V4_MAX_EXPIRES_IN) {
    throw new FilesError(
      "Invalid",
      `firebase-storage: signed URLs must expire within ${V4_MAX_EXPIRES_IN} seconds (7 days), the V4 signing limit; got expiresIn ${expiresIn}.`
    );
  }
};

export const mapFirebaseStorageError = makeErrorMapper({
  codes: {
    conflict: new Set(),
    notFound: new Set(),
    unauthorized: new Set(),
  },
  extract: (cause) => {
    const e = isObject(cause) ? cause : undefined;
    // The underlying client is `@google-cloud/storage`; its ApiError carries
    // the HTTP status on `code` (number). Some auth errors and lower-level
    // wrappers use `status` instead. String `code` values (e.g. "ENOTFOUND")
    // fall through to Provider — we don't classify network errors further.
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

// `Bucket` instances expose `file()` and `getFiles()` directly; `App`
// instances need to be threaded through `getStorage().bucket()`. We accept
// either form via `opts.app` for parity with how other adapters accept
// pre-built clients.
const isBucket = (candidate: unknown): candidate is Bucket =>
  // oxlint-disable-next-line sonarjs/expression-complexity -- structural type-guard: the &&-chain of member checks is the predicate.
  isObject(candidate) &&
  "file" in candidate &&
  isFunction(candidate.file) &&
  "getFiles" in candidate &&
  isFunction(candidate.getFiles);

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
    "Invalid",
    "firebase-storage adapter: missing bucket. Pass `bucket` (e.g. `<project>.firebasestorage.app`) or set FIREBASE_STORAGE_BUCKET."
  );
};

// firebase-admin bundles its own (often older) copy of `@google-cloud/storage`,
// so `getStorage().bucket()` is typed against that copy's `Bucket`. It is the
// same runtime object as the SDK's `@google-cloud/storage` `Bucket`, so re-type
// it as ours to keep the adapter's types consistent regardless of which copy
// each dependency resolves to. Without this, the build's tsc fails on Linux CI
// where the two copies diverge (7.19 vs 7.21) even though it passes on macOS.
const adminBucket = (app: App, name?: string): Bucket => {
  const { getStorage } = loadFirebaseAdminStorage();
  const bucket = name ? getStorage(app).bucket(name) : getStorage(app).bucket();
  // SAFETY: same runtime class, two copies of its declaration (see above);
  // the copies differ only in private members, so TS rejects a direct
  // assertion between them.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- firebase-admin's nested @google-cloud/storage copy declares a Bucket TS deems unrelated to ours; see SAFETY above
  return bucket as unknown as Bucket;
};

const buildBucket = (opts: FirebaseStorageAdapterOptions): Bucket => {
  if (opts.app) {
    if (isBucket(opts.app)) {
      return opts.app;
    }
    const bucketName =
      opts.bucket ??
      readEnv("FIREBASE_STORAGE_BUCKET") ??
      opts.app.options.storageBucket ??
      "";
    return adminBucket(opts.app, bucketName || undefined);
  }

  const projectId =
    opts.projectId ??
    readEnv("FIREBASE_PROJECT_ID") ??
    readEnv("GOOGLE_CLOUD_PROJECT") ??
    readEnv("GCLOUD_PROJECT");

  // Explicit options beat every environment variable. Among the env vars,
  // `GOOGLE_APPLICATION_CREDENTIALS` keeps its lead over the
  // `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` pair, but it goes
  // through `applicationDefault()`, which reads the file itself and accepts
  // every ADC type (`cert()` only takes a service-account key, so workload
  // identity and `authorized_user` files used to crash).
  const inlineCredentials = (() => {
    if (opts.credentials) {
      return opts.credentials;
    }
    if (readEnv("GOOGLE_APPLICATION_CREDENTIALS")) {
      return;
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

  const { applicationDefault, cert, getApps, initializeApp } =
    loadFirebaseAdminApp();
  const existing = getApps().find((a) => a.name === appName);
  const app =
    existing ??
    initializeApp(
      {
        ...(projectId && { projectId }),
        credential: (() => {
          if (opts.serviceAccountPath) {
            return cert(opts.serviceAccountPath);
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

  return adminBucket(app, storageBucket);
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
    capabilities: {
      cacheControl: true,
      delimiter: "any",
      // A Cloud Storage bucket: GCS Pub/Sub notifications.
      events: { format: "gcs" },
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
        const range = downloadOpts?.range;
        // GCS byte offsets are inclusive on both ends, matching ByteRange.
        const rangeOpts = range
          ? {
              start: range.start,
              ...(range.end !== undefined && { end: range.end }),
            }
          : undefined;
        if (downloadOpts?.as === "stream") {
          // Stream path needs metadata up front for size/type — the stream
          // itself only carries bytes. One extra round trip vs. the buffer
          // path; same trade-off as the GCS adapter.
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
        const [meta] = await bucket.file(key).getMetadata();
        return { key, ...metaToStored(meta) };
      } catch (error) {
        throw mapFirebaseStorageError(error);
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
        throw mapFirebaseStorageError(error);
      }
    },
    name: "firebase-storage",
    raw: bucket,
    resumableUpload(key, resumableOpts) {
      return createGcsResumableDriver({
        bucket: bucketName,
        file: bucket.file(key),
        key,
        opts: resumableOpts,
        wrapErr: mapFirebaseStorageError,
      });
    },
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      assertV4ExpiresIn(signOpts.expiresIn);
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
        // Only the resumable path emits `progress` events and chunks large
        // uploads, so opt into it when the caller wants progress or multipart;
        // otherwise keep the simple upload.
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
        throw mapFirebaseStorageError(error);
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
      const expiresIn = urlOpts?.expiresIn ?? defaultUrlExpiresIn;
      assertV4ExpiresIn(expiresIn);
      try {
        const [signed] = await bucket.file(key).getSignedUrl({
          action: "read",
          expires: expiresAt(expiresIn),
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
