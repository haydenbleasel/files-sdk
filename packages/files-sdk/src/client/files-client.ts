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
  FilesClient,
  FilesClientConfig,
  ListCallOptions,
  SearchCallOptions,
  SignUploadCallOptions,
  UploadBody,
  UploadCallOptions,
  UploadManyClientItem,
  UploadOutcome,
  UrlCallOptions,
} from "./types.js";

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

const toBlob = (body: UploadBody, contentType?: string): Blob => {
  if (body instanceof Blob) {
    return contentType && body.type !== contentType
      ? new Blob([body], { type: contentType })
      : body;
  }
  return new Blob(
    [body as BlobPart],
    contentType ? { type: contentType } : undefined
  );
};

export const createFilesClient = (
  config: FilesClientConfig = {}
): FilesClient => {
  const endpoint = config.endpoint ?? DEFAULT_ENDPOINT;
  const fetchImpl = config.fetchImpl ?? fetch;
  const transport = config.transport ?? defaultTransport(fetchImpl);
  const concurrency = config.concurrency ?? DEFAULT_CONCURRENCY;
  const sep = endpoint.includes("?") ? "&" : "?";

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
    body: Blob,
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
    file: Blob,
    opts?: UploadCallOptions
  ): Promise<UploadOutcome> => {
    const info = {
      name: fileName(file),
      size: file.size,
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

    const state = initialState(file);
    state.status = "uploading";
    state.key = key;
    const states: FileUploadState[] = [state];
    await sendToTarget(target, file, opts?.signal, (loaded, total) => {
      state.loaded = loaded;
      state.total = total || file.size;
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
    const blob = toBlob(body, opts?.contentType);
    const result = await transport({
      body: blob,
      headers: {
        "content-type": blob.type || "application/octet-stream",
        ...(await resolveHeaders()),
      },
      method: "PUT",
      onProgress: opts?.onProgress
        ? (loaded, total) => {
            const state = initialState(blob);
            state.key = key;
            state.status = "uploading";
            state.loaded = loaded;
            state.total = total || blob.size;
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

    delete: ((keyOrKeys: string | string[], opts?: BulkCallOptions) => {
      if (Array.isArray(keyOrKeys)) {
        return post<{ deleted: string[]; errors?: WireBulkError[] }>(
          {
            concurrency: opts?.concurrency,
            keys: keyOrKeys,
            op: "delete-many",
            stopOnError: opts?.stopOnError,
          },
          opts?.signal
        ).then((r) => withErrors({ deleted: r.deleted }, r.errors));
      }
      return post({ key: keyOrKeys, op: "delete" }, opts?.signal).then(() => {
        // discard the { ok: true } envelope; single delete resolves to void
      });
    }) as FilesClient["delete"],

    download: ((
      keyOrKeys: string | string[],
      opts?: DownloadCallOptions & BulkCallOptions
    ) =>
      Array.isArray(keyOrKeys)
        ? downloadMany(keyOrKeys, opts)
        : downloadOne(keyOrKeys, opts)) as FilesClient["download"],

    exists: ((keyOrKeys: string | string[], opts?: BulkCallOptions) => {
      if (Array.isArray(keyOrKeys)) {
        return post<{
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
        ).then((r) =>
          withErrors({ existing: r.existing, missing: r.missing }, r.errors)
        );
      }
      return post<{ exists: boolean }>(
        { key: keyOrKeys, op: "exists" },
        opts?.signal
      ).then((r) => r.exists);
    }) as FilesClient["exists"],

    head: ((keyOrKeys: string | string[], opts?: BulkCallOptions) => {
      if (Array.isArray(keyOrKeys)) {
        return post<{ files: WireStoredFile[]; errors?: WireBulkError[] }>(
          {
            concurrency: opts?.concurrency,
            keys: keyOrKeys,
            op: "head-many",
            stopOnError: opts?.stopOnError,
          },
          opts?.signal
        ).then((r) =>
          withErrors({ files: r.files.map(toStoredFile) }, r.errors)
        );
      }
      return post<{ file: WireStoredFile }>(
        { key: keyOrKeys, op: "head" },
        opts?.signal
      ).then((r) => toStoredFile(r.file));
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

    upload: ((
      a: Blob | string | UploadManyClientItem[],
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
  };

  return client;
};
