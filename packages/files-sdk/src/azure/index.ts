import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

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
  ContainerListBlobFlatSegmentResponse,
  ContainerListBlobHierarchySegmentResponse,
  HttpAuthorization,
  UserDelegationKey,
} from "@azure/storage-blob";

import type {
  Adapter,
  DeleteManyError,
  DeleteManyOptions,
  DeleteManyResult,
  ListResult,
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
  deleteManyWithFallback,
  joinPublicUrl,
  makeErrorMapper,
  normalizeBody,
  resolveUrlStrategy,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { isObject, isString } from "../internal/is.js";
import { toNodeReadable, toWebStream } from "../internal/node-stream";
import { createStoredFile } from "../internal/stored-file.js";

const DEFAULT_CONTENT_TYPE = "application/octet-stream";

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
   * Falls back to `AZURE_STORAGE_CONNECTION_STRING`, but only when none of
   * `connectionString`, `accountKey`, `credential`, or `sasToken` is passed:
   * explicit auth options always beat ambient environment variables.
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
   * `AZURE_STORAGE_KEY`, when no explicit auth option is passed.
   */
  accountKey?: string;
  /**
   * Microsoft Entra credential used for Azure AD / Managed Identity workloads.
   * When supplied without a shared key, reads/writes/listing use token-based
   * auth and `url()` / `signedUploadUrl()` mint User Delegation SAS URLs.
   * A User Delegation SAS can live at most 7 days (the lifetime of the
   * delegation key that signs it): a longer `expiresIn` throws, and
   * `signedUrl.maxExpiresIn` reports the cap.
   *
   * The principal must be allowed to access blob data and call
   * `Microsoft.Storage/storageAccounts/blobServices/generateUserDelegationKey/action`
   * (for example via Storage Blob Delegator at the account scope).
   */
  credential?: TokenCredential;
  /**
   * Controls whether `credential`-backed adapters mint User Delegation SAS
   * URLs. Defaults to true when `credential` is supplied. Set false only when
   * you want token-authenticated SDK operations but no signed URL support;
   * `copy()` then authorizes its source with the credential's bearer token.
   */
  useUserDelegationSas?: boolean;
  /**
   * Pre-issued SAS token (with or without leading `?`). When set without
   * `accountKey`, `url()` and `signedUploadUrl()` cannot mint new SAS — they
   * throw a Provider error. Reading/writing/listing still works as long as
   * the SAS has the relevant permissions. Falls back to
   * `AZURE_STORAGE_SAS_TOKEN` when no explicit auth option is passed.
   */
  sasToken?: string;
  /**
   * Override the service endpoint host. Defaults to
   * `https://${accountName}.blob.core.windows.net`. Used for Azurite
   * (`http://127.0.0.1:10000/devstoreaccount1`) or sovereign clouds
   * (`*.blob.core.usgovcloudapi.net`, `*.blob.core.chinacloudapi.cn`). Also
   * wins over a connection string's endpoint when that connection string
   * carries an account key or SAS.
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
// Azure's Blob Batch API caps a single batch at 256 sub-requests.
const AZURE_BATCH_DELETE_MAX = 256;
const USER_DELEGATION_KEY_SLACK_MS = 5 * 60 * 1000;
// How long a freshly minted key stays reusable beyond the SAS it was first
// requested for, so back-to-back url()/signedUploadUrl() calls share one key
// instead of fetching one per URL.
const USER_DELEGATION_KEY_TTL_MS = 60 * 60 * 1000;
// Azure rejects user delegation keys whose lifetime exceeds 7 days, and a
// User Delegation SAS stops working once its key expires — so 7 days is also
// the longest `expiresIn` a user-delegation `url()` can honor.
const USER_DELEGATION_SAS_MAX_SECONDS = 7 * 24 * 60 * 60;
const USER_DELEGATION_KEY_MAX_MS = USER_DELEGATION_SAS_MAX_SECONDS * 1000;
// OAuth scope for Azure Storage data-plane tokens (the SDK's default audience).
const STORAGE_OAUTH_SCOPE = "https://storage.azure.com/.default";

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

/** The fields of an `@azure/storage-blob` `RestError` we classify on. */
interface RestErrorFields {
  code?: string | number;
  details?: { errorCode?: string };
  message?: string;
  statusCode?: number;
}

export const mapAzureError = makeErrorMapper({
  codes: {
    conflict: AZURE_CONFLICT_CODES,
    notFound: AZURE_NOT_FOUND_CODES,
    unauthorized: AZURE_UNAUTH_CODES,
  },
  extract: (cause) => {
    // SAFETY: every field is read optionally; a thrown value that is not an
    // Azure RestError (or not even an object) just yields no code/status/message.
    const e = cause as RestErrorFields | null | undefined;
    // Azure RestError carries the storage error code on `details.errorCode`
    // (the value from the response body) and the HTTP status on `statusCode`.
    // The top-level `code` is sometimes the same string and sometimes an SDK
    // class name, so prefer `details.errorCode` when present.
    const code =
      e?.details?.errorCode ?? (isString(e?.code) ? e.code : undefined);
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
    const node = toNodeReadable(data);
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
  wrapErr: (cause: unknown) => FilesError
): PartsResumableDriver => {
  let blockSize =
    isObject(opts.multipart) && opts.multipart.partSize
      ? opts.multipart.partSize
      : AZURE_DEFAULT_BLOCK_SIZE;
  let contentType = DEFAULT_CONTENT_TYPE;
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
        // "Committed" here means "staged and skippable", not durable: Azure
        // garbage-collects uncommitted blocks after ~7 days. That can't cause
        // a silent gap — complete()'s commitBlockList names every block id,
        // and Azure rejects the commit (InvalidBlockList) if any expired, so
        // a stale resume fails loudly and a retry re-probes correctly.
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
        const mapped = wrapErr(error);
        // Before the first block lands there is no blob at all (committed or
        // uncommitted), and Azure answers GetBlockList with 404 — that's an
        // empty session, not a missing upload.
        if (mapped.code === "NotFound") {
          return { committedParts: [] };
        }
        throw mapped;
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
  sasToken?: string;
}

const trimSas = (sas: string): string =>
  sas.startsWith("?") ? sas.slice(1) : sas;

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
    ...(parts.SharedAccessSignature && {
      sasToken: trimSas(parts.SharedAccessSignature),
    }),
  };
};

const defaultEndpoint = (accountName: string): string =>
  `https://${accountName}.blob.core.windows.net`;

interface AzureClientBundle {
  client: BlobServiceClient;
  sharedKey?: StorageSharedKeyCredential;
  signer?: AzureSasSigner;
  accountName?: string;
  endpoint: string;
  sasToken?: string;
  tokenCredential?: TokenCredential;
}

type AzureSasSigner =
  | { kind: "sharedKey"; credential: StorageSharedKeyCredential }
  | {
      kind: "userDelegation";
      client: BlobServiceClient;
      cachedKey?: { key: UserDelegationKey; expiresOn: Date };
    };

/**
 * Build the service client for an explicit `endpoint` from a connection
 * string's parsed credentials — `fromConnectionString` has no endpoint
 * override, so an explicit `endpoint` would otherwise be ignored. Returns
 * undefined when the connection string carries neither an account key nor a
 * SAS (e.g. `UseDevelopmentStorage=true`), leaving it to the SDK's parser.
 */
const clientForExplicitEndpoint = (
  endpoint: string,
  sharedKey: StorageSharedKeyCredential | undefined,
  sasToken: string | undefined
): BlobServiceClient | undefined => {
  if (sharedKey) {
    return new BlobServiceClient(endpoint, sharedKey);
  }
  if (sasToken) {
    return new BlobServiceClient(`${endpoint}?${sasToken}`);
  }
};

const buildFromConnectionString = (
  connectionString: string,
  opts: AzureAdapterOptions
): AzureClientBundle => {
  const parsed = parseConnectionString(connectionString);
  const accountName = opts.accountName ?? parsed.accountName;
  const accountKey = opts.accountKey ?? parsed.accountKey;
  const sharedKey =
    accountName && accountKey
      ? new StorageSharedKeyCredential(accountName, accountKey)
      : undefined;
  const client =
    (opts.endpoint &&
      clientForExplicitEndpoint(opts.endpoint, sharedKey, parsed.sasToken)) ||
    BlobServiceClient.fromConnectionString(connectionString);
  const endpoint =
    opts.endpoint ??
    parsed.endpoint ??
    (accountName ? defaultEndpoint(accountName) : client.url);
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
    ...(parsed.sasToken && { sasToken: parsed.sasToken }),
  };
};

