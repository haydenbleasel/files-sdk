import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";

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

export interface AzureAdapterOptions {
  /**
   * Azure container name. Surfaced as `bucket` on the returned adapter for
   * cross-adapter API consistency (S3/R2/GCS/MinIO all expose `bucket`).
   * Azure's own term is "container".
   */
  container: string;
  /**
   * Full connection string (`DefaultEndpointsProtocol=...;AccountName=...;
   * AccountKey=...;EndpointSuffix=core.windows.net`). Highest precedence.
   * Falls back to `AZURE_STORAGE_CONNECTION_STRING`.
   *
   * The adapter parses out `AccountName` + `AccountKey` so `url()` and
   * `signedUploadUrl()` can mint new SAS without a separate credential.
   */
  connectionString?: string;
  /**
   * Storage account name (e.g. `mystorageaccount`). Used with `accountKey`,
   * `sasToken`, or anonymously. Falls back to `AZURE_STORAGE_ACCOUNT_NAME`,
   * then `AZURE_STORAGE_ACCOUNT` (the Azure CLI uses both at different times).
   */
  accountName?: string;
  /**
   * Shared-key (account key). Required to sign URLs with shared-key
   * credentials. Falls back to `AZURE_STORAGE_ACCOUNT_KEY`, then
   * `AZURE_STORAGE_KEY`.
   */
  accountKey?: string;
  /**
   * Pre-issued SAS token (with or without leading `?`). When set without
   * `accountKey`, `url()` and `signedUploadUrl()` cannot mint new SAS — they
   * throw a Provider error. Reading/writing/listing still works as long as
   * the SAS has the relevant permissions.
   */
  sasToken?: string;
  /**
   * Override the service endpoint host. Defaults to
   * `https://${accountName}.blob.core.windows.net`. Used for Azurite
   * (`http://127.0.0.1:10000/devstoreaccount1`) or sovereign clouds
   * (`*.blob.core.usgovcloudapi.net`, `*.blob.core.chinacloudapi.cn`).
   */
  endpoint?: string;
  /**
   * Origin used to build URLs from `url()`. When set, `url(key)` returns
   * `${publicBaseUrl}/${key}` and skips signing — appropriate for a public
   * container (`Blob` or `Container` access level) or a CDN
   * (`*.azureedge.net`) in front of the account.
   */
  publicBaseUrl?: string;
  /**
   * Default expiry, in seconds, for the SAS read URLs returned by `url()`
   * when `publicBaseUrl` is not set. Defaults to 3600 (1 hour). Per-call
   * `url(key, { expiresIn })` overrides.
   */
  defaultUrlExpiresIn?: number;
}

export type AzureAdapter = Adapter<BlobServiceClient> & {
  readonly bucket: string;
};

const COPY_SOURCE_SAS_SECONDS = 300;

const AZURE_NOT_FOUND_CODES: ReadonlySet<string> = new Set([
  "BlobNotFound",
  "ContainerNotFound",
  "ResourceNotFound",
]);
const AZURE_UNAUTH_CODES: ReadonlySet<string> = new Set([
  "AuthenticationFailed",
  "AuthorizationFailure",
  "AuthorizationPermissionMismatch",
  "InvalidAuthenticationInfo",
  "InsufficientAccountPermissions",
]);
const AZURE_CONFLICT_CODES: ReadonlySet<string> = new Set([
  "BlobAlreadyExists",
  "ContainerAlreadyExists",
  "ConditionNotMet",
  "LeaseIdMismatchWithBlobOperation",
  "LeaseAlreadyPresent",
]);

