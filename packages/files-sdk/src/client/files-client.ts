// `createFilesClient` — the framework-agnostic browser/Node client that mirrors
// the whole `Files` verb set over the gateway endpoint. One method per verb maps
// to a JSON POST (or the download GET / upload PUT byte paths). React/Vue/Svelte
// wrap this; it never touches React or `window` at module scope. `download`
// returns the same lazy `StoredFile` the server SDK returns.

import pMap from "p-map";

import type {
  AdapterCapabilities,
  BulkError,
  StoredFile,
  UploadResult,
} from "../index.js";
import { assertRangeHonored, makeErrorMapper } from "../internal/core.js";
import type { FilesErrorCode } from "../internal/errors.js";
import { FilesError } from "../internal/errors.js";
import type {
  CompleteResponse,
  PresignedUpload,
  SignedUploadUrlResponse,
  WireBulkError,
  WireFilesError,
  WireStoredFile,
} from "../internal/files-router/protocol.js";
import { isFunction, isObject, isString } from "../internal/is.js";
import type { JsonObject, JsonValue } from "../internal/json.js";
import { createStoredFile } from "../internal/stored-file.js";
import { decodeDownload } from "./download-decode.js";
import type { FileUploadState } from "./progress.js";
import { aggregate, fileName, initialState } from "./progress.js";
import { defaultTransport } from "./transport.js";
import type {
  BulkCallOptions,
  DownloadCallOptions,
  FileVersion,
  FilesClient,
  FilesClientConfig,
  ListCallOptions,
  NativeFileRef,
  SearchCallOptions,
  SignUploadCallOptions,
  TrashedFile,
  UploadBody,
  UploadCallOptions,
  UploadManyCallOptions,
  UploadManyClientItem,
  UploadOutcome,
  UploadProgressCallback,
  UrlCallOptions,
} from "./types.js";
import { isNativeFileRef } from "./types.js";

const DEFAULT_ENDPOINT = "/api/files";
const DEFAULT_CONCURRENCY = 4;

const mapCode = (code: string): FilesErrorCode => {
  switch (code) {
    case "NotFound": {
      return "NotFound";
    }
    case "Unauthorized":
    case "Forbidden": {
      return "Unauthorized";
    }
    case "Conflict": {
      return "Conflict";
    }
    case "ReadOnly": {
      return "ReadOnly";
    }
    // The gateway's request validation, and an SDK `Invalid` error (which
    // bulk results carry by their own code).
    case "Invalid":
    case "Validation": {
      return "Invalid";
    }
    case "Unsupported": {
      return "Unsupported";
    }
    // Includes any code a newer gateway adds, so an older client degrades
    // to the generic failure instead of crashing.
    default: {
      return "Provider";
    }
  }
};

const reviveError = (wire: WireFilesError): FilesError =>
  new FilesError(mapCode(wire.code), wire.message, undefined, {
    aborted: wire.aborted,
    timedOut: wire.timedOut,
  });

const reviveBulk = (errors?: WireBulkError[]): BulkError[] | undefined =>
  errors?.length
    ? errors.map((e) => ({ error: reviveError(e.error), key: e.key }))
    : undefined;

const withErrors = <T extends object>(base: T, errors?: WireBulkError[]): T => {
  const revived = reviveBulk(errors);
  return revived ? { ...base, errors: revived } : base;
};

// A download the gateway redirected fails at the storage host, whose error
// body isn't the gateway's envelope: classify it by HTTP status the way an
// adapter would (a missing key is `NotFound`, a refused or expired signature
// `Unauthorized`), not as a generic `Provider` failure.
const storageError = makeErrorMapper({
  codes: { conflict: new Set(), notFound: new Set(), unauthorized: new Set() },
  extract: (cause) => {
    const status = cause instanceof Response ? cause.status : undefined;
    return { message: `storage responded ${String(status)}`, status };
  },
  providerLabel: "files-sdk/client",
});