const resolveAccountName = (opts: AzureAdapterOptions): string | undefined =>
  opts.accountName ??
  readEnv("AZURE_STORAGE_ACCOUNT_NAME") ??
  readEnv("AZURE_STORAGE_ACCOUNT");

/**
 * Read an auth env var — but only when the caller passed no explicit auth
 * option. An `AZURE_STORAGE_CONNECTION_STRING` or `AZURE_STORAGE_ACCOUNT_KEY`
 * left in the environment must never silently replace an explicit
 * `credential` or `sasToken`.
 */
const readAuthEnv = (
  opts: AzureAdapterOptions,
  ...keys: string[]
): string | undefined => {
  const explicitAuth = [
    opts.connectionString,
    opts.accountKey,
    opts.credential,
    opts.sasToken,
  ].some((value) => value !== undefined);
  if (explicitAuth) {
    return;
  }
  for (const key of keys) {
    const value = readEnv(key);
    if (value !== undefined) {
      return value;
    }
  }
};

const MISSING_CREDENTIALS_MESSAGE =
  "azure adapter: missing credentials. Pass `connectionString`, or `accountName` together with one of `accountKey`, `credential` (a Microsoft Entra TokenCredential), or `sasToken` — or `accountName` alone for a public-read container. Env fallbacks: AZURE_STORAGE_CONNECTION_STRING, or AZURE_STORAGE_ACCOUNT_NAME (or AZURE_STORAGE_ACCOUNT) with AZURE_STORAGE_ACCOUNT_KEY (or AZURE_STORAGE_KEY) or AZURE_STORAGE_SAS_TOKEN.";

