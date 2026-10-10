import PocketBaseClient, { ClientResponseError } from "pocketbase";
import type { ListResult as PBListResult } from "pocketbase";

import type {
  Adapter,
  Body,
  ByteRange,
  FileInfo,
  ListOptions,
  ListResult,
  SignedUpload,
  SignUploadOptions,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import {
  assertRangeHonored,
  collectStream,
  existsByProbe,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody as coreNormalizeBody,
  rangeRequestHeaders,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError, dispositionUnsupported } from "../internal/errors.js";
import { isNumber, isObject, isString } from "../internal/is.js";
import type { JsonObject } from "../internal/json.js";
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
   * exchange or a custom user auth flow). Mutually exclusive with the admin
   * email/password pair; if both are provided, this token wins. Falls back to
   * `POCKETBASE_AUTH_TOKEN`, which is used ahead of `POCKETBASE_ADMIN_EMAIL` /
   * `POCKETBASE_ADMIN_PASSWORD` but never ahead of `adminEmail` /
   * `adminPassword` passed as options.
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
   * `url()` falls back to `pb.files.getURL(record, filename)`. A permanent
   * link can't expire, so with it set `url(key, { expiresIn })` throws
   * `Unsupported`.
   */
  publicBaseUrl?: string;
}

export type PocketBaseAdapter = Adapter<PocketBaseClient> & {
  readonly collection: string;
};

const OCTET_STREAM = "application/octet-stream";
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
        ...(isNumber(err.status) && { status: err.status }),
      };
    }
    // Not the SDK's error class (a transport error, or a test double) — read
    // the same two fields only once their types are established.
    if (!isObject(err)) {
      return {};
    }
    const message =
      "message" in err && isString(err.message) ? err.message : undefined;
    const status =
      "status" in err && isNumber(err.status) ? err.status : undefined;
    return {
      ...(message && { message }),
      ...(status !== undefined && { status }),
    };
  },
  providerLabel: "PocketBase error",
});

export const mapPocketBaseError = (cause: unknown): FilesError =>
  _pocketBaseErrorMapper(cause);

// A PocketBase record is decoded JSON: `id` plus `created`/`updated` ISO
// strings, plus the collection-specific fields (the configured key + file
// fields) whose names are only known at runtime — hence the JSON index
// signature; reads of those go through `isString`.
interface FileRecord extends JsonObject {
  id: string;
  updated?: string;
}

const buildClient = (opts: PocketBaseAdapterOptions): PocketBaseClient => {
  if (opts.client) {
    return opts.client;
  }
  const url = opts.url ?? readEnv("POCKETBASE_URL");
  if (!url) {
    throw new FilesError(
      "Invalid",
      "pocketbase adapter: missing url. Pass `client` (an existing PocketBase instance), `url`, or set POCKETBASE_URL."
    );
  }
  return new PocketBaseClient(url);
};

// Runtime guard for untyped (JS) callers: `Body` is already the static type.
const isSupportedBody = (body: Body): boolean =>
  // oxlint-disable-next-line sonarjs/expression-complexity -- a flat body-type guard; each instanceof check is a distinct supported Body shape, splitting would just scatter the union
  isString(body) ||
  body instanceof Uint8Array ||
  body instanceof ArrayBuffer ||
  ArrayBuffer.isView(body) ||
  body instanceof Blob ||
  body instanceof ReadableStream;

interface UploadBlob {
  blob: Blob;
  size: number;
  contentType: string;
}