/** The gateway's failure envelope (see `toErrorResult`). */
interface ErrorEnvelope {
  error?: WireFilesError;
}

interface NormalizedBody {
  body: Blob | Uint8Array<ArrayBuffer>;
  size: number;
  type: string;
}

const fromBlob = (blob: Blob): NormalizedBody => ({
  body: blob,
  size: blob.size,
  type: blob.type,
});

// SAFETY: Blob parts and request bodies (BufferSource) reject
// SharedArrayBuffer-backed views, so an upload body's `.buffer` is a plain
// ArrayBuffer; `ArrayBufferLike` only widens for the shared-memory case the
// platform refuses at the send site anyway.
const asBytes = (
  body: ArrayBuffer | ArrayBufferView
): Uint8Array<ArrayBuffer> =>
  body instanceof ArrayBuffer
    ? new Uint8Array(body)
    : new Uint8Array(
        body.buffer as ArrayBuffer,
        body.byteOffset,
        body.byteLength
      );

// Refs are excluded: every caller resolves a `NativeFileRef` to a Blob before
// normalizing (raw request bodies always need real bytes).
const toBody = (
  body: Exclude<UploadBody, NativeFileRef>,
  contentType?: string
): NormalizedBody => {
  if (body instanceof Blob) {
    return fromBlob(
      contentType && body.type !== contentType
        ? new Blob([body], { type: contentType })
        : body
    );
  }
  if (isString(body)) {
    return fromBlob(
      new Blob([body], contentType ? { type: contentType } : undefined)
    );
  }
  const bytes = asBytes(body);
  try {
    return fromBlob(
      new Blob([bytes], contentType ? { type: contentType } : undefined)
    );
  } catch {
    // React Native's Blob cannot be constructed from ArrayBuffer parts; the
    // transports accept raw bytes, so pass them through instead.
    return { body: bytes, size: bytes.byteLength, type: contentType ?? "" };
  }
};

// --- upload state lifecycle ---

const isAbortFailure = (
  cause: unknown,
  signal: AbortSignal | undefined
): boolean =>
  signal?.aborted === true ||
  (cause instanceof FilesError && cause.aborted) ||
  (isObject(cause) && "name" in cause && cause.name === "AbortError");

const settleFailed = (
  state: FileUploadState,
  cause: unknown,
  signal: AbortSignal | undefined
): void => {
  state.status = isAbortFailure(cause, signal) ? "aborted" : "error";
  state.error = FilesError.wrap(cause);
};

const settleSucceeded = (state: FileUploadState, key: string): void => {
  state.status = "success";
  state.key = key;
  state.loaded = state.total;
  state.progress = 1;
};

const applyBytes = (
  state: FileUploadState,
  loaded: number,
  total: number
): void => {
  state.loaded = loaded;
  state.total = total || state.size;
  state.progress = state.total ? loaded / state.total : 0;
};

/** One file's state plus the callback that reports it (with its batch). */
interface Tracked {
  state: FileUploadState;
  report: () => void;
}

const trackOne = (
  state: FileUploadState,
  onProgress: UploadProgressCallback | undefined
): Tracked => {
  const states = [state];
  return {
    report: () => onProgress?.(aggregate(states), states),
    state,
  };
};

/** A keyed upload body, normalized where that can happen synchronously. */
type Prepared =
  | { ref: NativeFileRef; norm?: undefined }
  | { ref?: undefined; norm: NormalizedBody };

const prepare = (body: UploadBody, contentType?: string): Prepared =>
  isNativeFileRef(body) ? { ref: body } : { norm: toBody(body, contentType) };

const keyedState = (key: string, prepared: Prepared): FileUploadState => {
  const state = initialState(prepared.ref ?? prepared.norm.body);
  state.key = key;
  if (prepared.norm?.type) {
    state.type = prepared.norm.type;
  }
  return state;
};

