// oxlint-disable-next-line sonarjs/no-wildcard-import -- the SDK's API is namespaced (BunnyStorageSDK.file.list/upload/...); no flat named exports.
import * as BunnyStorageSDK from "@bunny.net/storage-sdk";

import type {
  Adapter,
  Body,
  FileInfo,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadResult,
  UrlOptions,
} from "../index.js";
import {
  existsByProbe,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError, dispositionUnsupported } from "../internal/errors.js";
import { isNumber, isObject, isString } from "../internal/is.js";
import { createStoredFile } from "../internal/stored-file.js";

export type BunnyStorageRegion = `${BunnyStorageSDK.regions.StorageRegion}`;

export interface BunnyStorageAdapterOptions {
  /**
   * Bunny Storage zone name. Falls back to `BUNNY_STORAGE_ZONE`, then
   * `STORAGE_ZONE` (the convention used in the SDK's README example).
   */
  zone?: string;
  /**
   * Bunny Storage zone password / API access key. Falls back to
   * `BUNNY_STORAGE_ACCESS_KEY`, then `STORAGE_ACCESS_KEY` (the convention
   * used in the SDK's README example).
   */
  accessKey?: string;
  /**
   * Primary Bunny Storage region. Pass one of
   * `BunnyStorageSDK.regions.StorageRegion.*`, e.g. `"de"`, `"ny"`, `"syd"`.
   * Falls back to `BUNNY_STORAGE_REGION`, then `STORAGE_REGION`.
   */
  region?: BunnyStorageRegion;
  /**
   * Existing connected storage zone from `@bunny.net/storage-sdk`. Highest
   * precedence; when provided, `zone`, `accessKey`, and `region` are ignored.
   */
  client?: BunnyStorageClient;
  /**
   * Origin used to build URLs from `url()`, typically a Bunny Pull Zone or
   * custom CDN hostname in front of the Storage Zone. When unset, `url()`
   * throws because the Storage API requires an `AccessKey` header and has no
   * signed-read URL primitive.
   */
  publicBaseUrl?: string;
}

export type BunnyStorageClient = ReturnType<
  typeof BunnyStorageSDK.zone.connect_with_accesskey
>;
type BunnyUploadStream = Parameters<typeof BunnyStorageSDK.file.upload>[2];
type BunnyDownloadStream = Awaited<
  ReturnType<BunnyStorageSDK.file.StorageFile["data"]>
>["stream"];

export type BunnyStorageAdapter = Adapter<BunnyStorageClient> & {
  readonly zone: string;
};

const VALID_REGIONS = new Set<string>(
  Object.values(BunnyStorageSDK.regions.StorageRegion)
);

// A `.` or `..` path segment, including the `%2e` spellings the URL parser
// treats the same way.
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/iu;

const toBunnyPath = (key: string): string => {
  const trimmed = key.replace(/^\/+/u, "");
  // The SDK appends this path to the zone URL's `pathname`, which resolves dot
  // segments away: `x/.` would address the directory `x/` and `.` or `a/..`
  // the zone root — both recursive-delete targets for `delete()` — rather
  // than an object. No stored object can carry such a segment, so reject it.
  if (trimmed.split("/").some((segment) => DOT_SEGMENT.test(segment))) {
    throw new FilesError(
      "Invalid",
      `bunnyStorage: key must not contain . or .. path segments: ${JSON.stringify(key)}`
    );
  }
  return `/${trimmed}`;
};

const fromBunnyPath = (path: string): string => path.replace(/^\/+/u, "");

// The Bunny SDK declares its streams against `node:stream/web`. At runtime
// that module re-exports the global `ReadableStream` class, so the two
// declarations describe the same object; the casts below only bridge the
// twin type definitions.
const streamFromBytes = (
  bytes: Uint8Array | ReadableStream<Uint8Array>
): BunnyUploadStream => {
  const stream =
    bytes instanceof ReadableStream
      ? bytes
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        });
  // TS won't relate the twin declarations directly, so go through the
  // async-iterable contract both declare.
  const iterable: AsyncIterable<Uint8Array> = stream;
  // SAFETY: the global `ReadableStream` is the same runtime class as
  // `node:stream/web`'s; only the declarations differ (see above).
  return iterable as BunnyUploadStream;
};