// PocketBase's `create()` accepts FormData with a Blob/File field. SDK-level
// streaming is not supported, so streamed bodies must be drained up-front.
// Other Body shapes already arrive as `Uint8Array` from the shared helper.
const toUploadBlob = async (
  body: Body,
  contentTypeHint?: string
): Promise<UploadBlob> => {
  if (!isSupportedBody(body)) {
    throw new FilesError(
      "Invalid",
      "Unsupported body type for PocketBase adapter"
    );
  }
  const { data, contentType } = await coreNormalizeBody(body, contentTypeHint);
  const bytes =
    data instanceof ReadableStream ? await collectStream(data) : data;
  // SAFETY: `BlobPart` pins the view to `ArrayBuffer` backing (TS 5.7 widened
  // typed arrays to `ArrayBufferLike`). `bytes` is freshly allocated by
  // `normalizeBody`/`collectStream` or is the caller's own `Body` view, which
  // the SDK documents as plain upload bytes.
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

// A superset of the keys under `prefix`, not an exact match: PocketBase runs
// `~` as SQL LIKE, so `_` / `%` in the prefix act as wildcards and ASCII
// letters match case-insensitively. Escaping the wildcards depends on the
// server's filter-parser version, so `list()` narrows the page client-side
// with a case-sensitive `startsWith` instead.
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
      "Invalid",
      "pocketbase adapter: missing collection. Pass `collection`."
    );
  }

  const pb = buildClient(opts);
  const keyField = opts.keyField ?? DEFAULT_KEY_FIELD;
  const fileField = opts.fileField ?? DEFAULT_FILE_FIELD;
  const { publicBaseUrl, collection } = opts;
  const records = () => pb.collection<FileRecord>(collection);

  // Auth is async but the adapter factory is sync. Defer auth to the first
  // call that needs it. Concurrent callers share the one in-flight attempt;
  // the slot clears once it settles, so a token that later expires (the auth
  // store reports it invalid) triggers a fresh login on the next call.
  let authPromise: Promise<void> | undefined;
  const doAuth = async (): Promise<void> => {
    // Precedence: the `authToken` option, then admin credentials passed as
    // options, then `POCKETBASE_AUTH_TOKEN`, then the admin env vars. Options
    // beat the environment, so a stale token left in the env can't shadow
    // credentials passed in code.
    if (opts.authToken) {
      pb.authStore.save(opts.authToken, null);
      return;
    }
    const adminEmail = opts.adminEmail ?? readEnv("POCKETBASE_ADMIN_EMAIL");
    const adminPassword =
      opts.adminPassword ?? readEnv("POCKETBASE_ADMIN_PASSWORD");
    const explicitAdmin =
      opts.adminEmail !== undefined || opts.adminPassword !== undefined;
    const envToken = readEnv("POCKETBASE_AUTH_TOKEN");
    if (envToken && !(explicitAdmin && adminEmail && adminPassword)) {
      pb.authStore.save(envToken, null);
      return;
    }
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
    } finally {
      // Clear on success too, not just failure: a resolved promise kept here
      // would short-circuit every later login, leaving calls unauthenticated
      // once the superuser token expires.
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined clears the memoized auth promise so the next call re-auths; null would be a cached value
      authPromise = undefined;
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
    if (!isString(raw) || !raw) {
      // The record answered but carries no single filename where the adapter
      // was told to look — a `fileField` that isn't the collection's
      // single-file field, or a record with no file. Re-fetching returns the
      // same record, so it's a deterministic `Invalid`, never retried.
      throw new FilesError(
        "Invalid",
        `pocketbase: record ${record.id} has no file in field "${fileField}". Check that \`fileField\` names the collection's single-file field and that the record has a file.`
      );
    }
    return raw;
  };

  const downloadBody = async (
    record: FileRecord,
    signal?: AbortSignal,
    range?: ByteRange
  ): Promise<{ bytes: Uint8Array; type: string }> => {
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
    const res = await fetch(url, {
      ...(signal && { signal }),
      ...(range && { headers: rangeRequestHeaders(range) }),
    });
    if (!res.ok) {
      // Classify like the SDK calls (404 NotFound, 401/403 Unauthorized) so
      // a refused file token isn't retried as a transient Provider error.
      const { code } = mapPocketBaseError({ status: res.status });
      throw new FilesError(
        code,
        `pocketbase: failed to download file "${filename}" — HTTP ${res.status}`,
        res
      );
    }
    if (range) {
      assertRangeHonored(res.status, "pocketbase");
    }
    // The record carries no content type; the file server's response does.
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      type: res.headers.get("content-type") || OCTET_STREAM,
    };
  };

  const downloadBytes = async (
    record: FileRecord,
    signal?: AbortSignal
  ): Promise<Uint8Array> => {
    const { bytes } = await downloadBody(record, signal);
    return bytes;
  };

  const recordToInfo = (record: FileRecord, key: string): FileInfo => {
    const filename = filenameOf(record);
    const lastModified = record.updated
      ? new Date(record.updated).getTime()
      : undefined;
    return {
      // PocketBase doesn't expose file size/type in the record JSON; surface
      // 0/octet-stream as the documented unknown values. Callers that need
      // the exact size or type `download()` the key.
      contentType: OCTET_STREAM,
      key,
      ...(lastModified !== undefined &&
        Number.isFinite(lastModified) && { lastModified }),
      metadata: { filename, recordId: record.id },
      size: 0,
    };
  };

  // Write `blob` as the file for `key`: replace the file on the key's existing
  // record, or create one. `keyField` is unique-indexed, so a second
  // `create()` for a key fails validation rather than overwriting — both
  // `upload()` and `copy()` need overwrite semantics.
  const putRecord = async (
    key: string,
    blob: Blob,
    filename: string,
    signal?: AbortSignal
  ): Promise<FileRecord> => {
    let existing: FileRecord | undefined;
    try {
      existing = await records().getFirstListItem(
        keyFilter(pb, keyField, key),
        sendOpts(signal)
      );
    } catch (error) {
      if (!(error instanceof ClientResponseError) || error.status !== 404) {
        throw error;
      }
    }
    const formData = new FormData();
    if (existing) {
      formData.append(fileField, blob, filename);
      return records().update(existing.id, formData, sendOpts(signal));
    }
    formData.append(keyField, key);
    formData.append(fileField, blob, filename);
    return records().create(formData, sendOpts(signal));
  };

  // One list page as FileInfos. The server-side `~` filter is a superset
  // (see `prefixFilter`), so the exact, case-sensitive prefix match happens
  // here — a page can hold fewer than `limit` items after the narrowing.
  const pageItems = (
    pageRecords: FileRecord[],
    prefix: string | undefined
  ): FileInfo[] => {
    const items: FileInfo[] = [];
    for (const record of pageRecords) {
      const recordKey = record[keyField];
      const key = isString(recordKey) ? recordKey : record.id;
      if (!prefix || key.startsWith(prefix)) {
        items.push(recordToInfo(record, key));
      }
    }
    return items;
  };

  return {
    capabilities: {
      // With `publicBaseUrl`, `url()` returns a permanent CDN link.
      publicUrl: Boolean(publicBaseUrl),
      rangeRead: true,
      // No server-side copy — `copy()` downloads then re-uploads to the dest key.
      serverSideCopy: false,
      // `url()` returns a file-token URL for protected collections (the token's
      // TTL is server-controlled, so `expiresIn` is advisory — see
      // provider-gaps). With `publicBaseUrl` it returns a permanent link
      // instead, unsigned, so an explicit `expiresIn` is refused by the core
      // gate. No URL carries a Content-Disposition override (`url()` throws).
      signedUrl: {
        disposition: false,
        expiry: "provider",
        supported: !publicBaseUrl,
      },
    },
    collection,
    async copy(from, to, operationOpts) {
      try {
        const source = await findRecord(from, operationOpts?.signal);
        const bytes = await downloadBytes(source, operationOpts?.signal);
        const filename = filenameOf(source);
        // SAFETY: `bytes` was just read from PocketBase into a fresh
        // `Uint8Array` over its own `ArrayBuffer`, so the view satisfies
        // `BlobPart`'s `ArrayBuffer`-backing requirement.
        const copy = new Blob([bytes as BlobPart], { type: OCTET_STREAM });
        await ensureAuth();
        await putRecord(to, copy, filename, operationOpts?.signal);
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
        const { bytes, type } = await downloadBody(
          record,
          downloadOpts?.signal,
          downloadOpts?.range
        );
        const updated = isString(record.updated)
          ? new Date(record.updated).getTime()
          : undefined;
        return createStoredFile(
          {
            contentType: type,
            key,
            metadata: {
              filename: filenameOf(record),
              recordId: record.id,
            },
            size: bytes.byteLength,
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
        return recordToInfo(record, key);
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
    async list(listOpts?: ListOptions): Promise<ListResult> {
      try {
        await ensureAuth();
        const perPage = listOpts?.limit ?? DEFAULT_LIST_PER_PAGE;
        const page = listOpts?.cursor
          ? // oxlint-disable-next-line unicorn/prefer-number-coercion -- explicit radix-10 parse of a numeric page cursor is clearer than Math.trunc(Number(...))
            Number.parseInt(listOpts.cursor, 10)
          : 1;
        if (!Number.isFinite(page) || page < 1) {
          throw new FilesError(
            "Invalid",
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
        const items = pageItems(response.items, listOpts?.prefix);
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
          "Unsupported",
          "pocketbase: signedUploadUrl is not supported. PocketBase has no presigned upload primitive — uploads always go through the authenticated API; mint a short-lived auth token for the client instead."
        )
      );
    },
    async upload(
      key: string,
      body: Body,
      uploadOpts?: UploadOptions
    ): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — PocketBase record fields are typed,
      // not arbitrary, and it exposes no cache-header field.
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

        const record = await putRecord(key, blob, filename, uploadOpts?.signal);

        const lastModified = record.updated
          ? new Date(record.updated).getTime()
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
        throw dispositionUnsupported(
          "pocketbase: `responseContentDisposition` is not supported. PocketBase has no per-URL Content-Disposition override; use the `?download=true` query string on the URL itself (passthrough via `adapter.raw`) for forced-download behavior."
        );
      }
      if (publicBaseUrl) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      try {
        const record = await findRecord(key, urlOpts?.signal);
        const filename = filenameOf(record);
        let token: string | undefined;
        let tokenError: unknown;
        if (pb.authStore.isValid) {
          try {
            token = await pb.files.getToken(sendOpts(urlOpts?.signal));
          } catch (error) {
            // Token issuance failed — fall back to unsigned URL. If the
            // collection requires auth, the URL will 4xx when fetched.
            tokenError = error;
          }
        }
        // Only a file token expires. Without one the URL is permanent, so an
        // explicit `expiresIn` can't be honored — fail rather than hand back a
        // link that outlives what was asked.
        if (urlOpts?.expiresIn !== undefined && !token) {
          if (tokenError !== undefined) {
            throw tokenError;
          }
          throw new FilesError(
            "Unsupported",
            "pocketbase: an expiring url() (`expiresIn`) needs an authenticated client to mint a file token; this one has no auth, so its URLs don't expire"
          );
        }
        return pb.files.getURL(record, filename, token ? { token } : {});
      } catch (error) {
        throw mapPocketBaseError(error);
      }
    },
  };
};