const buildClient = (opts: AzureAdapterOptions): AzureClientBundle => {
  const connectionString =
    opts.connectionString ??
    readAuthEnv(opts, "AZURE_STORAGE_CONNECTION_STRING");
  if (connectionString) {
    return buildFromConnectionString(connectionString, opts);
  }

  const accountName = resolveAccountName(opts);
  if (!accountName) {
    throw new FilesError("Provider", MISSING_CREDENTIALS_MESSAGE);
  }

  const endpoint = opts.endpoint ?? defaultEndpoint(accountName);
  const accountKey =
    opts.accountKey ??
    readAuthEnv(opts, "AZURE_STORAGE_ACCOUNT_KEY", "AZURE_STORAGE_KEY");
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
      tokenCredential: opts.credential,
    };
  }

  const sasToken =
    opts.sasToken ?? readAuthEnv(opts, "AZURE_STORAGE_SAS_TOKEN");
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
): Promise<{ key: UserDelegationKey; expiresOn: Date }> => {
  // Azure's 7-day cap on the key, measured from `startsOn` (already a minute
  // in the past), so clock skew can't push a request over the limit.
  const maxKeyExpiresOn = startsOn.getTime() + USER_DELEGATION_KEY_MAX_MS;
  // The cached key must outlive every SAS it signs, with slack for clock skew
  // — up to that cap, past which the caller clamps the SAS to the key instead.
  const requiredUntil = Math.min(
    sasExpiresOn.getTime() + USER_DELEGATION_KEY_SLACK_MS,
    maxKeyExpiresOn
  );
  if (
    !signer.cachedKey ||
    signer.cachedKey.expiresOn.getTime() < requiredUntil
  ) {
    // Mint the key with a reuse window *beyond* what this SAS needs (capped at
    // Azure's 7-day max) so subsequent calls reuse it rather than refetching
    // one key per URL — the previous expiry tracked the SAS exactly, so the
    // common default-expiry path never hit the cache.
    const keyExpiresOn = new Date(
      Math.min(requiredUntil + USER_DELEGATION_KEY_TTL_MS, maxKeyExpiresOn)
    );
    signer.cachedKey = {
      expiresOn: keyExpiresOn,
      key: await signer.client.getUserDelegationKey(startsOn, keyExpiresOn),
    };
  }
  return signer.cachedKey;
};

/**
 * Clamp a buffered range read's byte count to what the blob actually holds.
 * `downloadToBuffer` allocates exactly `count` bytes and throws when the blob
 * runs out first, whereas the stream path's plain HTTP range is clamped
 * server-side. A start at or past EOF keeps the requested count so Azure
 * answers with its usual InvalidRange, as the stream path does.
 */