export const createFilesClient = (
  config: FilesClientConfig = {}
): FilesClient => {
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = config.fetchImpl ?? fetch;
  const transport = config.transport ?? defaultTransport(fetchImpl);
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const sep = endpoint.includes("?") ? "&" : "?";

  // Read a React Native picker asset into a Blob — needed whenever the bytes
  // themselves must be sent (raw PUT bodies); only the presigned-POST path can
  // stream the descriptor via RN's FormData without touching the bytes.
  const resolveRef = async (ref: NativeFileRef): Promise<Blob> => {
    const res = await fetchImpl(ref.uri);
    if (!res.ok) {
      throw new FilesError(
        "Provider",
        `could not read upload source ${ref.uri} (${res.status})`
      );
    }
    return res.blob();
  };

  const resolveHeaders = async (): Promise<Record<string, string>> => {
    const raw = isFunction(config.headers)
      ? await config.headers()
      : config.headers;
    return raw ? Object.fromEntries(new Headers(raw).entries()) : {};
  };

  const wireError = async (res: Response): Promise<FilesError> => {
    try {
      // SAFETY: a non-OK gateway response carries the `{ error: WireFilesError }`
      // envelope `toErrorResult` serializes; `error?.code` guards the read, and
      // any other body (a proxy error page) falls through to the generic error.
      const body = (await res.json()) as ErrorEnvelope;
      if (body.error?.code) {
        return reviveError(body.error);
      }
    } catch {
      // fall through
    }
    return res.redirected
      ? storageError(res)
      : new FilesError("Provider", `gateway responded ${res.status}`);
  };

  const post = async <T>(
    payload: JsonObject,
    signal?: AbortSignal
  ): Promise<T> => {
    const res = await fetchImpl(endpoint, {
      body: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        ...(await resolveHeaders()),
      },
      method: "POST",
      signal,
    });
    if (!res.ok) {
      throw await wireError(res);
    }
    // SAFETY: a 2xx gateway response is the success envelope of the JSON op
    // named in `payload.op` — the wire shape `T` each caller pins from
    // `protocol.ts`; failures were already raised as `FilesError` above.
    return (await res.json()) as T;
  };

  const downloadOne = async (
    key: string,
    opts?: DownloadCallOptions
  ): Promise<StoredFile> => {
    const headers = await resolveHeaders();
    if (opts?.range) {
      headers.range = `bytes=${opts.range.start}-${opts.range.end ?? ""}`;
    }
    const res = await fetchImpl(
      `${endpoint}${sep}op=download&key=${encodeURIComponent(key)}`,
      { headers, method: "GET", signal: opts?.signal }
    );
    if (!res.ok) {
      throw await wireError(res);
    }
    if (opts?.range) {
      // A gateway or storage host that ignores `Range` answers 200 with the
      // whole object; never hand that back as if it were the slice.
      assertRangeHonored(res.status, "files-sdk/client");
    }
    return decodeDownload(res, key);
  };

  const toStoredFile = (wire: WireStoredFile): StoredFile =>
    createStoredFile(
      {
        etag: wire.etag,
        key: wire.key,
        lastModified: wire.lastModified,
        metadata: wire.metadata,
        size: wire.size,
        type: wire.type,
      },
      {
        factory: async () => {
          const file = await downloadOne(wire.key);
          return new Uint8Array(await file.arrayBuffer());
        },
        kind: "lazy",
      }
    );

  // --- upload paths ---

  // The through-endpoint upload answers with the op's JSON body on 2xx and the
  // `{ error: WireFilesError }` envelope otherwise; `undefined` = no parseable
  // body (a proxy error page), which is reported generically.
  const handleEndpointResult = <T>(status: number, text: string): T => {
    let body: JsonValue | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = no parseable body; null would be a distinct wire value
      body = undefined;
    }
    if (status < 200 || status >= 300) {
      // SAFETY: a non-2xx gateway body is the `{ error }` envelope from
      // `toErrorResult`; a missing `error` (foreign body) takes the generic path.
      const error = (body as ErrorEnvelope | undefined)?.error;
      throw error
        ? reviveError(error)
        : new FilesError("Provider", `upload failed (${status})`);
    }
    // SAFETY: a 2xx body is the success envelope of the upload op — the wire
    // shape `T` the caller pins from `protocol.ts`.
    return body as T;
  };

  const sendToTarget = async (
    target: PresignedUpload["target"],
    body: Blob | NativeFileRef,
    signal: AbortSignal | undefined,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> => {
    const result = await transport({
      body,
      method: target.method,
      onProgress,
      signal,
      url: target.url,
      ...(target.method === "PUT"
        ? { headers: target.headers }
        : { fields: target.fields }),
    });
    if (result.status < 200 || result.status >= 300) {
      throw new FilesError("Provider", `upload failed (${result.status})`);
    }
  };

  // The keyless 3-step upload (presign → bytes → complete). `tracked.state`
  // is reported "uploading" up front and settles on every path.
  const uploadKeyless = async (
    file: Blob | NativeFileRef,
    opts?: UploadCallOptions
  ): Promise<UploadOutcome> => {
    const type = opts?.contentType || file.type || "application/octet-stream";
    const { report, state } = trackOne(initialState(file), opts?.onProgress);
    state.type = type;
    state.status = "uploading";
    report();
    try {
      const presign = await post<{ uploads: PresignedUpload[] }>(
        {
          files: [{ name: fileName(file), size: file.size ?? 0, type }],
          op: "presign",
          ...(opts?.expiresIn && { expiresIn: opts.expiresIn }),
        },
        opts?.signal
      );
      const [first] = presign.uploads;
      if (!first) {
        throw new FilesError("Provider", "presign returned no upload target");
      }
      const { id, key, target } = first;
      state.key = key;

      // A descriptor can ride RN's FormData only on a POST target; a raw PUT
      // needs the actual bytes, so resolve the uri to a Blob first.
      const body =
        isNativeFileRef(file) && target.method === "PUT"
          ? await resolveRef(file)
          : file;

      await sendToTarget(target, body, opts?.signal, (loaded, total) => {
        applyBytes(state, loaded, total);
        report();
      });

      const complete = await post<CompleteResponse>(
        { completions: [{ id, key }], op: "complete" },
        opts?.signal
      );
      const [done] = complete.files;
      if (!done) {
        const error = complete.errors?.[0];
        throw error
          ? reviveError(error.error)
          : new FilesError("Provider", "upload did not complete");
      }
      settleSucceeded(state, done.key);
      report();
      return {
        etag: done.etag,
        key: done.key,
        lastModified: done.lastModified,
        size: done.size,
        type: done.type,
      };
    } catch (error) {
      settleFailed(state, error, opts?.signal);
      report();
      throw error;
    }
  };

  // One explicit-key PUT through the endpoint, driving `tracked.state` from
  // "uploading" to a terminal status on every path.
  const putExplicit = async (
    key: string,
    prepared: Prepared,
    opts: UploadCallOptions | undefined,
    tracked: Tracked
  ): Promise<UploadOutcome> => {
    const { report, state } = tracked;
    state.status = "uploading";
    report();
    try {
      // The through-endpoint is a raw PUT, so a picker ref becomes a Blob
      // here; its declared type fills in when no explicit contentType is given.
      const norm = prepared.ref
        ? toBody(
            await resolveRef(prepared.ref),
            opts?.contentType ?? prepared.ref.type
          )
        : prepared.norm;
      state.size = norm.size;
      state.total = norm.size;
      const result = await transport({
        body: norm.body,
        headers: {
          "content-type": norm.type || "application/octet-stream",
          ...(await resolveHeaders()),
        },
        method: "PUT",
        onProgress: (loaded, total) => {
          applyBytes(state, loaded, total);
          report();
        },
        signal: opts?.signal,
        url: `${endpoint}${sep}op=upload&key=${encodeURIComponent(key)}`,
      });
      const parsed = handleEndpointResult<{ file: UploadOutcome }>(
        result.status,
        result.text
      );
      settleSucceeded(state, parsed.file.key);
      report();
      return parsed.file;
    } catch (error) {
      settleFailed(state, error, opts?.signal);
      report();
      throw error;
    }
  };

  const uploadExplicit = (
    key: string,
    body: UploadBody,
    opts?: UploadCallOptions
  ): Promise<UploadOutcome> => {
    const prepared = prepare(body, opts?.contentType);
    return putExplicit(
      key,
      prepared,
      opts,
      trackOne(keyedState(key, prepared), opts?.onProgress)
    );
  };

  const uploadMany = async (
    items: UploadManyClientItem[],
    opts?: UploadManyCallOptions
  ) => {
    // Every item gets its state up front, so the batch reports as one list.
    const entries = items.map((item) => {
      const prepared = prepare(item.body, item.contentType);
      return { item, prepared, state: keyedState(item.key, prepared) };
    });
    const states = entries.map((entry) => entry.state);
    const report = () => opts?.onProgress?.(aggregate(states), states);
    let results;
    try {
      results = await pMap(
        entries,
        async ({ item, prepared, state }) => {
          try {
            const out = await putExplicit(
              item.key,
              prepared,
              { contentType: item.contentType, signal: opts?.signal },
              { report, state }
            );
            return { ok: true as const, out };
          } catch (error) {
            if (opts?.stopOnError) {
              throw error;
            }
            return {
              error: FilesError.wrap(error),
              key: item.key,
              ok: false as const,
            };
          }
        },
        { concurrency: opts?.concurrency ?? concurrency }
      );
    } catch (error) {
      // A `stopOnError` failure ends the batch: items that never started
      // won't, so settle them rather than leave them "pending" forever.
      const notStarted = states.filter((state) => state.status === "pending");
      for (const state of notStarted) {
        state.status = "aborted";
        state.error = new FilesError(
          "Provider",
          "upload not started: an earlier upload in the batch failed",
          error,
          { aborted: true }
        );
      }
      if (notStarted.length > 0) {
        report();
      }
      throw error;
    }
    const uploaded: UploadResult[] = [];
    const errors: BulkError[] = [];
    for (const result of results) {
      if (result.ok) {
        uploaded.push({
          contentType: result.out.type,
          etag: result.out.etag,
          key: result.out.key,
          lastModified: result.out.lastModified,
          size: result.out.size,
        });
      } else {
        errors.push({ error: result.error, key: result.key });
      }
    }
    return errors.length ? { errors, uploaded } : { uploaded };
  };

  const downloadMany = async (
    keys: string[],
    opts?: BulkCallOptions & { as?: "blob" | "stream" }
  ) => {
    const results = await pMap(
      keys,
      async (key) => {
        try {
          return {
            file: await downloadOne(key, {
              as: opts?.as,
              signal: opts?.signal,
            }),
            ok: true as const,
          };
        } catch (error) {
          if (opts?.stopOnError) {
            throw error;
          }
          return { error: FilesError.wrap(error), key, ok: false as const };
        }
      },
      { concurrency: opts?.concurrency ?? concurrency }
    );
    const downloaded: StoredFile[] = [];
    const errors: BulkError[] = [];
    for (const result of results) {
      if (result.ok) {
        downloaded.push(result.file);
      } else {
        errors.push({ error: result.error, key: result.key });
      }
    }
    return errors.length ? { downloaded, errors } : { downloaded };
  };

  // --- assembled client ---

  // SAFETY: `delete`/`download`/`exists`/`head`/`upload` are overloaded on the
  // `FilesClient` type (single key vs. bulk array, file vs. key+body vs. items).
  // Each implementation below branches on the same discriminant the overloads
  // do (`Array.isArray` / `isString`) and returns that arm's result, but a
  // single arrow function cannot be checked against an overload set, so each is
  // asserted to its declared member type; the `b as …` casts inside `upload`
  // pick the second parameter's type for the arm the first parameter selected.
  const client: FilesClient = {
    capabilities: async (opts) => {
      const res = await post<{ capabilities: AdapterCapabilities }>(
        { op: "capabilities" },
        opts?.signal
      );
      return res.capabilities;
    },

    copy: async (from, to, opts) => {
      await post({ from, op: "copy", to }, opts?.signal);
    },

    delete: (async (keyOrKeys: string | string[], opts?: BulkCallOptions) => {
      if (Array.isArray(keyOrKeys)) {
        const r = await post<{ deleted: string[]; errors?: WireBulkError[] }>(
          {
            concurrency: opts?.concurrency,
            keys: keyOrKeys,
            op: "delete-many",
            stopOnError: opts?.stopOnError,
          },
          opts?.signal
        );
        return withErrors({ deleted: r.deleted }, r.errors);
      }
      // discard the { ok: true } envelope; single delete resolves to void
      await post({ key: keyOrKeys, op: "delete" }, opts?.signal);
    }) as FilesClient["delete"],

    download: ((
      keyOrKeys: string | string[],
      opts?: DownloadCallOptions & BulkCallOptions
    ) =>
      Array.isArray(keyOrKeys)
        ? downloadMany(keyOrKeys, opts)
        : downloadOne(keyOrKeys, opts)) as FilesClient["download"],

    exists: (async (keyOrKeys: string | string[], opts?: BulkCallOptions) => {
      if (Array.isArray(keyOrKeys)) {
        const res = await post<{
          existing: string[];
          missing: string[];
          errors?: WireBulkError[];
        }>(
          {
            concurrency: opts?.concurrency,
            keys: keyOrKeys,
            op: "exists-many",
            stopOnError: opts?.stopOnError,
          },
          opts?.signal
        );
        return withErrors(
          { existing: res.existing, missing: res.missing },
          res.errors
        );
      }
      const r = await post<{ exists: boolean }>(
        { key: keyOrKeys, op: "exists" },
        opts?.signal
      );
      return r.exists;
    }) as FilesClient["exists"],

    head: (async (keyOrKeys: string | string[], opts?: BulkCallOptions) => {
      if (Array.isArray(keyOrKeys)) {
        const res = await post<{
          files: WireStoredFile[];
          errors?: WireBulkError[];
        }>(
          {
            concurrency: opts?.concurrency,
            keys: keyOrKeys,
            op: "head-many",
            stopOnError: opts?.stopOnError,
          },
          opts?.signal
        );
        return withErrors({ files: res.files.map(toStoredFile) }, res.errors);
      }
      const r = await post<{ file: WireStoredFile }>(
        { key: keyOrKeys, op: "head" },
        opts?.signal
      );
      return toStoredFile(r.file);
    }) as FilesClient["head"],

    list: async (opts?: ListCallOptions) => {
      const res = await post<{
        items: WireStoredFile[];
        prefixes?: string[];
        cursor?: string;
      }>(
        {
          op: "list",
          ...(opts?.prefix !== undefined && { prefix: opts.prefix }),
          ...(opts?.cursor !== undefined && { cursor: opts.cursor }),
          ...(opts?.limit !== undefined && { limit: opts.limit }),
          ...(opts?.delimiter !== undefined && { delimiter: opts.delimiter }),
        },
        opts?.signal
      );
      return {
        items: res.items.map(toStoredFile),
        ...(res.prefixes && { prefixes: res.prefixes }),
        ...(res.cursor && { cursor: res.cursor }),
      };
    },

    async *listAll(opts?: ListCallOptions) {
      let cursor = opts?.cursor;
      do {
        // eslint-disable-next-line no-await-in-loop -- pagination: each page's cursor comes from the previous response.
        const page = await client.list({ ...opts, cursor });
        for (const item of page.items) {
          yield item;
        }
        ({ cursor } = page);
      } while (cursor);
    },

    move: async (from, to, opts) => {
      await post({ from, op: "move", to }, opts?.signal);
    },

    purge: async (key, opts) => {
      await post(
        { op: "purge", ...(key !== undefined && { key }) },
        opts?.signal
      );
    },

    restoreTrashed: async (key, opts) => {
      const res = await post<{ file: WireStoredFile }>(
        { key, op: "restore-trashed" },
        opts?.signal
      );
      return toStoredFile(res.file);
    },

    restoreVersion: async (key, versionId, opts) => {
      const res = await post<{ file: WireStoredFile }>(
        {
          key,
          op: "restore-version",
          ...(versionId !== undefined && { versionId }),
        },
        opts?.signal
      );
      return toStoredFile(res.file);
    },

    async *search(pattern: string | RegExp, opts?: SearchCallOptions) {
      const base =
        pattern instanceof RegExp
          ? { flags: pattern.flags, isRegex: true, pattern: pattern.source }
          : { pattern };
      const res = await post<{ matches: WireStoredFile[] }>(
        {
          op: "search",
          ...base,
          ...(opts?.match && { match: opts.match }),
          ...(opts?.prefix !== undefined && { prefix: opts.prefix }),
          ...(opts?.limit !== undefined && { limit: opts.limit }),
          ...(opts?.maxResults !== undefined && {
            maxResults: opts.maxResults,
          }),
          ...(opts?.caseInsensitive !== undefined && {
            caseInsensitive: opts.caseInsensitive,
          }),
        },
        opts?.signal
      );
      for (const match of res.matches) {
        yield toStoredFile(match);
      }
    },

    signedUploadUrl: async (key, opts: SignUploadCallOptions) => {
      const res = await post<SignedUploadUrlResponse>(
        {
          expiresIn: opts.expiresIn,
          key,
          op: "signed-upload-url",
          ...(opts.contentType && { contentType: opts.contentType }),
          ...(opts.maxSize !== undefined && { maxSize: opts.maxSize }),
          ...(opts.minSize !== undefined && { minSize: opts.minSize }),
        },
        opts.signal
      );
      return res.signed;
    },

    trashed: async (opts) => {
      const res = await post<{ trashed: TrashedFile[] }>(
        { op: "trashed" },
        opts?.signal
      );
      return res.trashed;
    },

    upload: ((
      a: Blob | NativeFileRef | string | UploadManyClientItem[],
      b?: UploadBody | UploadCallOptions | UploadManyCallOptions,
      c?: UploadCallOptions
    ) => {
      if (Array.isArray(a)) {
        // SAFETY: the `items[]` overload pairs an array with `UploadManyCallOptions`.
        return uploadMany(a, b as UploadManyCallOptions | undefined);
      }
      if (isString(a)) {
        // SAFETY: the `(key, body, opts?)` overload pairs a string key with a body.
        return uploadExplicit(a, b as UploadBody, c);
      }
      // SAFETY: the keyless `(file, opts?)` overload pairs a Blob/ref with options.
      return uploadKeyless(a, b as UploadCallOptions | undefined);
    }) as FilesClient["upload"],

    url: async (key, opts?: UrlCallOptions) => {
      const res = await post<{ url: string }>(
        {
          key,
          op: "url",
          ...(opts?.expiresIn !== undefined && { expiresIn: opts.expiresIn }),
          ...(opts?.responseContentDisposition !== undefined && {
            responseContentDisposition: opts.responseContentDisposition,
          }),
        },
        opts?.signal
      );
      return res.url;
    },

    versions: async (key, opts) => {
      const res = await post<{ versions: FileVersion[] }>(
        { key, op: "versions" },
        opts?.signal
      );
      return res.versions;
    },
  };

  return client;
};