export const mapAzureError = makeErrorMapper({
  codes: {
    conflict: AZURE_CONFLICT_CODES,
    notFound: AZURE_NOT_FOUND_CODES,
    unauthorized: AZURE_UNAUTH_CODES,
  },
  extract: (err) => {
    const e = err as {
      statusCode?: number;
      code?: string | number;
      details?: { errorCode?: string };
      message?: string;
    };
    // Azure RestError carries the storage error code on `details.errorCode`
    // (the value from the response body) and the HTTP status on `statusCode`.
    // The top-level `code` is sometimes the same string and sometimes an SDK
    // class name, so prefer `details.errorCode` when present.
    const code =
      e?.details?.errorCode ??
      (typeof e?.code === "string" ? e.code : undefined);
    return {
      ...(code && { code }),
      ...(e?.message && { message: e.message }),
      ...(e?.statusCode !== undefined && { status: e.statusCode }),
    };
  },
  providerLabel: "Azure error",
});

const stripEtag = (etag: string | undefined): string | undefined => {
  if (!etag) {
    return;
  }
  return etag.replaceAll(/^"+|"+$/gu, "");
};

// Forward the operation's AbortSignal to the Azure SDK. The SDK types this as
// `AbortSignalLike` (from @azure/abort-controller); a web `AbortSignal`
// satisfies that interface, so it passes through unchanged. Returns `undefined`
// when there's no signal so callers can hand it straight to an optional
// options arg without inventing an empty object.
const abortOpts = (
  signal: AbortSignal | undefined
): { abortSignal: AbortSignal } | undefined =>
  signal ? { abortSignal: signal } : undefined;

const uint8ToBuffer = (u8: Uint8Array): Buffer =>
  Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

const bufferToUint8 = (buf: Buffer): Uint8Array =>
  new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

interface ConnectionStringParts {
  accountName?: string;
  accountKey?: string;
  endpoint?: string;
}

const parseConnectionString = (cs: string): ConnectionStringParts => {
  const parts: Record<string, string> = {};
  for (const segment of cs.split(";")) {
    const idx = segment.indexOf("=");
    if (idx === -1) {
      continue;
    }
    const key = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (key) {
      parts[key] = value;
    }
  }
  return {
    ...(parts.AccountName && { accountName: parts.AccountName }),
    ...(parts.AccountKey && { accountKey: parts.AccountKey }),
    ...(parts.BlobEndpoint && { endpoint: parts.BlobEndpoint }),
  };
};

const trimSas = (sas: string): string =>
  sas.startsWith("?") ? sas.slice(1) : sas;

const defaultEndpoint = (accountName: string): string =>
  `https://${accountName}.blob.core.windows.net`;

interface AzureClientBundle {
  client: BlobServiceClient;
  sharedKey?: StorageSharedKeyCredential;
  accountName?: string;
  endpoint: string;
  sasToken?: string;
}

const buildFromConnectionString = (
  connectionString: string,
  opts: AzureAdapterOptions
): AzureClientBundle => {
  const parsed = parseConnectionString(connectionString);
  const client = BlobServiceClient.fromConnectionString(connectionString);
  const accountName = opts.accountName ?? parsed.accountName;
  const accountKey = opts.accountKey ?? parsed.accountKey;
  const endpoint =
    opts.endpoint ??
    parsed.endpoint ??
    (accountName ? defaultEndpoint(accountName) : client.url);
  const sharedKey =
    accountName && accountKey
      ? new StorageSharedKeyCredential(accountName, accountKey)
      : undefined;
  return {
    client,
    endpoint,
    ...(accountName && { accountName }),
    ...(sharedKey && { sharedKey }),
  };
};

const resolveAccountName = (opts: AzureAdapterOptions): string | undefined =>
  opts.accountName ??
  readEnv("AZURE_STORAGE_ACCOUNT_NAME") ??
  readEnv("AZURE_STORAGE_ACCOUNT");

const resolveAccountKey = (opts: AzureAdapterOptions): string | undefined =>
  opts.accountKey ??
  readEnv("AZURE_STORAGE_ACCOUNT_KEY") ??
  readEnv("AZURE_STORAGE_KEY");