const clampRangeCount = (
  offset: number,
  count: number,
  size: number | undefined
): number =>
  size !== undefined && offset < size ? Math.min(count, size - offset) : count;

export const azure = (opts: AzureAdapterOptions): AzureAdapter => {
  const { container, publicBaseUrl } = opts;
  if (!container) {
    throw new FilesError(
      "Provider",
      "azure adapter: missing container. Pass `container`."
    );
  }

  const { client, sasToken, signer, tokenCredential } = buildClient(opts);
  const containerClient = client.getContainerClient(container);
  const defaultUrlExpiresIn =
    opts.defaultUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  // The lazy body behind head()/list() results runs after the operation has
  // returned, so it maps its own failures (a blob deleted in between reads as
  // NotFound) instead of leaking a raw RestError out of `text()`.
  const readBlobBytes = async (key: string): Promise<Uint8Array> => {
    try {
      const buf = await containerClient.getBlobClient(key).downloadToBuffer();
      return bufferToUint8(buf);
    } catch (error) {
      throw mapAzureError(error);
    }
  };

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

    if (expiresIn > USER_DELEGATION_SAS_MAX_SECONDS) {
      throw new FilesError(
        "Provider",
        `azure: \`expiresIn\` of ${expiresIn}s exceeds the ${USER_DELEGATION_SAS_MAX_SECONDS}s (7-day) maximum for a User Delegation SAS, which cannot outlive the delegation key that signs it. Request a shorter expiry, or sign with an account key (\`accountKey\` or a connection string) for longer-lived URLs.`
      );
    }
    const delegation = await getUserDelegationKey(
      resolvedSigner,
      startsOn,
      expiresOn
    );
    return blobClient.generateUserDelegationSasUrl(
      {
        ...sasOptions,
        // Only near the 7-day cap does the key end before the requested
        // expiry (by at most the clock-skew margin); never sign past the key.
        expiresOn: new Date(
          Math.min(expiresOn.getTime(), delegation.expiresOn.getTime())
        ),
      },
      delegation.key
    );
  };

  const buildCopySource = async (
    fromKey: string,
    signal: AbortSignal | undefined
  ): Promise<{ url: string; sourceAuthorization?: HttpAuthorization }> => {
    const baseUrl = containerClient.getBlobClient(fromKey).url;
    if (signer) {
      return {
        url: await buildSasUrl({
          expiresIn: COPY_SOURCE_SAS_SECONDS,
          key: fromKey,
          permissions: "r",
        }),
      };
    }
    if (tokenCredential) {
      // `useUserDelegationSas: false` leaves no SAS signer, and Copy Blob From
      // URL does not authorize a private source with the destination request's
      // token — so send the same Entra token as the source's bearer
      // authorization (`x-ms-copy-source-authorization`).
      const token = await tokenCredential.getToken(
        STORAGE_OAUTH_SCOPE,
        abortOpts(signal)
      );
      if (!token) {
        throw new FilesError(
          "Unauthorized",
          "azure: `credential` returned no access token to authorize the copy source."
        );
      }
      return {
        sourceAuthorization: { scheme: "Bearer", value: token.token },
        url: baseUrl,
      };
    }
    if (sasToken) {
      // The service client was built with the SAS in its URL, and the SDK
      // carries that query through to every blob URL — appending it again
      // would produce `?sv=…?sv=…` and a CannotVerifyCopySource rejection.
      return {
        url: baseUrl.includes("?") ? baseUrl : `${baseUrl}?${sasToken}`,
      };
    }
    // Anonymous mode — only succeeds against public containers. Let Azure
    // return the natural error if it doesn't.
    return { url: baseUrl };
  };

  return {
    bucket: container,
    async copy(from, to, operationOpts) {
      try {
        const signal = operationOpts?.signal;
        const source = await buildCopySource(from, signal);
        await containerClient.getBlobClient(to).syncCopyFromURL(source.url, {
          ...abortOpts(signal),
          ...(source.sourceAuthorization && {
            sourceAuthorization: source.sourceAuthorization,
          }),
        });
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
    async deleteMany(
      keys,
      deleteOpts?: DeleteManyOptions
    ): Promise<DeleteManyResult> {
      if (keys.length === 0) {
        return { deleted: [] };
      }
      // `stopOnError` wants to stop at the first failure, but a batch attempts
      // every key in the chunk regardless — so honor that mode through the
      // sequential fallback (matching supabase's stance).
      if (deleteOpts?.stopOnError) {
        return deleteManyWithFallback(
          keys,
          async (key) => {
            await containerClient.getBlobClient(key).deleteIfExists();
          },
          deleteOpts,
          mapAzureError
        );
      }
      const batchClient = client.getBlobBatchClient();
      const deleted: string[] = [];
      const errors: DeleteManyError[] = [];
      for (let i = 0; i < keys.length; i += AZURE_BATCH_DELETE_MAX) {
        const chunk = keys.slice(i, i + AZURE_BATCH_DELETE_MAX);
        const blobClients = chunk.map((key) =>
          containerClient.getBlobClient(key)
        );
        let response: Awaited<ReturnType<typeof batchClient.deleteBlobs>>;
        try {
          // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- chunked batch deletes merged into shared result accumulators in request order
          response = await batchClient.deleteBlobs(blobClients);
        } catch (error) {
          // A batch-level failure (auth, transport, malformed batch) fails
          // every key in this chunk.
          const mapped = mapAzureError(error);
          for (const key of chunk) {
            errors.push({ error: mapped, key });
          }
          continue;
        }
        // Sub-responses come back in request order. 2xx = deleted now; 404 =
        // already gone, which stays idempotent like `delete()`; anything else
        // (or a missing sub-response) is a real per-key failure.
        for (const [idx, key] of chunk.entries()) {
          const sub = response.subResponses[idx];
          const status = sub?.status;
          if (status === 404 || (status !== undefined && status < 300)) {
            deleted.push(key);
            continue;
          }
          errors.push({
            error: mapAzureError({
              ...(sub?.errorCode && { details: { errorCode: sub.errorCode } }),
              message:
                sub?.errorCode ??
                `Azure batch delete failed (HTTP ${status ?? "unknown"})`,
              ...(status !== undefined && { statusCode: status }),
            }),
            key,
          });
        }
      }
      return errors.length === 0 ? { deleted } : { deleted, errors };
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
        const toMeta = (props: {
          contentType?: string;
          etag?: string;
          lastModified?: Date;
          metadata?: Record<string, string>;
        }) => {
          const etag = stripEtag(props.etag);
          return {
            ...(etag && { etag }),
            key,
            ...(props.lastModified && {
              lastModified: props.lastModified.getTime(),
            }),
            ...(props.metadata && { metadata: props.metadata }),
            type: props.contentType ?? DEFAULT_CONTENT_TYPE,
          };
        };
        if (downloadOpts?.as === "stream") {
          const result = await blobClient.download(
            offset,
            count,
            abortOpts(downloadOpts.signal)
          );
          const baseMeta = toMeta(result);
          const size = Number(result.contentLength ?? 0);
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
                // SAFETY: under Node the SDK's body is a `stream.Readable`
                // (a RetriableReadableStream); its types only describe it
                // through the legacy `NodeJS.ReadableStream` interface, which
                // `Readable.toWeb` does not accept.
                const nodeReadable = node as Readable;
                return toWebStream(nodeReadable);
              },
              kind: "stream",
            }
          );
        }
        // Buffer path: fetch the metadata with a HEAD and the bytes via
        // downloadToBuffer (parallel range requests for large blobs). Opening
        // `download()` just for the headers would leave an unread GET body
        // holding its socket until GC. A bounded range waits for the HEAD so
        // its count can be clamped to the blob's size (see clampRangeCount).
        const propsPromise = blobClient.getProperties(
          abortOpts(downloadOpts?.signal)
        );
        const readBytes = async (): Promise<Buffer> => {
          if (count === undefined) {
            return await blobClient.downloadToBuffer(
              offset,
              undefined,
              abortOpts(downloadOpts?.signal)
            );
          }
          const head = await propsPromise;
          return await blobClient.downloadToBuffer(
            offset,
            clampRangeCount(offset, count, head.contentLength),
            abortOpts(downloadOpts?.signal)
          );
        };
        const [props, buf] = await Promise.all([propsPromise, readBytes()]);
        const bytes = bufferToUint8(buf);
        return createStoredFile(
          { ...toMeta(props), size: bytes.byteLength },
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
            ...(props.metadata && { metadata: props.metadata }),
            size: Number(props.contentLength ?? 0),
            type: props.contentType ?? DEFAULT_CONTENT_TYPE,
          },
          { factory: () => readBlobBytes(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapAzureError(error);
      }
    },
    async list(options) {
      try {
        const toItem = (item: BlobItemLike): StoredFile => {
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
              type: props.contentType ?? DEFAULT_CONTENT_TYPE,
            },
            { factory: () => readBlobBytes(itemKey), kind: "lazy" }
          );
        };
        // Hierarchy listing returns both blobs and "folders" (blobPrefixes);
        // nested so the flat `list` stays simple.
        const listByHierarchy = async (
          delimiter: string
        ): Promise<ListResult> => {
          const iterator = containerClient
            .listBlobsByHierarchy(delimiter, {
              includeMetadata: true,
              ...(options?.prefix && { prefix: options.prefix }),
              ...(options?.signal && { abortSignal: options.signal }),
            })
            .byPage({
              ...(options?.cursor && { continuationToken: options.cursor }),
              ...(options?.limit !== undefined && {
                maxPageSize: options.limit,
              }),
            });
          // `IteratorResult#value` is `any` on the done branch; the page is
          // the typed response, or undefined once the iterator is exhausted.
          const step = await iterator.next();
          const hierarchyPage:
            | ContainerListBlobHierarchySegmentResponse
            | undefined = step.value;
          const segment = hierarchyPage?.segment;
          const prefixes = (segment?.blobPrefixes ?? []).map((p) => p.name);
          const nextToken = hierarchyPage?.continuationToken;
          return {
            items: (segment?.blobItems ?? []).map(toItem),
            ...(nextToken && { cursor: nextToken }),
            ...(prefixes.length && { prefixes }),
          };
        };
        if (options?.delimiter) {
          return await listByHierarchy(options.delimiter);
        }
        const iterator = containerClient
          .listBlobsFlat({
            includeMetadata: true,
            ...(options?.prefix && { prefix: options.prefix }),
            ...(options?.signal && { abortSignal: options.signal }),
          })
          .byPage({
            ...(options?.cursor && { continuationToken: options.cursor }),
            ...(options?.limit !== undefined && {
              maxPageSize: options.limit,
            }),
          });
        // See `listByHierarchy` — type the page rather than read it as `any`.
        const step = await iterator.next();
        const page: ContainerListBlobFlatSegmentResponse | undefined =
          step.value;
        const segment = page?.segment;
        const items = (segment?.blobItems ?? []).map(toItem);
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
      // `minSize: 0` (no minimum) holds trivially; a positive floor has no
      // SAS equivalent, so fail closed like `maxSize`.
      if (signOpts.minSize !== undefined && signOpts.minSize > 0) {
        throw new FilesError(
          "Provider",
          "azure: `minSize` is not supported. Azure SAS has no minimum upload size constraint; pass `minSize: 0` or omit it, and reject small uploads at your application gateway / proxy."
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
    // `url()` mints a SAS (or returns `publicBaseUrl` when set) — only when a
    // signer exists; SAS-only and anonymous adapters throw. A User Delegation
    // SAS is capped at 7 days (`url()` throws above it); account-key SAS has
    // no such limit, so the cap is declared only in user-delegation mode.
    signedUrl: {
      supported: Boolean(signer),
      ...(signer?.kind === "userDelegation" && {
        maxExpiresIn: USER_DELEGATION_SAS_MAX_SECONDS,
      }),
    },
    supportsCacheControl: true,
    supportsDelimiter: true,
    supportsMetadata: true,
    supportsRange: true,
    // `copy()` is a server-side `syncCopyFromURL`.
    supportsServerSideCopy: true,
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
      const mp = isObject(multipart) ? multipart : undefined;
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
    async url(key, urlOpts): Promise<string> {
      const strategy = resolveUrlStrategy({
        publicBaseUrl,
        responseContentDisposition: urlOpts?.responseContentDisposition,
      });
      if (strategy === "public" && publicBaseUrl) {
        return joinPublicUrl(publicBaseUrl, key);
      }
      try {
        // Awaited so a rejected signing call (e.g. a 403 fetching the user
        // delegation key) is mapped here instead of escaping as a raw error.
        return await buildSasUrl({
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
