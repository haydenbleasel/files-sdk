import PocketBaseClient, { ClientResponseError } from "pocketbase";
import type { ListResult as PBListResult } from "pocketbase";

import type {
  Adapter,
  Body,
  ListOptions,
  ListResult,
  SignedUpload,
  SignUploadOptions,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import {
  collectStream,
  existsByProbe,
  makeErrorMapper,
  normalizeBody as coreNormalizeBody,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export interface PocketBaseAdapterOptions {
  /**
   * Collection name (or id) that holds the file records. Must already exist
   * with the configured `keyField` (unique-indexed text) and `fileField`
   * (single-value file). The adapter does not create or migrate the
   * collection — set it up via the PocketBase admin UI or migrations first.
   */
  collection: string;
  /**
   * Existing PocketBase client. Highest precedence — when passed, all auth
   * options below are ignored. Useful when the host app already shares one
   * client across auth, realtime, and storage.
   */
  client?: PocketBaseClient;
  /**
   * PocketBase backend URL (e.g. `https://pb.example.com`). Falls back to
   * `POCKETBASE_URL`.
   */
  url?: string;
  /**
   * Superuser email. Combined with `adminPassword` to auth as a superuser
   * before each session. Falls back to `POCKETBASE_ADMIN_EMAIL`.
   */
  adminEmail?: string;
  /**
   * Superuser password. Falls back to `POCKETBASE_ADMIN_PASSWORD`.
   */
  adminPassword?: string;
  /**
   * Pre-issued auth token. Saved into the client's `authStore` directly —
   * use this when you already have a token from elsewhere (e.g. an OAuth2
   * exchange or a custom user auth flow). Falls back to
   * `POCKETBASE_AUTH_TOKEN`. Mutually exclusive with the admin email/password
   * pair; if both are provided, the explicit token wins.
   */
  authToken?: string;
  /**
   * Name of the text field on the collection holding the user-facing key.
   * Must be unique-indexed. Defaults to `"key"`.
   */
  keyField?: string;
  /**
   * Name of the single-file field on the collection holding the body.
   * Defaults to `"file"`.
   */
  fileField?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips PocketBase's file URL entirely —
   * appropriate when a CDN sits in front of the PB instance. When unset,
   * `url()` falls back to `pb.files.getURL(record, filename)`.
   */
  publicBaseUrl?: string;
}

export type PocketBaseAdapter = Adapter<PocketBaseClient> & {
  readonly collection: string;
};

const DEFAULT_KEY_FIELD = "key";
const DEFAULT_FILE_FIELD = "file";
const DEFAULT_LIST_PER_PAGE = 30;

const POCKETBASE_NOT_FOUND_CODES: ReadonlySet<string> = new Set();
const POCKETBASE_UNAUTH_CODES: ReadonlySet<string> = new Set();
const POCKETBASE_CONFLICT_CODES: ReadonlySet<string> = new Set();

const _pocketBaseErrorMapper = makeErrorMapper({
  codes: {
    conflict: POCKETBASE_CONFLICT_CODES,
    notFound: POCKETBASE_NOT_FOUND_CODES,
    unauthorized: POCKETBASE_UNAUTH_CODES,
  },
  extract: (err) => {
    if (err instanceof ClientResponseError) {
      return {
        ...(err.message && { message: err.message }),
        ...(typeof err.status === "number" && { status: err.status }),
      };
    }
    const e = err as { message?: string; status?: number };
    return {
      ...(e?.message && { message: e.message }),
      ...(typeof e?.status === "number" && { status: e.status }),
    };
  },
  providerLabel: "PocketBase error",
});

export const mapPocketBaseError = (err: unknown): FilesError =>
  _pocketBaseErrorMapper(err);

interface FileRecord {
  id: string;
  // PocketBase records carry `created`/`updated` ISO strings, plus
  // collection-specific fields (the configured key + file fields). We don't
  // know their names at compile time, so widen the rest of the shape.
  [key: string]: unknown;
}

const buildClient = (opts: PocketBaseAdapterOptions): PocketBaseClient => {
  if (opts.client) {
    return opts.client;
  }
  const url = opts.url ?? readEnv("POCKETBASE_URL");
  if (!url) {
    throw new FilesError(
      "Provider",
      "pocketbase adapter: missing url. Pass `client` (an existing PocketBase instance), `url`, or set POCKETBASE_URL."
    );
  }
  return new PocketBaseClient(url);
};

const isSupportedBody = (body: unknown): body is Body =>
  typeof body === "string" ||
  body instanceof Uint8Array ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body) ||
  body instanceof Blob ||
  body instanceof ReadableStream;

// PocketBase's `create()` accepts FormData with a Blob/File field. SDK-level
// streaming is not supported, so streamed bodies must be drained up-front.
// Other Body shapes already arrive as `Uint8Array` from the shared helper.
const toUploadBlob = async (
  body: Body,
  contentTypeHint?: string
): Promise<{ blob: Blob; size: number; contentType: string }> => {
  if (!isSupportedBody(body)) {
    throw new FilesError(
      "Provider",
      "Unsupported body type for PocketBase adapter"
    );
  }
  const { data, contentType } = await coreNormalizeBody(body, contentTypeHint);
  const bytes =
    data instanceof ReadableStream ? await collectStream(data) : data;
  const blob = new Blob([bytes as BlobPart], { type: contentType });
  return { blob, contentType, size: bytes.byteLength };
};

// PocketBase filter syntax: `field = "value"`. Values must escape `"` and
// `\`. The SDK exposes `pb.filter()` for safe interpolation; we use it
// rather than hand-rolling escapes.
const keyFilter = (
  pb: PocketBaseClient,
  keyField: string,
  key: string
): string => pb.filter(`${keyField} = {:k}`, { k: key });

const prefixFilter = (
  pb: PocketBaseClient,
  keyField: string,
  prefix: string
): string => pb.filter(`${keyField} ~ {:p}`, { p: `${prefix}%` });

// PocketBase's `SendOptions` extends `RequestInit`, so it carries `signal`
// directly. Forward the operation's AbortSignal as a `SendOptions` arg; return
// `undefined` when there's no signal so we leave the call untouched.
const sendOpts = (
  signal: AbortSignal | undefined
): { signal: AbortSignal } | undefined => (signal ? { signal } : undefined);

export const pocketbase = (
  opts: PocketBaseAdapterOptions
): PocketBaseAdapter => {
  if (!opts.collection) {
    throw new FilesError(
      "Provider",
      "pocketbase adapter: missing collection. Pass `collection`."
    );
  }

  const pb = buildClient(opts);
  const keyField = opts.keyField ?? DEFAULT_KEY_FIELD;
  const fileField = opts.fileField ?? DEFAULT_FILE_FIELD;
  const { publicBaseUrl, collection } = opts;
  const records = () => pb.collection<FileRecord>(collection);

  // Auth is async but the adapter factory is sync. Defer auth to the first
  // call that needs it; subsequent calls reuse the same promise. We also
  // re-auth if the auth store becomes invalid (token expired).
  let authPromise: Promise<void> | undefined;
  const doAuth = async (): Promise<void> => {
    const explicitToken = opts.authToken ?? readEnv("POCKETBASE_AUTH_TOKEN");
    if (explicitToken) {
      pb.authStore.save(explicitToken, null);
      return;
    }
    const adminEmail = opts.adminEmail ?? readEnv("POCKETBASE_ADMIN_EMAIL");
    const adminPassword =
      opts.adminPassword ?? readEnv("POCKETBASE_ADMIN_PASSWORD");
    if (adminEmail && adminPassword) {
      // PocketBase v0.23+ moved admins into the `_superusers` collection.
      await pb
        .collection("_superusers")
        .authWithPassword(adminEmail, adminPassword);
    }
    // Otherwise no credentials supplied — leave the client unauthenticated
    // and rely on the collection's public access rules. Writes against a
    // protected collection will fail with a 4xx, which is surfaced as a
    // normal Unauthorized error.
  };
  const runAuthOnce = async (): Promise<void> => {
    try {
      await doAuth();
    } catch (error) {
      // Reset on failure so a transient auth error doesn't stick.
      authPromise = undefined;
      throw error;
    }
  };
  const ensureAuth = async (): Promise<void> => {
    if (pb.authStore.isValid) {
      return;
    }
    authPromise ??= runAuthOnce();
    await authPromise;
  };

  const findRecord = async (
    key: string,
    signal?: AbortSignal
  ): Promise<FileRecord> => {
    await ensureAuth();
    return records().getFirstListItem(
      keyFilter(pb, keyField, key),
      sendOpts(signal)
    );
  };

  const filenameOf = (record: FileRecord): string => {
    const raw = record[fileField];
    if (typeof raw !== "string" || !raw) {
      throw new FilesError(
        "Provider",
        `pocketbase: record ${record.id} has no file in field "${fileField}".`
      );
    }
    return raw;
  };

  const downloadBytes = async (
    record: FileRecord,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    const filename = filenameOf(record);
    // Pre-fetch a file token so private collections work. PocketBase's file
    // token endpoint requires auth; for fully-public collections an
    // unauthenticated client will get an error here, so swallow that and
    // fall back to the unsigned URL.
    let token: string | undefined;
    if (pb.authStore.isValid) {
      try {
        token = await pb.files.getToken(sendOpts(signal));
      } catch {
        // Token issuance failed — the collection may be fully public, in
        // which case the unsigned URL is sufficient. If not, the fetch
        // below will return a 4xx and we'll surface that instead.
      }
    }
    const url = pb.files.getURL(record, filename, token ? { token } : {});
    const res = await fetch(url, signal ? { signal } : undefined);
    if (!res.ok) {
      throw new FilesError(
        res.status === 404 ? "NotFound" : "Provider",
        `pocketbase: failed to download file "${filename}" — HTTP ${res.status}`,
        res
      );
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  const recordToStored = (record: FileRecord, key: string): StoredFile => {
    const filename = filenameOf(record);
    const lastModified = record.updated
      ? new Date(record.updated as string).getTime()
      : undefined;
    return createStoredFile(
      {
        key,
        ...(lastModified !== undefined &&
          Number.isFinite(lastModified) && { lastModified }),
        metadata: { filename, recordId: record.id },
        // PocketBase doesn't expose file size/type in the record JSON;
        // surface 0/octet-stream as the documented unknown values. Callers
        // that need exact size should call `.arrayBuffer()` or `.blob()`.
        size: 0,
        type: "application/octet-stream",
      },
      {
        factory: () => downloadBytes(record),
        kind: "lazy",
      }
    );
  };

  const assertSupportedUploadOptions = (options?: UploadOptions): void => {
    if (options?.cacheControl) {
      throw new FilesError(
        "Provider",
        "pocketbase: `cacheControl` is not supported. PocketBase does not expose HTTP cache headers on file content."
      );
    }
    if (options?.metadata && Object.keys(options.metadata).length > 0) {
      throw new FilesError(
        "Provider",
        "pocketbase: `metadata` is not supported. PocketBase record fields are typed and not arbitrary; drop to `raw` if you need additional fields on the record."
      );
    }
  };

  return {
    collection,
    async copy(from, to, operationOpts) {
      try {
        const source = await findRecord(from, operationOpts?.signal);
        const bytes = await downloadBytes(source, operationOpts?.signal);
        const filename = filenameOf(source);
        const formData = new FormData();
        formData.append(keyField, to);
        formData.append(
          fileField,
          new Blob([bytes as BlobPart], {
            type: "application/octet-stream",
          }),
          filename
        );
        await ensureAuth();
        await records().create(formData, sendOpts(operationOpts?.signal));
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
    async delete(key, operationOpts) {
      try {
        const record = await findRecord(key, operationOpts?.signal);
        await records().delete(record.id, sendOpts(operationOpts?.signal));
      } catch (error) {
        const mapped = mapPocketBaseError(error);
        // Delete is idempotent in the rest of the SDK; mirror that behavior
        // here so callers can safely call delete on missing keys.
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
    },
    async download(key, downloadOpts) {
      try {
        const record = await findRecord(key, downloadOpts?.signal);
        const bytes = await downloadBytes(record, downloadOpts?.signal);
        const updated =
          typeof record.updated === "string"
            ? new Date(record.updated).getTime()
            : undefined;
        return createStoredFile(
          {
            key,
            metadata: {
              filename: filenameOf(record),
              recordId: record.id,
            },
            size: bytes.byteLength,
            type: "application/octet-stream",
            ...(updated !== undefined &&
              Number.isFinite(updated) && { lastModified: updated }),
          },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
    exists(key, operationOpts) {
      return existsByProbe(
        () => findRecord(key, operationOpts?.signal),
        mapPocketBaseError
      );
    },
    async head(key, operationOpts) {
      try {
        const record = await findRecord(key, operationOpts?.signal);
        return recordToStored(record, key);
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
    async list(listOpts?: ListOptions): Promise<ListResult> {
      try {
        await ensureAuth();
        const perPage = listOpts?.limit ?? DEFAULT_LIST_PER_PAGE;
        const page = listOpts?.cursor
          ? Number.parseInt(listOpts.cursor, 10)
          : 1;
        if (!Number.isFinite(page) || page < 1) {
          throw new FilesError(
            "Provider",
            `pocketbase: invalid list cursor "${listOpts?.cursor}" — expected a positive integer page number.`
          );
        }
        const filter = listOpts?.prefix
          ? prefixFilter(pb, keyField, listOpts.prefix)
          : "";
        const response: PBListResult<FileRecord> = await records().getList(
          page,
          perPage,
          {
            sort: keyField,
            ...(filter && { filter }),
            ...(listOpts?.signal && { signal: listOpts.signal }),
          }
        );
        const items = response.items.map((record) =>
          recordToStored(record, (record[keyField] as string) ?? record.id)
        );
        const nextCursor =
          response.page < response.totalPages
            ? String(response.page + 1)
            : undefined;
        return {
          items,
          ...(nextCursor !== undefined && { cursor: nextCursor }),
        };
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
    name: "pocketbase",
    raw: pb,
    signedUploadUrl(
      _key: string,
      _signOpts: SignUploadOptions
    ): Promise<SignedUpload> {
      return Promise.reject(
        new FilesError(
          "Provider",
          "pocketbase: signedUploadUrl is not supported. PocketBase has no presigned upload primitive — uploads always go through the authenticated API; mint a short-lived auth token for the client instead."
        )
      );
    },
    async upload(
      key: string,
      body: Body,
      uploadOpts?: UploadOptions
    ): Promise<UploadResult> {
      assertSupportedUploadOptions(uploadOpts);
      try {
        const { blob, contentType, size } = await toUploadBlob(
          body,
          uploadOpts?.contentType
        );
        await ensureAuth();

        // Use the key as the filename hint so PocketBase's server-side
        // rename keeps a reasonable basename. PB will still apply its own
        // random suffix for collision avoidance; the canonical filename is
        // returned in the created record's file field.
        const filename = key.split("/").pop() || key;

        let existing: FileRecord | undefined;
        try {
          existing = await records().getFirstListItem(
            keyFilter(pb, keyField, key),
            sendOpts(uploadOpts?.signal)
          );
        } catch (error) {
          if (!(error instanceof ClientResponseError) || error.status !== 404) {
            throw error;
          }
        }

        let record: FileRecord;
        if (existing) {
          const formData = new FormData();
          formData.append(fileField, blob, filename);
          record = await records().update(
            existing.id,
            formData,
            sendOpts(uploadOpts?.signal)
          );
        } else {
          const formData = new FormData();
          formData.append(keyField, key);
          formData.append(fileField, blob, filename);
          record = await records().create(
            formData,
            sendOpts(uploadOpts?.signal)
          );
        }

        const lastModified = record.updated
          ? new Date(record.updated as string).getTime()
          : undefined;
        return {
          contentType,
          key,
          size,
          ...(lastModified !== undefined &&
            Number.isFinite(lastModified) && { lastModified }),
        } satisfies UploadResult;
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
    async url(key: string, urlOpts?: UrlOptions): Promise<string> {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "pocketbase: `responseContentDisposition` is not supported. PocketBase has no per-URL Content-Disposition override; use the `?download=true` query string on the URL itself (passthrough via `adapter.raw`) for forced-download behavior."
        );
      }
      if (publicBaseUrl) {
        const trimmed = publicBaseUrl.endsWith("/")
          ? publicBaseUrl.slice(0, -1)
          : publicBaseUrl;
        return `${trimmed}/${encodeURIComponent(key)}`;
      }
      try {
        const record = await findRecord(key, urlOpts?.signal);
        const filename = filenameOf(record);
        let token: string | undefined;
        if (pb.authStore.isValid) {
          try {
            token = await pb.files.getToken(sendOpts(urlOpts?.signal));
          } catch {
            // Token issuance failed — fall back to unsigned URL. If the
            // collection requires auth, the URL will 4xx when fetched.
          }
        }
        return pb.files.getURL(record, filename, token ? { token } : {});
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
  };
};