const buildClient = (opts: AzureAdapterOptions): AzureClientBundle => {
  const connectionString =
    opts.connectionString ?? readEnv("AZURE_STORAGE_CONNECTION_STRING");
  if (connectionString) {
    return buildFromConnectionString(connectionString, opts);
  }

  const accountName = resolveAccountName(opts);
  if (!accountName) {
    throw new FilesError(
      "Provider",
      "azure adapter: missing credentials. Pass one of `connectionString`, `sasToken` + `accountName`, `accountKey` + `accountName`, or `accountName` (for public-read containers). Env fallbacks: AZURE_STORAGE_CONNECTION_STRING, AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY."
    );
  }

  const endpoint = opts.endpoint ?? defaultEndpoint(accountName);
  const accountKey = resolveAccountKey(opts);
  if (accountKey) {
    const sharedKey = new StorageSharedKeyCredential(accountName, accountKey);
    return {
      accountName,
      client: new BlobServiceClient(endpoint, sharedKey),
      endpoint,
      sharedKey,
    };
  }

  const sasToken = opts.sasToken ?? readEnv("AZURE_STORAGE_SAS_TOKEN");
  if (sasToken) {
    const trimmed = trimSas(sasToken);
    return {
      accountName,
      client: new BlobServiceClient(`${endpoint}?${trimmed}`),
      endpoint,
      sasToken: trimmed,
    };
  }

  // Anonymous — only useful for public-read containers. `url()` and
  // `signedUploadUrl()` will throw because we can't sign.
  return {
    accountName,
    client: new BlobServiceClient(endpoint),
    endpoint,
  };
};

const requireSharedKey = (
  sharedKey: StorageSharedKeyCredential | undefined
): StorageSharedKeyCredential => {
  if (!sharedKey) {
    throw new FilesError(
      "Provider",
      "azure: cannot sign URLs without a shared key. Construct the adapter with `accountKey` + `accountName` or a `connectionString` that contains an account key, or set `publicBaseUrl` for a public container."
    );
  }
  return sharedKey;
};

