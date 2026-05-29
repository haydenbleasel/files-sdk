import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

import type { TokenCredential } from "@azure/core-auth";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import type {
  BlockBlobClient,
  BlockBlobParallelUploadOptions,
  UserDelegationKey,
} from "@azure/storage-blob";

import type {
  Adapter,
  PartMeta,
  PartsResumableDriver,
  ResumableDriverOptions,
  ResumableUploadSession,
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
   * Microsoft Entra credential used for Azure AD / Managed Identity workloads.
   * When supplied without a shared key, reads/writes/listing use token-based
   * auth and `url()` / `signedUploadUrl()` mint User Delegation SAS URLs.
   *
   * The principal must be allowed to access blob data and call
   * `Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action`
   * (for example via Storage Blob Delegator at the account scope).
   */
  credential?: TokenCredential;
  /**
   * Controls whether `credential`-backed adapters mint User Delegation SAS
   * URLs. Defaults to true when `credential` is supplied. Set false only when
   * you want token-authenticated SDK operations but no signed URL support.
   */
  useUserDelegationSas?: boolean;
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
const USER_DELEGATION_KEY_SLACK_MS = 5 * 60 * 1000;
// How long a freshly minted key stays reusable beyond the SAS it was first
// requested for, so back-to-back url()/signedUploadUrl() calls share one key
// instead of fetching one per URL.
const USER_DELEGATION_KEY_TTL_MS = 60 * 60 * 1000;
// Azure rejects user delegation keys whose lifetime exceeds 7 days from
// `startsOn`; clamp our requested expiry so we never ask for an invalid key.
const USER_DELEGATION_KEY_MAX_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * Upload a body via the block-blob client. Streams go through `uploadStream`
 * (bufferSize/maxConcurrency are positional); buffered bodies through
 * `uploadData`, where `multipart` maps to `blockSize`/`concurrency`. Both
 * already split large bodies into parallel blocks.
 */
const runAzureUpload = async (
  blockBlob: BlockBlobClient,
  data: Uint8Array | ReadableStream<Uint8Array>,
  writeOpts: BlockBlobParallelUploadOptions,
  blockSize: number | undefined,
  concurrency: number | undefined
): Promise<{ etag?: string; lastModified?: number }> => {
  if (data instanceof ReadableStream) {
    const node = Readable.fromWeb(data as never);
    const streamed = await blockBlob.uploadStream(
      node,
      blockSize,
      concurrency,
      writeOpts
    );
    return {
      etag: stripEtag(streamed.etag),
      lastModified: streamed.lastModified?.getTime(),
    };
  }
  const uploaded = await blockBlob.uploadData(uint8ToBuffer(data), {
    ...writeOpts,
    ...(blockSize !== undefined && { blockSize }),
    ...(concurrency !== undefined && { concurrency }),
  });
  return {
    etag: stripEtag(uploaded.etag),
    lastModified: uploaded.lastModified?.getTime(),
  };
};

const AZURE_DEFAULT_BLOCK_SIZE = 8 * 1024 * 1024;
// Block IDs must be equal-length, base64-encoded strings. Encode a fixed-width
// index behind a prefix so every block ID is the same length and so we can tell
// our staged blocks apart from any left by another writer on resume.
const BLOCK_ID_PREFIX = "fls-";
const azureBlockId = (partNumber: number): string =>
  Buffer.from(
    `${BLOCK_ID_PREFIX}${String(partNumber).padStart(8, "0")}`
  ).toString("base64");
const decodeBlockNumber = (blockId: string | undefined): number | undefined => {
  if (!blockId) {
    return;
  }
  const raw = Buffer.from(blockId, "base64").toString();
  if (!raw.startsWith(BLOCK_ID_PREFIX)) {
    return;
  }
  const partNumber = Number(raw.slice(BLOCK_ID_PREFIX.length));
  return Number.isInteger(partNumber) && partNumber > 0
    ? partNumber
    : undefined;
};

/**
 * Drive a pause-able / resumable upload over Azure block blobs: `stageBlock`
 * per part, `getBlockList("uncommitted")` to discover staged blocks on resume,
 * `commitBlockList` to finalize. Block blobs need no explicit "create" call —
 * staging a block implicitly opens the upload — so `begin` just mints the token.
 */
const createAzureResumableDriver = (
  blockBlob: BlockBlobClient,
  container: string,
  key: string,
  opts: ResumableDriverOptions,
  wrapErr: (err: unknown) => FilesError
): PartsResumableDriver => {
  let blockSize =
    typeof opts.multipart === "object" && opts.multipart.partSize
      ? opts.multipart.partSize
      : AZURE_DEFAULT_BLOCK_SIZE;
  let contentType = "application/octet-stream";
  return {
    adopt(session: ResumableUploadSession) {
      if (session.provider !== "azure") {
        throw new FilesError(
          "Provider",
          `Cannot resume a ${session.provider} session on an Azure adapter.`
        );
      }
      if (session.container !== container || session.blob !== key) {
        throw new FilesError(
          "Provider",
          "Resume token does not match this upload's container/blob."
        );
      }
      ({ blockSize } = session);
      ({ contentType } = session);
    },
    begin(meta): Promise<ResumableUploadSession> {
      ({ contentType } = meta);
      return Promise.resolve({
        blob: key,
        blockSize,
        container,
        contentType,
        provider: "azure",
      });
    },
    async complete(parts: PartMeta[]): Promise<UploadResult> {
      try {
        const committed = await blockBlob.commitBlockList(
          parts.map((part) => azureBlockId(part.partNumber)),
          {
            blobHTTPHeaders: {
              blobContentType: contentType,
              ...(opts.cacheControl && { blobCacheControl: opts.cacheControl }),
            },
            ...(opts.metadata && { metadata: opts.metadata }),
          }
        );
        return {
          contentType,
          ...(committed.etag && { etag: stripEtag(committed.etag) }),
          key,
          ...(committed.lastModified && {
            lastModified: committed.lastModified.getTime(),
          }),
          size: parts.reduce((sum, part) => sum + part.size, 0),
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    discard() {
      // Uncommitted blocks are garbage-collected by Azure (~7 days). There's no
      // API to drop them explicitly without committing or deleting the blob, so
      // discard is a no-op — abort just stops staging new ones.
      return Promise.resolve();
    },
    mode: "parts",
    get partSize() {
      return blockSize;
    },
    async probe(): Promise<{ committedParts: PartMeta[] }> {
      try {
        const list = await blockBlob.getBlockList("uncommitted");
        const committedParts: PartMeta[] = [];
        for (const block of list.uncommittedBlocks ?? []) {
          const partNumber = decodeBlockNumber(block.name);
          if (partNumber !== undefined) {
            committedParts.push({ partNumber, size: block.size ?? 0 });
          }
        }
        return { committedParts };
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async uploadPart({ partNumber, data, signal }): Promise<PartMeta> {
      try {
        await blockBlob.stageBlock(
          azureBlockId(partNumber),
          uint8ToBuffer(data),
          data.byteLength,
          signal ? { abortSignal: signal } : undefined
        );
        return { partNumber, size: data.byteLength };
      } catch (error) {
        throw wrapErr(error);
      }
    },
  };
};

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
  signer?: AzureSasSigner;
  accountName?: string;
  endpoint: string;
  sasToken?: string;
}

type AzureSasSigner =
  | { kind: "sharedKey"; credential: StorageSharedKeyCredential }
  | {
      kind: "userDelegation";
      client: BlobServiceClient;
      cachedKey?: { key: UserDelegationKey; expiresOn: Date };
    };

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
    ...(sharedKey && {
      signer: {
        credential: sharedKey,
        kind: "sharedKey",
      } satisfies AzureSasSigner,
    }),
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
      signer: { credential: sharedKey, kind: "sharedKey" },
    };
  }

  if (opts.credential) {
    const client = new BlobServiceClient(endpoint, opts.credential);
    return {
      accountName,
      client,
      endpoint,
      ...(opts.useUserDelegationSas !== false && {
        signer: { client, kind: "userDelegation" } satisfies AzureSasSigner,
      }),
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

const requireSigner = (signer: AzureSasSigner | undefined): AzureSasSigner => {
  if (!signer) {
    throw new FilesError(
      "Provider",
      "azure: cannot sign URLs without a shared key or User Delegation SAS credential. Construct the adapter with `accountKey` + `accountName`, a `connectionString` that contains an account key, or `credential` + `accountName`; or set `publicBaseUrl` for a public container."
    );
  }
  return signer;
};

const getUserDelegationKey = async (
  signer: Extract<AzureSasSigner, { kind: "userDelegation" }>,
  startsOn: Date,
  sasExpiresOn: Date
): Promise<UserDelegationKey> => {
  // The cached key must outlive every SAS it signs, with slack for clock skew.
  const requiredUntil = sasExpiresOn.getTime() + USER_DELEGATION_KEY_SLACK_MS;
  if (
    !signer.cachedKey ||
    signer.cachedKey.expiresOn.getTime() <= requiredUntil
  ) {
    // Mint the key with a reuse window *beyond* what this SAS needs (capped at
    // Azure's 7-day max) so subsequent calls reuse it rather than refetching
    // one key per URL — the previous expiry tracked the SAS exactly, so the
    // common default-expiry path never hit the cache.
    const keyExpiresOn = new Date(
      Math.min(
        requiredUntil + USER_DELEGATION_KEY_TTL_MS,
        startsOn.getTime() + USER_DELEGATION_KEY_MAX_MS
      )
    );
    signer.cachedKey = {
      expiresOn: keyExpiresOn,
      key: await signer.client.getUserDelegationKey(startsOn, keyExpiresOn),
    };
  }
  return signer.cachedKey.key;
};

export const azure = (opts: AzureAdapterOptions): AzureAdapter => {
  const { container, publicBaseUrl } = opts;
  if (!container) {
    throw new FilesError(
      "Provider",
      "azure adapter: missing container. Pass `container`."
    );
  }

  const { client, sasToken, signer } = buildClient(opts);
  const containerClient = client.getContainerClient(container);
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  const buildSasUrl = async ({
    contentDisposition,
    expiresIn,
    key,
    permissions,
  }: {
    contentDisposition?: string;
    expiresIn: number;
    key: string;
    permissions: "r" | "cw";
  }): Promise<string> => {
    const resolvedSigner = requireSigner(signer);
    const blobClient = containerClient.getBlobClient(key);
    const startsOn = new Date(Date.now() - 60_000);
    const expiresOn = new Date(Date.now() + expiresIn * 1000);
    const sasOptions = {
      ...(contentDisposition && { contentDisposition }),
      expiresOn,
      permissions: BlobSASPermissions.parse(permissions),
      protocol: SASProtocol.Https,
      startsOn,
    };

    if (resolvedSigner.kind === "sharedKey") {
      const sas = generateBlobSASQueryParameters(
        {
          ...sasOptions,
          blobName: key,
          containerName: container,
        },
        resolvedSigner.credential
      );
      return `${blobClient.url}?${sas.toString()}`;
    }

    const userDelegationKey = await getUserDelegationKey(
      resolvedSigner,
      startsOn,
      expiresOn
    );
    return blobClient.generateUserDelegationSasUrl(
      sasOptions,
      userDelegationKey
    );
  };

  const buildCopySource = (fromKey: string): Promise<string> => {
    const baseUrl = containerClient.getBlobClient(fromKey).url;
    if (signer) {
      return buildSasUrl({
        expiresIn: COPY_SOURCE_SAS_SECONDS,
        key: fromKey,
        permissions: "r",
      });
    }
    if (sasToken) {
      return Promise.resolve(`${baseUrl}?${sasToken}`);
    }
    // Anonymous mode — only succeeds against public containers. Let Azure
    // return the natural error if it doesn't.
    return Promise.resolve(baseUrl);
  };

  return {
    bucket: container,
    async copy(from, to, operationOpts) {
      try {
        const sourceUrl = await buildCopySource(from);
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
        const range = downloadOpts?.range;
        // Azure takes a byte offset + count rather than an HTTP range string;
        // an omitted `end` maps to an undefined count (read to EOF). The
        // partial response reports the slice length in contentLength, so the
        // size handling below needs no special casing.
        const offset = range?.start ?? 0;
        const count =
          range?.end === undefined ? undefined : range.end - range.start + 1;
        const result = await blobClient.download(
          offset,
          count,
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
          offset,
          count,
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
    reportsUploadProgress: true,
    resumableUpload(key, resumableOpts) {
      return createAzureResumableDriver(
        containerClient.getBlockBlobClient(key),
        container,
        key,
        resumableOpts,
        mapAzureError
      );
    },
    async signedUploadUrl(key, signOpts): Promise<SignedUpload> {
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
      if (signOpts.contentType !== undefined) {
        throw new FilesError(
          "Provider",
          "azure: `contentType` is not supported for signed upload URLs. Azure SAS does not bind the request Content-Type into the signature, so validate it at your application gateway / proxy before issuing the SAS."
        );
      }
      try {
        const url = await buildSasUrl({
          expiresIn: signOpts.expiresIn,
          key,
          permissions: "cw",
        });
        return {
          headers: {
            "x-ms-blob-type": "BlockBlob",
          },
          method: "PUT",
          url,
        };
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    supportsRange: true,
    async upload(key, body, options) {
      const { cacheControl, metadata, multipart, onProgress, signal } =
        options ?? {};
      const { data, contentType, contentLength } = await normalizeBody(
        body,
        options?.contentType
      );
      const blockBlob = containerClient.getBlockBlobClient(key);
      // Azure already splits large bodies into parallel blocks; `multipart`
      // only tunes that — block size and how many blocks upload at once.
      const mp = typeof multipart === "object" ? multipart : undefined;
      const blockSize = mp?.partSize;
      const concurrency = mp?.concurrency;
      const writeOpts = {
        blobHTTPHeaders: {
          blobContentType: contentType,
          ...(cacheControl && { blobCacheControl: cacheControl }),
        },
        ...(metadata && { metadata }),
        ...(signal && { abortSignal: signal }),
        // `loadedBytes` is cumulative; surface it as `loaded`, pairing it with
        // the known length when we have one. Works for both upload paths below.
        ...(onProgress && {
          onProgress: ({ loadedBytes }: { loadedBytes: number }) =>
            onProgress(
              contentLength === undefined
                ? { loaded: loadedBytes }
                : { loaded: loadedBytes, total: contentLength }
            ),
        }),
      };
      try {
        const { etag, lastModified } = await runAzureUpload(
          blockBlob,
          data,
          writeOpts,
          blockSize,
          concurrency
        );
        let size = contentLength;
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
        return buildSasUrl({
          contentDisposition: urlOpts?.responseContentDisposition,
          expiresIn: urlOpts?.expiresIn ?? defaultUrlExpiresIn,
          key,
          permissions: "r",
        });
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
