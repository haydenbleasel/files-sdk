import * as BunnyStorageSDK from "@bunny.net/storage-sdk";

import type {
  Adapter,
  Body,
  ListResult,
  SignedUpload,
  StoredFile,
  UploadOptions,
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
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";

export type BunnyStorageRegion = `${BunnyStorageSDK.regions.StorageRegion}`;

export interface BunnyStorageAdapterOptions {
  /**
   * Bunny Storage zone name. Falls back to `BUNNY_STORAGE_ZONE`, then the
   * SDK-documented `STORAGE_ZONE`.
   */
  zone?: string;
  /**
   * Bunny Storage zone password / API access key. Falls back to
   * `BUNNY_STORAGE_ACCESS_KEY`, `BUNNY_ACCESS_KEY`, then the SDK-documented
   * `STORAGE_ACCESS_KEY`.
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

const toBunnyPath = (key: string): string => {
  const trimmed = key.replace(/^\/+/u, "");
  return `/${trimmed}`;
};

const fromBunnyPath = (path: string): string => path.replace(/^\/+/u, "");

const streamFromBytes = (
  bytes: Uint8Array | ReadableStream<Uint8Array>
): BunnyUploadStream => {
  if (bytes instanceof ReadableStream) {
    return bytes as unknown as BunnyUploadStream;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  }) as unknown as BunnyUploadStream;
};

const bytesFromStream = async (
  stream: ReadableStream<Uint8Array> | BunnyDownloadStream
): Promise<Uint8Array> =>
  new Uint8Array(
    await new Response(stream as ReadableStream<Uint8Array>).arrayBuffer()
  );

const keyFromStorageFile = (
  entry: BunnyStorageSDK.file.StorageFile
): string => {
  const path = fromBunnyPath(entry.path);
  const name = fromBunnyPath(entry.objectName);
  if (!path) {
    return name;
  }
  if (!name || path.endsWith(name)) {
    return path;
  }
  return `${path.replace(/\/+$/u, "")}/${name}`;
};

const toStoredFile = (
  entry: BunnyStorageSDK.file.StorageFile,
  body?:
    | { kind: "lazy" }
    | { kind: "buffer"; data: Uint8Array }
    | {
        kind: "stream";
        stream: ReadableStream<Uint8Array> | BunnyDownloadStream;
      }
): StoredFile => {
  const meta = {
    etag: entry.checksum ?? undefined,
    key: keyFromStorageFile(entry),
    lastModified: entry.lastChanged?.getTime(),
    size: entry.length,
    type: entry.contentType || "application/octet-stream",
  };
  if (body?.kind === "buffer") {
    return createStoredFile(
      { ...meta, size: body.data.byteLength },
      { data: body.data, kind: "buffer" }
    );
  }
  if (body?.kind === "stream") {
    return createStoredFile(meta, {
      factory: () => body.stream as unknown as ReadableStream<Uint8Array>,
      kind: "stream",
    });
  }
  return createStoredFile(meta, {
    factory: async () => {
      const result = await entry.data();
      return bytesFromStream(result.stream);
    },
    kind: "lazy",
  });
};

const BUNNY_NOT_FOUND_CODES: ReadonlySet<string> = new Set(["NotFound"]);
const BUNNY_UNAUTH_CODES: ReadonlySet<string> = new Set(["Unauthorized"]);
const BUNNY_CONFLICT_CODES: ReadonlySet<string> = new Set(["Conflict"]);

const _mapBunnyStorageError = makeErrorMapper({
  codes: {
    conflict: BUNNY_CONFLICT_CODES,
    notFound: BUNNY_NOT_FOUND_CODES,
    unauthorized: BUNNY_UNAUTH_CODES,
  },
  extract: (err) => {
    const e = err as {
      code?: string;
      message?: string;
      status?: number;
      statusCode?: number;
    };
    const message = e?.message ?? (err instanceof Error ? err.message : "");
    let code = e?.code;
    if (!code && /not found/iu.test(message)) {
      code = "NotFound";
    } else if (!code && /unauthor|access key|forbidden/iu.test(message)) {
      code = "Unauthorized";
    } else if (!code && /conflict|precondition/iu.test(message)) {
      code = "Conflict";
    }
    return {
      ...(code && { code }),
      ...(message && { message }),
      ...(e?.status !== undefined && { status: e.status }),
      ...(e?.statusCode !== undefined && { status: e.statusCode }),
    };
  },
  providerLabel: "Bunny Storage error",
});

export const mapBunnyStorageError = (err: unknown): FilesError =>
  _mapBunnyStorageError(err);

const assertSupportedUploadOptions = (options: UploadOptions | undefined) => {
  if (options?.cacheControl) {
    throw new FilesError(
      "Provider",
      "bunnyStorage: `cacheControl` is not supported by the Bunny Storage SDK. Configure cache behavior on the Pull Zone/CDN instead."
    );
  }
  if (options?.metadata && Object.keys(options.metadata).length > 0) {
    throw new FilesError(
      "Provider",
      "bunnyStorage: custom `metadata` is not supported by the Bunny Storage SDK."
    );
  }
};

const parseRegion = (
  region: string | undefined
): BunnyStorageRegion | undefined => {
  if (!region) {
    return;
  }
  if (!VALID_REGIONS.has(region)) {
    throw new FilesError(
      "Provider",
      `bunnyStorage adapter: unsupported region "${region}". Pass one of ${[...VALID_REGIONS].join(", ")}.`
    );
  }
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
    readEnv("BUNNY_ACCESS_KEY") ??
    readEnv("STORAGE_ACCESS_KEY");
  const region = parseRegion(
    opts.region ?? readEnv("BUNNY_STORAGE_REGION") ?? readEnv("STORAGE_REGION")
  );
  if (!zone || !accessKey || !region) {
    throw new FilesError(
      "Provider",
      "bunnyStorage adapter: missing credentials. Pass `zone` + `accessKey` + `region`, or set BUNNY_STORAGE_ZONE / BUNNY_STORAGE_ACCESS_KEY / BUNNY_STORAGE_REGION (SDK aliases: STORAGE_ZONE / STORAGE_ACCESS_KEY / STORAGE_REGION)."
    );
  }
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
      try {
        const path = toBunnyPath(key);
        await BunnyStorageSDK.file.remove(client, path);
      } catch (error) {
        const mapped = mapBunnyStorageError(error);
        if (mapped.code === "NotFound") {
          return;
        }
        throw mapped;
      }
    },
    async download(key, downloadOpts) {
      try {
        const entry = await BunnyStorageSDK.file.get(client, toBunnyPath(key));
        const result = await entry.data();
        if (downloadOpts?.as === "stream") {
          return toStoredFile(entry, { kind: "stream", stream: result.stream });
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
        return toStoredFile(
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
          ? Number.parseInt(options.cursor, 10)
          : 0;
        const limit = options?.limit;
        const entries = await BunnyStorageSDK.file.list(
          client,
          listDirectoryForPrefix(prefix)
        );
        const files = entries
          .filter((entry) => !entry.isDirectory)
          .map((entry) => toStoredFile(entry))
          .filter((entry) => !prefix || entry.key.startsWith(prefix));
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
    async signedUploadUrl(_key, _opts): Promise<SignedUpload> {
      return await Promise.reject(
        new FilesError(
          "Provider",
          "bunnyStorage: signed upload URLs are not available. Bunny Storage writes go through the Storage API with an AccessKey header; upload server-side via the SDK or proxy through your application."
        )
      );
    },
    async upload(key, body: Body, options): Promise<UploadResult> {
      assertSupportedUploadOptions(options);
      try {
        const normalized = await normalizeBody(body, options?.contentType);
        await BunnyStorageSDK.file.upload(
          client,
          toBunnyPath(key),
          streamFromBytes(normalized.data),
          { contentType: normalized.contentType }
        );
        return {
          contentType: normalized.contentType,
          key,
          size: normalized.contentLength ?? 0,
        };
      } catch (error) {
        throw mapBunnyStorageError(error);
      }
    },
    url(key, urlOpts?: UrlOptions): Promise<string> {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "bunnyStorage: `responseContentDisposition` is not supported. Bunny Storage has no signed-read URL primitive where a Content-Disposition override can be bound."
        );
      }
      if (!publicBaseUrl) {
        throw new FilesError(
          "Provider",
          "bunnyStorage: url() requires `publicBaseUrl` (for example a Bunny Pull Zone or custom CDN hostname). The Storage API URL itself requires an AccessKey header and cannot be handed out as a public URL."
        );
      }
      return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
    },
    zone,
  };
};
