// `createFilesClient` — the framework-agnostic browser/Node client that mirrors
// the whole `Files` verb set over the gateway endpoint. One method per verb maps
// to a JSON POST (or the download GET / upload PUT byte paths). React/Vue/Svelte
// wrap this; it never touches React or `window` at module scope. `download`
// returns the same lazy `StoredFile` the server SDK returns.

import type {
  AdapterCapabilities,
  BulkError,
  StoredFile,
  UploadResult,
} from "../index.js";
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
import { createStoredFile } from "../internal/stored-file.js";
import { decodeDownload } from "./download-decode.js";
import { pool } from "./pool.js";
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
  UploadManyClientItem,
  UploadOutcome,
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
    default: {
      return "Provider";
    }
  }
};

const reviveError = (wire: WireFilesError): FilesError =>
  new FilesError(mapCode(wire.code), wire.message, undefined, {
    aborted: wire.aborted,
    permanent: wire.code === "Validation",
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
  if (typeof body === "string") {
    return fromBlob(
      new Blob([body], contentType ? { type: contentType } : undefined)
    );
  }
  const bytes = asBytes(body);
  try {
    return fromBlob(
      new Blob(
        [bytes as BlobPart],
        contentType ? { type: contentType } : undefined
      )
    );
  } catch {
    // React Native's Blob cannot be constructed from ArrayBuffer parts; the
    // transports accept raw bytes, so pass them through instead.
    return { body: bytes, size: bytes.byteLength, type: contentType ?? "" };
  }
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
    const raw =
      typeof config.headers === "function"
        ? await config.headers()
        : config.headers;
    return raw ? Object.fromEntries(new Headers(raw).entries()) : {};
  };

  const wireError = async (res: Response): Promise<FilesError> => {
    try {
      const body = (await res.json()) as { error?: WireFilesError };
      if (body.error?.code) {
        return reviveError(body.error);
      }
    } catch {
      // fall through
    }
    return new FilesError("Provider", `gateway responded ${res.status}`);
  };

  const post = async <T>(payload: object, signal?: AbortSignal): Promise<T> => {
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

  const handleEndpointResult = (status: number, text: string): unknown => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined = no parseable body; null would be a distinct wire value
      body = undefined;
    }
    if (status < 200 || status >= 300) {
      const error = (body as { error?: WireFilesError } | undefined)?.error;
      throw error
        ? reviveError(error)
        : new FilesError("Provider", `upload failed (${status})`);
    }
    return body;
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

  const uploadKeyless = async (
    file: Blob | NativeFileRef,
    opts?: UploadCallOptions
  ): Promise<UploadOutcome> => {
    const info = {
      name: fileName(file),
      size: file.size ?? 0,
      type: file.type || "application/octet-stream",
    };
    const presign = await post<{ uploads: PresignedUpload[] }>(
      {
        files: [info],
        op: "presign",
        ...(opts?.expiresIn ? { expiresIn: opts.expiresIn } : {}),
      },
      opts?.signal
    );
    const [first] = presign.uploads;
    if (!first) {
      throw new FilesError("Provider", "presign returned no upload target");
    }
    const { id, key, target } = first;

    // A descriptor can ride RN's FormData only on a POST target; a raw PUT
    // needs the actual bytes, so resolve the uri to a Blob first.
    const body =
      isNativeFileRef(file) && target.method === "PUT"
        ? await resolveRef(file)
        : file;

    const state = initialState(file);
    state.status = "uploading";
    state.key = key;
    const states: FileUploadState[] = [state];
    await sendToTarget(target, body, opts?.signal, (loaded, total) => {
      state.loaded = loaded;
      state.total = total || state.size;
      state.progress = state.total ? loaded / state.total : 0;
      opts?.onProgress?.(aggregate(states), states);
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
    state.status = "success";
    state.progress = 1;
    return {
      etag: done.etag,
      key: done.key,
      lastModified: done.lastModified,
      size: done.size,
      type: done.type,
    };
  };

  const uploadExplicit = async (
    key: string,
    body: UploadBody,
    opts?: UploadCallOptions
  ): Promise<UploadOutcome> => {
    // The through-endpoint is a raw PUT, so a picker ref becomes a Blob here;
    // its declared type fills in when no explicit contentType is given.
    const norm = isNativeFileRef(body)
      ? toBody(await resolveRef(body), opts?.contentType ?? body.type)
      : toBody(body, opts?.contentType);
    const result = await transport({
      body: norm.body,
      headers: {
        "content-type": norm.type || "application/octet-stream",
        ...(await resolveHeaders()),
      },
      method: "PUT",
      onProgress: opts?.onProgress
        ? (loaded, total) => {
            const state = initialState(norm.body);
            state.key = key;
            state.status = "uploading";
            state.loaded = loaded;
            state.total = total || norm.size;
            state.progress = state.total ? loaded / state.total : 0;
            opts.onProgress?.(aggregate([state]), [state]);
          }
        : undefined,
      signal: opts?.signal,
      url: `${endpoint}${sep}op=upload&key=${encodeURIComponent(key)}`,
    });
    const parsed = handleEndpointResult(result.status, result.text) as {
      file: UploadOutcome;
    };
    return parsed.file;
  };

  const uploadMany = async (
    items: UploadManyClientItem[],
    opts?: BulkCallOptions
  ) => {
    const results = await pool(
      items,
      opts?.concurrency ?? concurrency,
      async (item) => {
        try {
          const out = await uploadExplicit(item.key, item.body, {
            contentType: item.contentType,
            signal: opts?.signal,
          });
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
      }
    );
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
    const results = await pool(
      keys,
      opts?.concurrency ?? concurrency,
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
      }
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
          ...(opts?.prefix === undefined ? {} : { prefix: opts.prefix }),
          ...(opts?.cursor === undefined ? {} : { cursor: opts.cursor }),
          ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
          ...(opts?.delimiter === undefined
            ? {}
            : { delimiter: opts.delimiter }),
        },
        opts?.signal
      );
      return {
        items: res.items.map(toStoredFile),
        ...(res.prefixes ? { prefixes: res.prefixes } : {}),
        ...(res.cursor ? { cursor: res.cursor } : {}),
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
        { op: "purge", ...(key === undefined ? {} : { key }) },
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
          ...(versionId === undefined ? {} : { versionId }),
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
          ...(opts?.match ? { match: opts.match } : {}),
          ...(opts?.prefix === undefined ? {} : { prefix: opts.prefix }),
          ...(opts?.limit === undefined ? {} : { limit: opts.limit }),
          ...(opts?.maxResults === undefined
            ? {}
            : { maxResults: opts.maxResults }),
          ...(opts?.caseInsensitive === undefined
            ? {}
            : { caseInsensitive: opts.caseInsensitive }),
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
          ...(opts.contentType ? { contentType: opts.contentType } : {}),
          ...(opts.maxSize === undefined ? {} : { maxSize: opts.maxSize }),
          ...(opts.minSize === undefined ? {} : { minSize: opts.minSize }),
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
      b?: UploadBody | UploadCallOptions | BulkCallOptions,
      c?: UploadCallOptions
    ) => {
      if (Array.isArray(a)) {
        return uploadMany(a, b as BulkCallOptions | undefined);
      }
      if (typeof a === "string") {
        return uploadExplicit(a, b as UploadBody, c);
      }
      return uploadKeyless(a, b as UploadCallOptions | undefined);
    }) as FilesClient["upload"],

    url: async (key, opts?: UrlCallOptions) => {
      const res = await post<{ url: string }>(
        {
          key,
          op: "url",
          ...(opts?.expiresIn === undefined
            ? {}
            : { expiresIn: opts.expiresIn }),
          ...(opts?.responseContentDisposition === undefined
            ? {}
            : {
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