const bytesFromStream = async (
  stream: ReadableStream<Uint8Array> | BunnyDownloadStream
): Promise<Uint8Array> => {
  // SAFETY: `node:stream/web`'s `ReadableStream` is the same runtime class as
  // the global one `Response` consumes; only the declarations differ.
  const body = stream as ReadableStream<Uint8Array>;
  return new Uint8Array(await new Response(body).arrayBuffer());
};

const keyFromStorageFile = (
  entry: BunnyStorageSDK.file.StorageFile
): string => {
  // Bunny's `Path` is the file's containing directory and always starts
  // with `/<StorageZoneName>/` ending in `/`; `ObjectName` carries the file
  // name on its own. Strip the leading slash and the zone segment so the
  // returned key is relative to the zone root, then join with the object
  // name. An empty directory means the entry lives at the zone root.
  //
  // Defensive case: if a Bunny endpoint ever returns `Path` as
  // `/zone/dir/file` (the full key, no trailing slash) instead of the
  // documented `/zone/dir/`, treat `Path` itself as the key and don't
  // append `ObjectName` a second time. Detecting this via "did the raw
  // path end with `/`?" — rather than "does the directory end with `/
  // <objectName>`?" — is important because the latter false-positives when
  // a file legitimately shares a name with its parent directory (e.g.
  // `docs/somename/somename`).
  const name = fromBunnyPath(entry.objectName);
  const rawPath = fromBunnyPath(entry.path);
  const pathIsDirectory = rawPath === "" || rawPath.endsWith("/");
  let directory = rawPath;
  const zone = entry.storageZoneName;
  if (zone) {
    if (directory === zone) {
      directory = "";
    } else if (directory.startsWith(`${zone}/`)) {
      directory = directory.slice(zone.length + 1);
    }
  }
  // `(?<!\/)` anchors the match to the first trailing slash so the engine
  // can't re-attempt at every slash — avoids the polynomial `\/+$` ReDoS.
  directory = directory.replace(/(?<!\/)\/+$/u, "");
  if (!pathIsDirectory) {
    return directory || name;
  }
  if (!directory) {
    return name;
  }
  if (!name) {
    return directory;
  }
  return `${directory}/${name}`;
};

const toFileInfo = (entry: BunnyStorageSDK.file.StorageFile): FileInfo => ({
  contentType: entry.contentType || "application/octet-stream",
  etag: entry.checksum ?? undefined,
  key: keyFromStorageFile(entry),
  lastModified: entry.lastChanged?.getTime(),
  size: entry.length,
});

const toStoredFile = (
  entry: BunnyStorageSDK.file.StorageFile,
  body:
    | { kind: "buffer"; data: Uint8Array }
    | {
        kind: "stream";
        stream: ReadableStream<Uint8Array> | BunnyDownloadStream;
      }
): StoredFile => {
  const meta = toFileInfo(entry);
  if (body.kind === "buffer") {
    return createStoredFile(
      { ...meta, size: body.data.byteLength },
      { data: body.data, kind: "buffer" }
    );
  }
  // SAFETY: `node:stream/web`'s `ReadableStream` is the same runtime class
  // as the global one; only the declarations differ (see `streamFromBytes`).
  const stream = body.stream as ReadableStream<Uint8Array>;
  return createStoredFile(meta, {
    factory: () => stream,
    kind: "stream",
  });
};

const BUNNY_NOT_FOUND_CODES: ReadonlySet<string> = new Set(["NotFound"]);
const BUNNY_UNAUTH_CODES: ReadonlySet<string> = new Set(["Unauthorized"]);
const BUNNY_CONFLICT_CODES: ReadonlySet<string> = new Set(["Conflict"]);

