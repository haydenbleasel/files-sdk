import { Files } from "../index.js";
import type { FilesOptions } from "../index.js";
import { FilesError } from "../internal/errors.js";
import { PROVIDER_NAMES, PROVIDERS } from "./registry.js";
import type { ProviderOpts } from "./registry.js";

export interface GlobalCliOptions {
  provider?: string;
  /**
   * Scope every operation under this key prefix — maps to `FilesOptions.prefix`
   * on the constructed {@link Files} instance, not the per-call `list` filter.
   */
  prefix?: string;
  /**
   * Per-attempt timeout in milliseconds, applied to every command as the
   * instance default ({@link OperationOptions.timeout}).
   */
  timeout?: number;
  /**
   * Retry provider failures up to this many times, applied to every command
   * as the instance default ({@link OperationOptions.retries}).
   */
  retries?: number;
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  publicBaseUrl?: string;
  defaultUrlExpiresIn?: number;
  root?: string;
  urlBaseUrl?: string;
  token?: string;
  access?: "public" | "private";
  accountName?: string;
  accountKey?: string;
  container?: string;
  connectionString?: string;
  siteId?: string;
  storeName?: string;
  accountId?: string;
  url?: string;
  serviceRoleKey?: string;
  applicationKeyId?: string;
  applicationKey?: string;
  projectId?: string;
  keyFilename?: string;
  configJson?: Record<string, unknown>;
}

const pickProvider = (opts: GlobalCliOptions): string => {
  const name = opts.provider ?? process.env.FILES_SDK_PROVIDER;
  if (!name) {
    throw new FilesError(
      "Provider",
      `--provider is required (or set FILES_SDK_PROVIDER). One of: ${PROVIDER_NAMES.join(", ")}`
    );
  }
  if (!(name in PROVIDERS)) {
    throw new FilesError(
      "Provider",
      `unknown provider "${name}". One of: ${PROVIDER_NAMES.join(", ")}`
    );
  }
  return name;
};

const toProviderOpts = (opts: GlobalCliOptions): ProviderOpts => ({
  access: opts.access,
  accessKeyId: opts.accessKeyId,
  accountId: opts.accountId,
  accountKey: opts.accountKey,
  accountName: opts.accountName,
  applicationKey: opts.applicationKey,
  applicationKeyId: opts.applicationKeyId,
  bucket: opts.bucket,
  connectionString: opts.connectionString,
  container: opts.container,
  defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
  endpoint: opts.endpoint,
  extra: opts.configJson,
  forcePathStyle: opts.forcePathStyle,
  keyFilename: opts.keyFilename,
  projectId: opts.projectId,
  publicBaseUrl: opts.publicBaseUrl,
  region: opts.region,
  root: opts.root,
  secretAccessKey: opts.secretAccessKey,
  serviceRoleKey: opts.serviceRoleKey,
  sessionToken: opts.sessionToken,
  siteId: opts.siteId,
  storeName: opts.storeName,
  token: opts.token,
  url: opts.url,
  urlBaseUrl: opts.urlBaseUrl,
});

export interface LoadResult {
  files: Files;
  provider: string;
}

export const loadFiles = async (
  opts: GlobalCliOptions
): Promise<LoadResult> => {
  const provider = pickProvider(opts);
  const entry = PROVIDERS[provider];
  if (!entry) {
    throw new FilesError("Provider", `unknown provider "${provider}"`);
  }
  try {
    const adapter = await entry.load(toProviderOpts(opts));
    // `prefix` / `timeout` / `retries` are Files-instance concerns, not adapter
    // config, so they're threaded straight into the constructor (omitted when
    // unset so the SDK defaults stand). `retries` is a bare count, which
    // RetryOptions accepts as `{ max }`.
    const filesOpts: FilesOptions<typeof adapter> = { adapter };
    if (opts.prefix !== undefined) {
      filesOpts.prefix = opts.prefix;
    }
    if (opts.timeout !== undefined) {
      filesOpts.timeout = opts.timeout;
    }
    if (opts.retries !== undefined) {
      filesOpts.retries = opts.retries;
    }
    return { files: new Files(filesOpts), provider };
  } catch (error) {
    // The adapter's own missing-required-field error is the most accurate
    // message — wrap it with the provider's `notes` hint so OAuth-only
    // providers don't leave the user guessing where to plug credentials in.
    if (entry.notes && error instanceof Error) {
      throw new FilesError(
        error instanceof FilesError ? error.code : "Provider",
        `${error.message}\n  hint: ${entry.notes}`
      );
    }
    throw error;
  }
};

export const describeProvider = (opts: GlobalCliOptions): string =>
  pickProvider(opts);