export const azure = (opts: AzureAdapterOptions): AzureAdapter => {
  const { container, publicBaseUrl } = opts;
  if (!container) {
    throw new FilesError(
      "Provider",
      "azure adapter: missing container. Pass `container`."
    );
  }

  const { client, sharedKey, sasToken } = buildClient(opts);
  const containerClient = client.getContainerClient(container);
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  const buildReadSas = (key: string, expiresIn: number, disposition?: string) =>
    generateBlobSASQueryParameters(
      {
        blobName: key,
        containerName: container,
        ...(disposition && { contentDisposition: disposition }),
        expiresOn: new Date(Date.now() + expiresIn * 1000),
        permissions: BlobSASPermissions.parse("r"),
        protocol: SASProtocol.Https,
      },
      requireSharedKey(sharedKey)
    );

  const buildCopySource = (fromKey: string): string => {
    const baseUrl = containerClient.getBlobClient(fromKey).url;
    if (sharedKey) {
      const sas = generateBlobSASQueryParameters(
        {
          blobName: fromKey,
          containerName: container,
          expiresOn: new Date(Date.now() + COPY_SOURCE_SAS_SECONDS * 1000),
          permissions: BlobSASPermissions.parse("r"),
          protocol: SASProtocol.Https,
        },
        sharedKey
      );
      return `${baseUrl}?${sas.toString()}`;
    }
    if (sasToken) {
      return `${baseUrl}?${sasToken}`;
    }
    // Anonymous mode — only succeeds against public containers. Let Azure
    // return the natural error if it doesn't.
    return baseUrl;
  };

  return {
    bucket: container,
    async copy(from, to, operationOpts) {
      try {
        const sourceUrl = buildCopySource(from);
        await containerClient
          .getBlobClient(to)
          .syncCopyFromURL(sourceUrl, abortOpts(operationOpts?.signal));
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    async delete(key, operationOpts) {
      try {
        // `deleteIfExists` keeps `delete()` idempotent across adapters —
        // matches S3's silent-on-missing behavior. Callers who care about
        // the difference between "didn't exist" and "deleted now" should
        // call `head()` first.
        await containerClient
          .getBlobClient(key)
          .deleteIfExists(abortOpts(operationOpts?.signal));
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const blobClient = containerClient.getBlobClient(key);
        const result = await blobClient.download(
          0,
          undefined,
          abortOpts(downloadOpts?.signal)
        );
        const etag = stripEtag(result.etag);
        const baseMeta = {
          ...(etag && { etag }),
          key,
          ...(result.lastModified && {
            lastModified: result.lastModified.getTime(),
          }),
          ...(result.metadata && {
            metadata: result.metadata as Record<string, string>,
          }),
          type: result.contentType ?? "application/octet-stream",
        };
        const size = Number(result.contentLength ?? 0);
        if (downloadOpts?.as === "stream") {
          const node = result.readableStreamBody;
          return createStoredFile(
            { ...baseMeta, size },
            {
              factory: () => {
                if (!node) {
                  return new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.close();
                    },
                  });
                }
                return Readable.toWeb(
                  node as Readable
                ) as unknown as ReadableStream<Uint8Array>;
              },
              kind: "stream",
            }
          );
        }
        // Buffer path: re-issue via downloadToBuffer rather than draining the
        // stream we already opened — `download()` returned a stream we'd have
        // to manually pipe + buffer, and the SDK's helper does it more
        // efficiently with parallel range requests for large blobs.
        const buf = await blobClient.downloadToBuffer(
          0,
          undefined,
          abortOpts(downloadOpts?.signal)
        );
        const bytes = bufferToUint8(buf);
        return createStoredFile(
          { ...baseMeta, size: bytes.byteLength },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    async exists(key, operationOpts) {
      try {
        return await containerClient
          .getBlobClient(key)
          .exists(abortOpts(operationOpts?.signal));
      } catch (error) {
        const mapped = mapAzureError(error);
        if (mapped.code === "NotFound") {
          return false;
        }
        throw mapped;
      }
    },
    async head(key, operationOpts) {
      try {
        const blobClient = containerClient.getBlobClient(key);
        const props = await blobClient.getProperties(
          abortOpts(operationOpts?.signal)
        );
        const etag = stripEtag(props.etag);
        return createStoredFile(
          {
            ...(etag && { etag }),
            key,
            ...(props.lastModified && {
              lastModified: props.lastModified.getTime(),
            }),
            ...(props.metadata && {
              metadata: props.metadata as Record<string, string>,
            }),
            size: Number(props.contentLength ?? 0),
            type: props.contentType ?? "application/octet-stream",
          },
          {
            factory: async () => {
              const buf = await blobClient.downloadToBuffer();
              return bufferToUint8(buf);
            },
            kind: "lazy",
          }
        );
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    async list(options) {
      try {
        const iterator = containerClient
          .listBlobsFlat({
            ...(options?.prefix && { prefix: options.prefix }),
            ...(options?.signal && { abortSignal: options.signal }),
          })
          .byPage({
            ...(options?.cursor && { continuationToken: options.cursor }),
            ...(options?.limit !== undefined && {
              maxPageSize: options.limit,
            }),
          });
        const { value: page } = await iterator.next();
        const segment = page?.segment as
          | { blobItems?: BlobItemLike[] }
          | undefined;
        const blobItems = segment?.blobItems ?? [];
        const items: StoredFile[] = blobItems.map((item) => {
          const props = item.properties ?? {};
          const itemKey = item.name;
          const itemEtag = stripEtag(props.etag);
          return createStoredFile(
            {
              ...(itemEtag && { etag: itemEtag }),
              key: itemKey,
              ...(props.lastModified && {
                lastModified: new Date(props.lastModified).getTime(),
              }),
              ...(item.metadata && {
                metadata: item.metadata,
              }),
              size: Number(props.contentLength ?? 0),
              type: props.contentType ?? "application/octet-stream",
            },
            {
              factory: async () => {
                const buf = await containerClient
                  .getBlobClient(itemKey)
                  .downloadToBuffer();
                return bufferToUint8(buf);
              },
              kind: "lazy",
            }
          );
        });
        const nextToken = page?.continuationToken;
        return {
          items,
          ...(nextToken && { cursor: nextToken }),
        };
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    name: "azure",
    raw: client,
    signedUploadUrl(key, signOpts): Promise<SignedUpload> {
      // Azure SAS has no `content-length-range` policy equivalent — there's
      // no way to enforce a max upload size at the URL level. Throw rather
      // than silently no-op, so callers don't ship a "limit" that does
      // nothing. Same honest-API stance vercel-blob takes on
      // responseContentDisposition.
      if (signOpts.maxSize !== undefined) {
        throw new FilesError(
          "Provider",
          "azure: `maxSize` is not supported. Azure SAS has no server-enforced upload size limit equivalent to S3's content-length-range policy. Enforce the limit at your application gateway / proxy before issuing the SAS, or omit `maxSize` and accept the unbounded PUT."
        );
      }
      try {
        const sas = generateBlobSASQueryParameters(
          {
            blobName: key,
            containerName: container,
            expiresOn: new Date(Date.now() + signOpts.expiresIn * 1000),
            permissions: BlobSASPermissions.parse("cw"),
            protocol: SASProtocol.Https,
          },
          requireSharedKey(sharedKey)
        );
        const blobUrl = containerClient.getBlobClient(key).url;
        return Promise.resolve({
          headers: {
            "x-ms-blob-type": "BlockBlob",
            ...(signOpts.contentType && {
              "Content-Type": signOpts.contentType,
            }),
          },
          method: "PUT",
          url: `${blobUrl}?${sas.toString()}`,
        });
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    async upload(key, body, options) {
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const blockBlob = containerClient.getBlockBlobClient(key);
      const writeOpts = {
        blobHTTPHeaders: {
          blobContentType: contentType,
          ...(options?.cacheControl && {
            blobCacheControl: options.cacheControl,
          }),
        },
        ...(options?.metadata && { metadata: options.metadata }),
        ...(options?.signal && { abortSignal: options.signal }),
      };
      try {
        let etag: string | undefined;
        let lastModified: number | undefined;
        let size = contentLength;
        if (data instanceof ReadableStream) {
          const node = Readable.fromWeb(data as never);
          const result = await blockBlob.uploadStream(
            node,
            undefined,
            undefined,
            writeOpts
          );
          etag = stripEtag(result.etag);
          lastModified = result.lastModified?.getTime();
        } else {
          const result = await blockBlob.uploadData(
            uint8ToBuffer(data),
            writeOpts
          );
          etag = stripEtag(result.etag);
          lastModified = result.lastModified?.getTime();
        }
        // Stream bodies have no locally computed length; uploadStream's
        // response doesn't carry one either. Do a follow-up getProperties
        // to surface the authoritative size instead of returning 0.
        if (size === undefined) {
          try {
            const props = await blockBlob.getProperties(
              abortOpts(options?.signal)
            );
            size = Number(props.contentLength ?? 0);
          } catch {
            size = 0;
          }
        }
        return {
          contentType,
          ...(etag && { etag }),
          key,
          ...(lastModified !== undefined && { lastModified }),
          size,
        } satisfies UploadResult;
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    url(key, urlOpts): Promise<string> {
      const strategy = resolveUrlStrategy({
        publicBaseUrl,
        responseContentDisposition: urlOpts?.responseContentDisposition,
      });
      if (strategy === "public" && publicBaseUrl) {
        return Promise.resolve(joinPublicUrl(publicBaseUrl, key));
      }
      try {
        const sas = buildReadSas(
          key,
          urlOpts?.expiresIn ?? defaultUrlExpiresIn,
          urlOpts?.responseContentDisposition
        );
        const blobUrl = containerClient.getBlobClient(key).url;
        return Promise.resolve(`${blobUrl}?${sas.toString()}`);
      } catch (error) {
        throw mapAzureError(error);
      }
    },
  };
};

interface BlobItemLike {
  name: string;
  properties?: {
    contentLength?: number;
    contentType?: string;
    etag?: string;
    lastModified?: Date | string;
  };
  metadata?: Record<string, string>;
}