// The Bunny SDK throws `new Error(...)` with no `code` or `status` field —
// see `statusCodeToException` in `@bunny.net/storage-sdk`. Classification
// has to fall back to matching the English message, which will silently
// degrade to `Provider` if the SDK ever localizes or rephrases it.
//
// The SDK's own templates are matched anchored, first: they interpolate the
// key (the 400 template since 0.3.2), so keyword-matching them would read a
// key like `not found.txt` or `conflict.txt` as the cause. Anything else gets
// the permissive keyword match.
const classifyBunnyMessage = (message: string): string | undefined => {
  if (message.startsWith("File not found: ")) {
    return "NotFound";
  }
  if (message.startsWith("Unauthorized access to storage zone: ")) {
    return "Unauthorized";
  }
  if (message.startsWith("Bad request for ")) {
    return undefined;
  }
  if (/not found/iu.test(message)) {
    return "NotFound";
  }
  if (/unauthor|access key|forbidden/iu.test(message)) {
    return "Unauthorized";
  }
  if (/conflict|precondition/iu.test(message)) {
    return "Conflict";
  }
  return undefined;
};

const _mapBunnyStorageError = makeErrorMapper({
  codes: {
    conflict: BUNNY_CONFLICT_CODES,
    notFound: BUNNY_NOT_FOUND_CODES,
    unauthorized: BUNNY_UNAUTH_CODES,
  },
  extract: (err) => {
    if (!isObject(err)) {
      return {};
    }
    const message =
      "message" in err && isString(err.message) ? err.message : "";
    const code =
      ("code" in err && isString(err.code) ? err.code : undefined) ??
      classifyBunnyMessage(message);
    const status =
      "status" in err && isNumber(err.status) ? err.status : undefined;
    const statusCode =
      "statusCode" in err && isNumber(err.statusCode)
        ? err.statusCode
        : undefined;
    return {
      ...(code && { code }),
      ...(message && { message }),
      ...(status !== undefined && { status }),
      ...(statusCode !== undefined && { status: statusCode }),
    };
  },
  providerLabel: "Bunny Storage error",
});

export const mapBunnyStorageError = (cause: unknown): FilesError =>
  _mapBunnyStorageError(cause);

const parseRegion = (
  region: string | undefined
): BunnyStorageRegion | undefined => {
  if (!region) {
    return;
  }
  if (!VALID_REGIONS.has(region)) {
    throw new FilesError(
      "Invalid",
      `bunnyStorage adapter: unsupported region "${region}". Pass one of ${[...VALID_REGIONS].join(", ")}.`
    );
  }
  // SAFETY: `VALID_REGIONS` is built from the `StorageRegion` enum's values,
  // so membership (checked above) proves `region` is one of its literals.
  return region as BunnyStorageRegion;
};

const buildClient = (opts: BunnyStorageAdapterOptions): BunnyStorageClient => {
  if (opts.client) {
    return opts.client;
  }
  const zone =
    opts.zone ?? readEnv("BUNNY_STORAGE_ZONE") ?? readEnv("STORAGE_ZONE");
  const accessKey =
    opts.accessKey ??
    readEnv("BUNNY_STORAGE_ACCESS_KEY") ??
    readEnv("STORAGE_ACCESS_KEY");
  const region = parseRegion(
    opts.region ?? readEnv("BUNNY_STORAGE_REGION") ?? readEnv("STORAGE_REGION")
  );
  if (!zone || !accessKey || !region) {
    throw new FilesError(
      "Invalid",
      "bunnyStorage adapter: missing credentials. Pass `zone` + `accessKey` + `region`, or set BUNNY_STORAGE_ZONE / BUNNY_STORAGE_ACCESS_KEY / BUNNY_STORAGE_REGION (also accepted: STORAGE_ZONE / STORAGE_ACCESS_KEY / STORAGE_REGION, the names used in the Bunny SDK's README example)."
    );
  }
  // SAFETY: `BunnyStorageRegion` is the template-literal image of the
  // `StorageRegion` string enum, so every value is one of the enum's members;
  // TS just doesn't let a string literal stand in for a string enum.
  return BunnyStorageSDK.zone.connect_with_accesskey(
    region as BunnyStorageSDK.regions.StorageRegion,
    zone,
    accessKey
  );
};

