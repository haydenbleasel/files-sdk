import { Buffer } from "node:buffer";

import { StorageClient } from "@supabase/storage-js";

import type {
  Adapter,
  Body,
  ListResult,
  OffsetResumableDriver,
  ResumableUploadSession,
  SignedUpload,
  StoredFile,
  UploadResult,
} from "../index.js";
import {
  assertSlashDelimiter,
  DEFAULT_URL_EXPIRES_IN,
  deleteManyWithFallback,
  joinPublicUrl,
  makeErrorMapper,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface SupabaseAdapterOptions {
  /**
   * Supabase storage bucket. Must already exist (this SDK does not create
   * buckets). Surfaced as `bucket` on the returned adapter for cross-adapter
   * API consistency (S3/R2/GCS/MinIO/Azure all expose `bucket`).
   */
  bucket: string;
  /**
   * Existing client instance. Highest precedence. Pass either:
   *  - a `StorageClient` (from `@supabase/storage-js`), or
   *  - a `SupabaseClient` (from `@supabase/supabase-js`) — the adapter will
   *    pick `client.storage` automatically.
   *
   * Useful when the consumer already constructs a Supabase client for auth
   * or postgrest and wants to share it with the storage adapter.
   */
  client?: StorageClient | { storage: StorageClient };
  /**
   * Supabase project URL (e.g. `https://xxxx.supabase.co`). Required if
   * `client` is not provided. The adapter appends `/storage/v1` automatically
   * when constructing a `StorageClient`. Falls back to `SUPABASE_URL`, then
   * `NEXT_PUBLIC_SUPABASE_URL`.
   */
  url?: string;
  /**
   * Supabase API key. The service role key is required for write operations
   * on RLS-protected buckets; the anon key works for public buckets. Falls
   * back to `SUPABASE_SERVICE_ROLE_KEY`, then `SUPABASE_KEY`, then
   * `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
   */
  key?: string;
  /**
   * Set to `true` if the bucket is configured as a public bucket. `url()`
   * will then return `getPublicUrl()` results — a permanent, unsigned URL —
   * instead of minting a signed read URL.
   *
   * Supabase exposes no API to detect bucket visibility from the client; if
   * `public: true` is set on a private bucket, the returned URL will 4xx
   * when fetched.
   */
  public?: boolean;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips both signing and `getPublicUrl()` —
   * appropriate when a CDN sits in front of the Supabase project. Implies
   * `public: true`.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the signed read URLs returned by
   * `url()` when neither `public` nor `publicBaseUrl` is set. Defaults to
   * 3600 (1 hour). Per-call `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
}

export type SupabaseAdapter = Adapter<StorageClient> & {
  readonly bucket: string;
};

const DEFAULT_LIST_LIMIT = 100;

const SUPABASE_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "NotFound",
  "NoSuchKey",
]);
const SUPABASE_UNAUTH_CODES: ReadonlySet<string> = new Set([
  "InvalidJWT",
  "Unauthorized",
  "AccessDenied",
  "InvalidKey",
]);
const SUPABASE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "Duplicate",
  "AlreadyExists",
]);

const _supabaseErrorMapper = makeErrorMapper({
  codes: {
    conflict: SUPABASE_CONFLICT_CODES,
    notFound: SUPABASE_NOT_FOUND_CODES,
    unauthorized: SUPABASE_UNAUTH_CODES,
  },
  extract: (err) => {
    const e = (err ?? {}) as {
      message?: string;
      status?: number;
      statusCode?: string | number;
    };
    // `statusCode` from StorageApiError is the server's string code (e.g.
    // "NotFound", "Duplicate"). Fall back to `status` (HTTP) which is
    // present on every StorageApiError and many transport errors.
    const code = typeof e.statusCode === "string" ? e.statusCode : undefined;
    let status: number | undefined;
    if (typeof e.status === "number") {
      ({ status } = e);
    } else if (typeof e.statusCode === "number") {
      status = e.statusCode;
    }
    return {
      ...(code && { code }),
      ...(e.message && { message: e.message }),
      ...(status !== undefined && { status }),
    };
  },
  providerLabel: "Supabase error",
});

// `mapSupabaseError(undefined)` was a documented shape (the SDK can return
// `error: null` and a few call sites pass it straight through). Preserve
// the optional-arg signature.
export const mapSupabaseError = (err?: unknown): FilesError =>
  _supabaseErrorMapper(err);

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

// `@supabase/storage-js` accepts a trailing `FetchParameters` (which carries
// `signal`) on `download` and `list` — and only those. Forward the
// operation's AbortSignal there; return `undefined` when there's no signal so
// the call is unchanged.
const fetchParams = (
  signal: AbortSignal | undefined
): { signal: AbortSignal } | undefined => (signal ? { signal } : undefined);

const normalizeBody = async (
  body: Body,
  contentTypeHint?: string
): Promise<{
  data: Uint8Array | ReadableStream<Uint8Array> | Blob;
  contentType: string;
  contentLength?: number;
  isBlob: boolean;
}> => {
  if (typeof body === "string") {
    const data = new TextEncoder().encode(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "text/plain; charset=utf-8",
      data,
      isBlob: false,
    };
  }
  if (body instanceof Uint8Array) {
    return {
      contentLength: body.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data: body,
      isBlob: false,
    };
  }
  if (body instanceof ArrayBuffer) {
    const data = new Uint8Array(body);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data,
      isBlob: false,
    };
  }
  if (ArrayBuffer.isView(body)) {
    const view = body as ArrayBufferView;
    const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    return {
      contentLength: data.byteLength,
      contentType: contentTypeHint ?? "application/octet-stream",
      data,
      isBlob: false,
    };
  }
  if (body instanceof Blob) {
    // Supabase sends Blob/File as multipart and uses the Blob's own
    // `type` for the part — `FileOptions.contentType` is ignored. To make
    // the caller's `contentType` honored consistently, drain the Blob to
    // a Uint8Array when an override is set; otherwise pass it through and
    // let the Blob's type win.
    if (contentTypeHint && contentTypeHint !== body.type) {
      const buf = new Uint8Array(await body.arrayBuffer());
      return {
        contentLength: buf.byteLength,
        contentType: contentTypeHint,
        data: buf,
        isBlob: false,
      };
    }
    return {
      contentLength: body.size,
      contentType: contentTypeHint ?? (body.type || "application/octet-stream"),
      data: body,
      isBlob: true,
    };
  }
  return {
    contentType: contentTypeHint ?? "application/octet-stream",
    data: body,
    isBlob: false,
  };
};

const isStorageClientLike = (
  candidate: unknown
): candidate is { storage: StorageClient } =>
  typeof candidate === "object" &&
  candidate !== null &&
  "storage" in candidate &&
  typeof (candidate as { storage?: unknown }).storage === "object";

const buildClient = (opts: SupabaseAdapterOptions): StorageClient => {
  if (opts.client) {
    return isStorageClientLike(opts.client) ? opts.client.storage : opts.client;
  }
  const url =
    opts.url ?? readEnv("SUPABASE_URL") ?? readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    opts.key ??
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
    readEnv("SUPABASE_KEY") ??
    readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!url || !key) {
    throw new FilesError(
      "Provider",
      "supabase adapter: missing credentials. Pass `client` (an existing SupabaseClient or StorageClient), or `url` + `key`. Env fallbacks: SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY / NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  const trimmed = url.slice(0, end);
  const storageUrl = trimmed.endsWith("/storage/v1")
    ? trimmed
    : `${trimmed}/storage/v1`;
  return new StorageClient(storageUrl, {
    Authorization: `Bearer ${key}`,
    apikey: key,
  });
};

const b64 = (value: string): string => Buffer.from(value).toString("base64");

// Resolve the resumable (TUS) endpoint + key the same way `buildClient`
// resolves the storage URL. Returns `undefined` when only a pre-built `client`
// was supplied (no URL/key to reach the upload endpoint with).
const resolveTusConfig = (
  opts: SupabaseAdapterOptions
): { endpoint: string; key: string } | undefined => {
  if (opts.client) {
    return;
  }
  const url =
    opts.url ?? readEnv("SUPABASE_URL") ?? readEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    opts.key ??
    readEnv("SUPABASE_SERVICE_ROLE_KEY") ??
    readEnv("SUPABASE_KEY") ??
    readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (!(url && key)) {
    return;
  }
  let end = url.length;
  while (end > 0 && url[end - 1] === "/") {
    end -= 1;
  }
  const trimmed = url.slice(0, end);
  const storageUrl = trimmed.endsWith("/storage/v1")
    ? trimmed
    : `${trimmed}/storage/v1`;
  return { endpoint: `${storageUrl}/upload/resumable`, key };
};

interface SupabaseListItemMetadata {
  eTag?: string;
  size?: number;
  mimetype?: string;
  cacheControl?: string;
  lastModified?: string | number | Date;
  contentLength?: number;
  [key: string]: unknown;
}

interface SupabaseInfoLike {
  size?: number;
  contentType?: string;
  etag?: string;
  lastModified?: string | number | Date;
  cacheControl?: string;
  metadata?: Record<string, unknown> | null;
}

const toMs = (
  value: string | number | Date | undefined
): number | undefined => {
  if (value === undefined || value === null) {
    return;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "number") {
    return value;
  }
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : undefined;
};

const stringifyMetadata = (
  metadata: Record<string, unknown> | null | undefined
): Record<string, string> | undefined => {
  if (!metadata) {
    return;
  }
  const out: Record<string, string> = {};
  let any = false;
  for (const [k, v] of Object.entries(metadata)) {
    if (v === undefined || v === null) {
      continue;
    }
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
    any = true;
  }
  return any ? out : undefined;
};

const blobToUint8 = async (blob: Blob): Promise<Uint8Array> =>
  new Uint8Array(await blob.arrayBuffer());

const safeInfo = async (
  bucketRef: ReturnType<StorageClient["from"]>,
  key: string
): Promise<SupabaseInfoLike | undefined> => {
  try {
    const { data, error } = await bucketRef.info(key);
    if (error || !data) {
      return;
    }
    return data as SupabaseInfoLike;
  } catch {
    // info() may not be supported on older Supabase deployments.
  }
};

export const supabase = (opts: SupabaseAdapterOptions): SupabaseAdapter => {
  const { bucket, public: isPublic, publicBaseUrl } = opts;
  if (!bucket) {
    throw new FilesError(
      "Provider",
      "supabase adapter: missing bucket. Pass `bucket`."
    );
  }
  const client = buildClient(opts);
  const bucketRef = client.from(bucket);
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  const downloadAsBytes = async (key: string): Promise<Uint8Array> => {
    const { data, error } = await bucketRef.download(key);
    if (error) {
      throw mapSupabaseError(error);
    }
    return blobToUint8(data as Blob);
  };

  const downloadAsStreamFile = async (
    key: string,
    signal?: AbortSignal
  ): Promise<StoredFile> => {
    const { data, error } = await bucketRef
      .download(key, undefined, fetchParams(signal))
      .asStream();
    if (error) {
      throw mapSupabaseError(error);
    }
    const stream = data as ReadableStream<Uint8Array>;
    // Supabase's stream download doesn't surface metadata alongside
    // the body. Issue an `info()` call for size/type/etag so the
    // returned StoredFile is usable. info() may not be supported on
    // older Supabase deployments; in that case we fall back to zero
    // size and the stream's content-type.
    const meta = await safeInfo(bucketRef, key);
    return createStoredFile(
      {
        ...(meta?.etag && { etag: stripEtag(meta.etag) }),
        key,
        ...(meta?.lastModified && {
          lastModified: toMs(meta.lastModified),
        }),
        ...(meta?.metadata && {
          metadata: stringifyMetadata(meta.metadata),
        }),
        size: meta?.size ?? 0,
        type: meta?.contentType ?? "application/octet-stream",
      },
      {
        factory: () => stream,
        kind: "stream",
      }
    );
  };

  const downloadAsBufferFile = async (
    key: string,
    signal?: AbortSignal
  ): Promise<StoredFile> => {
    const { data, error } = await bucketRef.download(
      key,
      undefined,
      fetchParams(signal)
    );
    if (error) {
      throw mapSupabaseError(error);
    }
    const blob = data as Blob;
    const bytes = await blobToUint8(blob);
    // Blob.type may be empty when Supabase doesn't echo a Content-Type;
    // fall back to info() in that case so callers get a useful type.
    let { type } = blob;
    let etag: string | undefined;
    let lastModified: number | undefined;
    let metadata: Record<string, string> | undefined;
    if (!type) {
      const meta = await safeInfo(bucketRef, key);
      type = meta?.contentType ?? "application/octet-stream";
      etag = stripEtag(meta?.etag);
      lastModified = toMs(meta?.lastModified);
      metadata = stringifyMetadata(meta?.metadata);
    }
    return createStoredFile(
      {
        ...(etag && { etag }),
        key,
        ...(lastModified !== undefined && { lastModified }),
        ...(metadata && { metadata }),
        size: bytes.byteLength,
        type,
      },
      { data: bytes, kind: "buffer" }
    );
  };

  const deleteOne = async (key: string): Promise<void> => {
    // `remove()` is idempotent in Supabase — it returns an empty array
    // (not an error) when the key doesn't exist, matching the
    // silent-on-missing behavior of S3/Azure.
    const { error } = await bucketRef.remove([key]);
    if (error) {
      throw mapSupabaseError(error);
    }
  };

  return {
    bucket,
    async copy(from, to) {
      const { error } = await bucketRef.copy(from, to);
      if (error) {
        throw mapSupabaseError(error);
      }
    },
    delete: deleteOne,
    async deleteMany(keys, deleteOpts) {
      if (keys.length === 0) {
        return { deleted: [] };
      }
      if (deleteOpts?.stopOnError) {
        return deleteManyWithFallback(
          keys,
          deleteOne,
          deleteOpts,
          mapSupabaseError
        );
      }
      // Supabase has no documented per-request key cap, so the whole list is
      // sent in one `remove()`. On success it doesn't report which keys
      // actually existed; like `delete()`, a missing key counts as deleted.
      const { error } = await bucketRef.remove(keys);
      if (!error) {
        return { deleted: [...keys] };
      }
      // `remove()` surfaces a single batch-level error rather than per-key
      // failures, so map it onto every key.
      const mapped = mapSupabaseError(error);
      return {
        deleted: [],
        errors: keys.map((key) => ({ error: mapped, key })),
      };
    },
    download(key, downloadOpts) {
      if (downloadOpts?.as === "stream") {
        return downloadAsStreamFile(key, downloadOpts?.signal);
      }
      return downloadAsBufferFile(key, downloadOpts?.signal);
    },
    async exists(key) {
      const { error } = await bucketRef.info(key);
      if (!error) {
        return true;
      }
      const mapped = mapSupabaseError(error);
      if (mapped.code === "NotFound") {
        return false;
      }
      throw mapped;
    },
    async head(key) {
      const { data, error } = await bucketRef.info(key);
      if (error) {
        throw mapSupabaseError(error);
      }
      const info = data as SupabaseInfoLike;
      return createStoredFile(
        {
          ...(info.etag && { etag: stripEtag(info.etag) }),
          key,
          ...(info.lastModified !== undefined && {
            lastModified: toMs(info.lastModified),
          }),
          ...(info.metadata && {
            metadata: stringifyMetadata(info.metadata),
          }),
          size: info.size ?? 0,
          type: info.contentType ?? "application/octet-stream",
        },
        {
          factory: () => downloadAsBytes(key),
          kind: "lazy",
        }
      );
    },
    async list(options): Promise<ListResult> {
      // Both shapes go through the V2 search API. The legacy V1 list() is
      // folder-scoped and non-recursive — it returns only the direct
      // children of the prefix-as-folder, with subfolders folded in as
      // zero-size placeholder rows — so a flat listing of a bucket with
      // nested keys would miss every nested object and surface phantom
      // zero-byte "files" for the folders. listV2 without a delimiter is a
      // plain string-prefix scan over full keys, with a real cursor.
      const v2Item = (
        obj: { metadata?: unknown; key?: string; name: string },
        fullKey: string
      ): StoredFile => {
        const meta = (obj.metadata ?? {}) as SupabaseListItemMetadata;
        return createStoredFile(
          {
            ...(meta.eTag && { etag: stripEtag(meta.eTag) }),
            key: fullKey,
            ...(meta.lastModified !== undefined && {
              lastModified: toMs(meta.lastModified),
            }),
            ...(stringifyMetadata(meta as Record<string, unknown>) && {
              metadata: stringifyMetadata(meta as Record<string, unknown>),
            }),
            size: meta.size ?? meta.contentLength ?? 0,
            type: meta.mimetype ?? "application/octet-stream",
          },
          { factory: () => downloadAsBytes(fullKey), kind: "lazy" }
        );
      };
      const listFolded = async (delimiter: string): Promise<ListResult> => {
        assertSlashDelimiter("supabase", delimiter);
        const { data, error } = await bucketRef.listV2(
          {
            limit: options?.limit ?? DEFAULT_LIST_LIMIT,
            with_delimiter: true,
            ...(options?.prefix && { prefix: options.prefix }),
            ...(options?.cursor && { cursor: options.cursor }),
          },
          fetchParams(options?.signal)
        );
        if (error) {
          throw mapSupabaseError(error);
        }
        const trimmedPrefix = options?.prefix?.replace(/\/$/u, "");
        const fullPath = (name: string, key?: string): string =>
          key ?? (trimmedPrefix ? `${trimmedPrefix}/${name}` : name);
        const items: StoredFile[] = data.objects.map((obj) =>
          v2Item(obj, fullPath(obj.name, obj.key))
        );
        const prefixes = data.folders.map((folder) => {
          const raw = fullPath(folder.name, folder.key);
          return raw.endsWith("/") ? raw : `${raw}/`;
        });
        return {
          items,
          ...(data.hasNext && data.nextCursor && { cursor: data.nextCursor }),
          ...(prefixes.length && { prefixes }),
        };
      };
      if (options?.delimiter) {
        return await listFolded(options.delimiter);
      }
      const { data, error } = await bucketRef.listV2(
        {
          limit: options?.limit ?? DEFAULT_LIST_LIMIT,
          ...(options?.prefix && { prefix: options.prefix }),
          ...(options?.cursor && { cursor: options.cursor }),
        },
        fetchParams(options?.signal)
      );
      if (error) {
        throw mapSupabaseError(error);
      }
      // Flat-mode object names are already full keys (`key` when the server
      // provides it is the same path).
      const items: StoredFile[] = data.objects.map((obj) =>
        v2Item(obj, obj.key ?? obj.name)
      );
      return {
        items,
        ...(data.hasNext && data.nextCursor && { cursor: data.nextCursor }),
      };
    },
    name: "supabase",
    raw: client,
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      const tus = resolveTusConfig(opts);
      let uri: string | undefined;
      let contentType = "application/octet-stream";
      let lastOffset = 0;
      const requireTus = () => {
        if (!tus) {
          throw new FilesError(
            "Provider",
            "supabase: resumable uploads require `url` + `key` (not the pre-built `client` escape hatch)."
          );
        }
        return tus;
      };
      const requireUri = () => {
        if (!uri) {
          throw new FilesError(
            "Provider",
            "supabase: resumable upload has no session."
          );
        }
        return uri;
      };
      const authHeaders = (): Record<string, string> => ({
        Authorization: `Bearer ${requireTus().key}`,
        "Tus-Resumable": "1.0.0",
        apikey: requireTus().key,
      });
      return {
        adopt(session: ResumableUploadSession) {
          if (session.provider !== "supabase") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${session.provider} session on a supabase adapter.`
            );
          }
          if (session.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
          ({ uri } = session);
          ({ contentType } = session);
        },
        async begin(meta): Promise<ResumableUploadSession> {
          ({ contentType } = meta);
          const { endpoint } = requireTus();
          const res = await fetch(endpoint, {
            headers: {
              ...authHeaders(),
              "Upload-Length": String(meta.total),
              "Upload-Metadata": `bucketName ${b64(bucket)},objectName ${b64(key)},contentType ${b64(meta.contentType)}`,
              "x-upsert": "true",
            },
            method: "POST",
          });
          if (res.status !== 201) {
            throw new FilesError(
              "Provider",
              `supabase: resumable session init failed (HTTP ${res.status}).`
            );
          }
          const location = res.headers.get("location");
          if (!location) {
            throw new FilesError(
              "Provider",
              "supabase: resumable session response missing Location header"
            );
          }
          uri = location;
          return { contentType, key, provider: "supabase", uri };
        },
        complete(): Promise<UploadResult> {
          return Promise.resolve({ contentType, key, size: lastOffset });
        },
        async discard() {
          if (!uri) {
            return;
          }
          await fetch(uri, { headers: authHeaders(), method: "DELETE" });
        },
        mode: "offset",
        partSize:
          typeof resumableOpts.multipart === "object" &&
          resumableOpts.multipart.partSize
            ? resumableOpts.multipart.partSize
            : 6 * 1024 * 1024,
        async probe(): Promise<{ nextOffset: number }> {
          const res = await fetch(requireUri(), {
            headers: authHeaders(),
            method: "HEAD",
          });
          if (!res.ok) {
            throw new FilesError(
              "Provider",
              `supabase: resume status check failed (HTTP ${res.status}).`
            );
          }
          lastOffset = Number(res.headers.get("upload-offset") ?? 0);
          return { nextOffset: lastOffset };
        },
        async uploadAt({
          offset,
          data,
          signal,
        }): Promise<{ nextOffset: number }> {
          const res = await fetch(requireUri(), {
            body: data as unknown as BodyInit,
            headers: {
              ...authHeaders(),
              "Content-Type": "application/offset+octet-stream",
              "Upload-Offset": String(offset),
            },
            method: "PATCH",
            ...(signal && { signal }),
          });
          if (!res.ok) {
            throw new FilesError(
              "Provider",
              `supabase: chunk upload failed (HTTP ${res.status}).`
            );
          }
          lastOffset = Number(
            res.headers.get("upload-offset") ?? offset + data.byteLength
          );
          return { nextOffset: lastOffset };
        },
      };
    },
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // Supabase's createSignedUploadUrl has no `content-length-range`
      // equivalent — there's no way to enforce a max upload size at the
      // URL level. Throw rather than silently no-op so callers don't
      // ship a "limit" that does nothing. Same honest-API stance Azure
      // takes for the same gap.
      if (signOpts.maxSize !== undefined) {
        throw new FilesError(
          "Provider",
          "supabase: `maxSize` is not supported. Supabase signed upload URLs have no server-enforced size limit equivalent to S3's content-length-range policy. Set the bucket-level file size limit in the Supabase dashboard, or enforce the limit at your application gateway before issuing the signed URL."
        );
      }
      // `expiresIn` is intentionally ignored — Supabase fixes the TTL at
      // 2 hours server-side and offers no per-URL override.
      const { data, error } = await bucketRef.createSignedUploadUrl(key, {
        upsert: true,
      });
      if (error) {
        throw mapSupabaseError(error);
      }
      const { signedUrl } = data as { signedUrl: string; token: string };
      return {
        headers: {
          ...(signOpts.contentType && { "Content-Type": signOpts.contentType }),
          "x-upsert": "true",
        },
        method: "PUT",
        url: signedUrl,
      };
    },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    async upload(key, body, options) {
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const fileOptions = {
        contentType,
        upsert: true,
        ...(options?.cacheControl && { cacheControl: options.cacheControl }),
        ...(options?.metadata && { metadata: options.metadata }),
      };
      // Supabase requires `duplex: 'half'` when uploading a ReadableStream.
      // The SDK threads this through `FileOptions.duplex`.
      const optsWithDuplex =
        data instanceof ReadableStream
          ? { ...fileOptions, duplex: "half" }
          : fileOptions;
      const { error } = await bucketRef.upload(key, data, optsWithDuplex);
      if (error) {
        throw mapSupabaseError(error);
      }
      // For stream bodies we don't know the size locally; ask `info()`
      // for the authoritative value. For buffer bodies we already have it.
      let size = contentLength;
      let etag: string | undefined;
      let lastModified: number | undefined;
      if (size === undefined) {
        const info = await safeInfo(bucketRef, key);
        size = info?.size ?? 0;
        etag = stripEtag(info?.etag);
        lastModified = toMs(info?.lastModified);
      }
      return {
        contentType,
        ...(etag && { etag }),
        key,
        ...(lastModified !== undefined && { lastModified }),
        size,
      } satisfies UploadResult;
    },
    async url(key, urlOpts): Promise<string> {
      // Same precedence rule as S3/Azure: `responseContentDisposition`
      // forces signing even when a public URL is configured, because the
      // override has to be bound into the signature. Silently dropping
      // it would be a stored-XSS regression on user-uploaded content.
      const wantsDisposition = Boolean(urlOpts?.responseContentDisposition);
      if (publicBaseUrl && !wantsDisposition) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      if (isPublic && !wantsDisposition) {
        const { data } = bucketRef.getPublicUrl(key);
        return data.publicUrl;
      }
      // Both `public: true` (with disposition) and the default private
      // path mint a signed URL so the disposition can be bound in.
      const { data, error } = await bucketRef.createSignedUrl(
        key,
        urlOpts?.expiresIn ?? defaultUrlExpiresIn,
        {
          ...(urlOpts?.responseContentDisposition && {
            download: urlOpts.responseContentDisposition,
          }),
        }
      );
      if (error) {
        throw mapSupabaseError(error);
      }
      return (data as { signedUrl: string }).signedUrl;
    },
  };
};