const listDirectoryForPrefix = (prefix: string | undefined): string => {
  if (!prefix) {
    return "/";
  }
  const cleaned = prefix.replace(/^\/+/u, "");
  if (!cleaned || cleaned.endsWith("/")) {
    return toBunnyPath(cleaned);
  }
  const idx = cleaned.lastIndexOf("/");
  return idx === -1 ? "/" : toBunnyPath(cleaned.slice(0, idx));
};

export const bunnyStorage = (
  opts: BunnyStorageAdapterOptions = {}
): BunnyStorageAdapter => {
  const client = buildClient(opts);
  const zone = BunnyStorageSDK.zone.name(client);
  const { publicBaseUrl } = opts;

  return {
    capabilities: {
      // With `publicBaseUrl`, `url()` returns a permanent Pull Zone / CDN link.
      publicUrl: Boolean(publicBaseUrl),
      // No native copy — `copy()` reads the source and re-uploads the body.
      serverSideCopy: false,
      // No `signedUrl`: `url()` needs `publicBaseUrl` (a Pull Zone / CDN host);
      // the Storage API URL requires an AccessKey header and can't be handed
      // out, so no signing — an explicit `expiresIn` is refused by the core
      // gate. No `signedUpload` either, for the same reason.
    },
    async copy(from, to) {
      try {
        const sourceEntry = await BunnyStorageSDK.file.get(
          client,
          toBunnyPath(from)
        );
        const source = await sourceEntry.data();
        await BunnyStorageSDK.file.upload(
          client,
          toBunnyPath(to),
          source.stream,
          { contentType: sourceEntry.contentType || "application/octet-stream" }
        );
      } catch (error) {
        throw mapBunnyStorageError(error);
      }
    },
    async delete(key) {
      const path = toBunnyPath(key);
      let removed: boolean;
      try {
        // `throwOnError` makes the SDK throw on an HTTP error instead of
        // resolving `false`, so the status is classified directly: a 404
        // ("File not found") is an idempotent success and a 401 — a wrong or
        // read-only key — surfaces as `Unauthorized`, not a retried failure.
        removed = await BunnyStorageSDK.file.remove(client, path, {
          throwOnError: true,
        });
      } catch (error) {
        const mapped = mapBunnyStorageError(error);
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
      if (removed) {
        return;
      }
      // An SDK without `throwOnError` resolves `response.ok` instead of
      // throwing, so `false` is either a missing key (404: idempotent
      // success) or a real failure (401/403/5xx) it doesn't tell apart. Probe
      // the key: NotFound means there was nothing to delete; any other probe
      // error surfaces; a file that is still there means the delete failed —
      // possibly transiently, so it stays a retryable `Provider`.
      try {
        await BunnyStorageSDK.file.get(client, path);
      } catch (error) {
        const mapped = mapBunnyStorageError(error);
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
      throw new FilesError(
        "Provider",
        `bunnyStorage: the Storage API rejected the delete of "${key}" and the file still exists. Check that the access key has write access (a read-only password can't delete).`
      );
    },
    async download(key, downloadOpts) {
      try {
        const entry = await BunnyStorageSDK.file.get(client, toBunnyPath(key));
        const result = await entry.data();
        if (downloadOpts?.as === "stream") {
          return toStoredFile(entry, {
            kind: "stream",
            stream: result.stream,
          });
        }
        return toStoredFile(entry, {
          data: await bytesFromStream(result.stream),
          kind: "buffer",
        });
      } catch (error) {
        throw mapBunnyStorageError(error);
      }
    },
    exists(key) {
      return existsByProbe(
        () => BunnyStorageSDK.file.get(client, toBunnyPath(key)),
        mapBunnyStorageError
      );
    },
    async head(key) {
      try {
        return toFileInfo(
          await BunnyStorageSDK.file.get(client, toBunnyPath(key))
        );
      } catch (error) {
        throw mapBunnyStorageError(error);
      }
    },
    async list(options): Promise<ListResult> {
      try {
        const prefix = options?.prefix?.replace(/^\/+/u, "") ?? "";
        const offset = options?.cursor
          ? // oxlint-disable-next-line unicorn/prefer-number-coercion -- explicit radix-10 parse of a numeric cursor is clearer than Math.trunc(Number(...)).
            Number.parseInt(options.cursor, 10)
          : 0;
        const limit = options?.limit;
        const entries = await BunnyStorageSDK.file.list(
          client,
          listDirectoryForPrefix(prefix)
        );
        const files: FileInfo[] = [];
        for (const entry of entries) {
          if (entry.isDirectory) {
            continue;
          }
          const info = toFileInfo(entry);
          if (!prefix || info.key.startsWith(prefix)) {
            files.push(info);
          }
        }
        const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
        const end = limit === undefined ? undefined : start + limit;
        const items = files.slice(start, end);
        return {
          ...(end !== undefined &&
            end < files.length && { cursor: String(end) }),
          items,
        };
      } catch (error) {
        throw mapBunnyStorageError(error);
      }
    },
    name: "bunny-storage",
    raw: client,
    signedUploadUrl(_key, _opts): Promise<SignedUpload> {
      return Promise.reject(
        new FilesError(
          "Unsupported",
          "bunnyStorage: signed upload URLs are not available. Bunny Storage writes go through the Storage API with an AccessKey header; upload server-side via the SDK or proxy through your application."
        )
      );
    },
    async upload(key, body: Body, options): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — the Bunny Storage SDK has no
      // arbitrary-metadata or cache-header field.
      try {
        const normalized = await normalizeBody(body, options?.contentType);
        const path = toBunnyPath(key);
        await BunnyStorageSDK.file.upload(
          client,
          path,
          streamFromBytes(normalized.data),
          { contentType: normalized.contentType }
        );
        // Bunny's PUT response carries no body or metadata. Round-trip via
        // `file.get` so `etag`, `lastModified`, and the authoritative size
        // (important for streamed uploads where `contentLength` is unknown
        // up front) match what other adapters return.
        try {
          const meta = await BunnyStorageSDK.file.get(client, path);
          return {
            contentType: meta.contentType || normalized.contentType,
            ...(meta.checksum && { etag: meta.checksum }),
            key,
            ...(meta.lastChanged && {
              lastModified: meta.lastChanged.getTime(),
            }),
            size: meta.length,
          };
        } catch {
          return {
            contentType: normalized.contentType,
            key,
            size: normalized.contentLength ?? 0,
          };
        }
      } catch (error) {
        throw mapBunnyStorageError(error);
      }
    },
    url(key, urlOpts?: UrlOptions): Promise<string> {
      if (urlOpts?.responseContentDisposition) {
        throw dispositionUnsupported(
          "bunnyStorage: `responseContentDisposition` is not supported. Bunny Storage has no signed-read URL primitive where a Content-Disposition override can be bound."
        );
      }
      if (!publicBaseUrl) {
        throw new FilesError(
          "Unsupported",
          "bunnyStorage: url() requires `publicBaseUrl` (for example a Bunny Pull Zone or custom CDN hostname). The Storage API URL itself requires an AccessKey header and cannot be handed out as a public URL."
        );
      }
      return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
    },
    zone,
  };
};
