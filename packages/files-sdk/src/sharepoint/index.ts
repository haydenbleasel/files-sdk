import { Client } from "@microsoft/microsoft-graph-client";

import type {
  Adapter,
  Body,
  DownloadOptions,
  ListOptions,
  ListResult,
  SignUploadOptions,
  SignedUpload,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { buildAuthProvider, onedrive } from "../onedrive/index.js";
import type {
  OneDriveAdapter,
  OneDriveAdapterOptions,
} from "../onedrive/index.js";

export interface SharePointAdapterOptions {
  /**
   * Direct SharePoint site ID (`<host>,<id1>,<id2>` triple form from Graph).
   * Mutually exclusive with `siteUrl` / `hostname` / `sitePath`.
   * Falls back to `SHAREPOINT_SITE_ID`.
   */
  siteId?: string;
  /**
   * SharePoint site URL (e.g. `https://contoso.sharepoint.com/sites/marketing`).
   * Resolved to a site ID on first call via Graph
   * `/sites/{hostname}:{path}`. Falls back to `SHAREPOINT_SITE_URL`.
   */
  siteUrl?: string;
  /**
   * SharePoint hostname (e.g. `contoso.sharepoint.com`). Combine with
   * `sitePath`. Falls back to `SHAREPOINT_HOSTNAME`.
   */
  hostname?: string;
  /**
   * Site path on the hostname (e.g. `/sites/marketing`). Used with
   * `hostname`. Defaults to the tenant root when omitted.
   */
  sitePath?: string;
  /**
   * Name of the SharePoint document library to target (e.g. `Documents`,
   * `Reports`). Resolved to a drive ID on first call. Omit to use the
   * site's default library. Falls back to `SHAREPOINT_DOCUMENT_LIBRARY`.
   */
  documentLibrary?: string;
  /**
   * Explicit drive ID. Skips both site and library resolution entirely.
   * Falls back to `SHAREPOINT_DRIVE_ID`.
   */
  driveId?: string;
  /**
   * App-only (client credentials) auth. Same shape as `onedrive()`. Falls
   * back to `SHAREPOINT_TENANT_ID` + `SHAREPOINT_CLIENT_ID` +
   * `SHAREPOINT_CLIENT_SECRET`, then to the `ONEDRIVE_*` equivalents.
   */
  clientCredentials?: OneDriveAdapterOptions["clientCredentials"];
  /**
   * Delegated OAuth refresh-token auth. Same shape as `onedrive()`.
   */
  oauth?: OneDriveAdapterOptions["oauth"];
  /**
   * Static or dynamic access token. Same shape as `onedrive()`. Falls back
   * to `SHAREPOINT_ACCESS_TOKEN` then `ONEDRIVE_ACCESS_TOKEN`.
   */
  accessToken?: OneDriveAdapterOptions["accessToken"];
  /**
   * Pre-built `@microsoft/microsoft-graph-client` `Client`. Same escape
   * hatch as `onedrive()`.
   */
  client?: Client;
  /**
   * Logical "bucket root" — virtual keys live under this folder path within
   * the document library. Must already exist on the drive. Defaults to the
   * drive root.
   */
  rootFolderPath?: string;
  /**
   * Mint an anonymous-view sharing link on every upload and return it from
   * `url()`. Defaults to `false` — `url()` throws when off. Subject to
   * tenant link-sharing policy.
   */
  publicByDefault?: boolean;
  /**
   * Maximum time (ms) to wait for a copy operation. Same semantics as
   * `onedrive()`.
   */
  copyTimeoutMs?: number;
}

export type SharePointAdapter = Adapter<Client> & {
  readonly rootFolderPath: string;
};

interface GraphSite {
  id?: string;
}

interface GraphDrive {
  id?: string;
  name?: string;
}

interface GraphDriveList {
  value?: GraphDrive[];
}

const parseSiteUrl = (url: string): { hostname: string; sitePath: string } => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new FilesError(
      "Provider",
      `sharepoint: siteUrl "${url}" is not a valid URL.`
    );
  }
  return {
    hostname: parsed.host,
    sitePath: parsed.pathname.replace(/^\/+/u, ""),
  };
};

const envCredentials = ():
  | { tenantId: string; clientId: string; clientSecret: string }
  | undefined => {
  const tenantId =
    readEnv("SHAREPOINT_TENANT_ID") ?? readEnv("ONEDRIVE_TENANT_ID");
  const clientId =
    readEnv("SHAREPOINT_CLIENT_ID") ?? readEnv("ONEDRIVE_CLIENT_ID");
  const clientSecret =
    readEnv("SHAREPOINT_CLIENT_SECRET") ?? readEnv("ONEDRIVE_CLIENT_SECRET");
  if (tenantId && clientId && clientSecret) {
    return { clientId, clientSecret, tenantId };
  }
  return undefined;
};

const buildOneDriveAuthOptions = (
  opts: SharePointAdapterOptions
): Pick<
  OneDriveAdapterOptions,
  "clientCredentials" | "oauth" | "accessToken" | "client"
> => {
  if (opts.client) {
    return { client: opts.client };
  }
  if (opts.clientCredentials) {
    return { clientCredentials: opts.clientCredentials };
  }
  if (opts.oauth) {
    return { oauth: opts.oauth };
  }
  if (opts.accessToken !== undefined) {
    return { accessToken: opts.accessToken };
  }
  const envToken =
    readEnv("SHAREPOINT_ACCESS_TOKEN") ?? readEnv("ONEDRIVE_ACCESS_TOKEN");
  if (envToken) {
    return { accessToken: envToken };
  }
  const envCreds = envCredentials();
  if (envCreds) {
    return { clientCredentials: envCreds };
  }
  throw new FilesError(
    "Provider",
    "sharepoint: missing auth. Pass `clientCredentials`, `oauth`, `accessToken`, or `client`. Env fallbacks: SHAREPOINT_ACCESS_TOKEN, or SHAREPOINT_TENANT_ID + SHAREPOINT_CLIENT_ID + SHAREPOINT_CLIENT_SECRET (or the ONEDRIVE_ equivalents)."
  );
};

const buildResolverClient = (
  authOpts: ReturnType<typeof buildOneDriveAuthOptions>
): Client => {
  if (authOpts.client) {
    return authOpts.client;
  }
  const authProvider = buildAuthProvider(authOpts as OneDriveAdapterOptions);
  if (!authProvider) {
    throw new FilesError(
      "Provider",
      "sharepoint: failed to build Graph auth provider — credentials missing."
    );
  }
  return Client.initWithMiddleware({ authProvider });
};

const resolveSiteId = async (
  client: Client,
  opts: SharePointAdapterOptions
): Promise<string> => {
  const explicit = opts.siteId ?? readEnv("SHAREPOINT_SITE_ID");
  if (explicit) {
    return explicit;
  }
  const url = opts.siteUrl ?? readEnv("SHAREPOINT_SITE_URL");
  let hostname = opts.hostname ?? readEnv("SHAREPOINT_HOSTNAME");
  let { sitePath } = opts;
  if (url) {
    const parsed = parseSiteUrl(url);
    ({ hostname } = parsed);
    ({ sitePath } = parsed);
  }
  if (!hostname) {
    throw new FilesError(
      "Provider",
      "sharepoint: site selection required. Pass `siteId`, `siteUrl`, or `hostname` (with optional `sitePath`)."
    );
  }
  const path = sitePath
    ? `/sites/${hostname}:/${sitePath.replace(/^\/+/u, "")}`
    : `/sites/${hostname}`;
  const site = (await client.api(path).get()) as GraphSite;
  if (!site.id) {
    const sitePathSuffix = sitePath ? `/${sitePath}` : "";
    throw new FilesError(
      "Provider",
      `sharepoint: site lookup for "${hostname}${sitePathSuffix}" returned no id.`
    );
  }
  return site.id;
};

const resolveDriveId = async (
  client: Client,
  siteId: string,
  documentLibrary: string
): Promise<string> => {
  const drives = (await client
    .api(`/sites/${siteId}/drives`)
    .get()) as GraphDriveList;
  const match = (drives.value ?? []).find((d) => d.name === documentLibrary);
  if (!match?.id) {
    const available = (drives.value ?? [])
      .flatMap((d) => (d.name ? [d.name] : []))
      .join(", ");
    throw new FilesError(
      "Provider",
      `sharepoint: document library "${documentLibrary}" not found on site. Available libraries: ${available || "(none)"}`
    );
  }
  return match.id;
};

const relabelError = (err: unknown): unknown => {
  if (
    err instanceof FilesError &&
    typeof err.message === "string" &&
    err.message.includes("OneDrive error")
  ) {
    return new FilesError(
      err.code,
      err.message.replaceAll("OneDrive error", "SharePoint error"),
      err.cause
    );
  }
  return err;
};

export const sharepoint = (
  opts: SharePointAdapterOptions = {}
): SharePointAdapter => {
  const authOpts = buildOneDriveAuthOptions(opts);
  const resolverClient = buildResolverClient(authOpts);

  // Memoized resolver — the first method call triggers Graph traffic to
  // resolve siteId/driveId; subsequent calls reuse the result.
  let resolved: Promise<OneDriveAdapter> | undefined;
  const resolve = (): Promise<OneDriveAdapter> => {
    if (resolved) {
      return resolved;
    }
    resolved = (async (): Promise<OneDriveAdapter> => {
      try {
        const explicitDriveId = opts.driveId ?? readEnv("SHAREPOINT_DRIVE_ID");
        let driveId: string;
        if (explicitDriveId) {
          driveId = explicitDriveId;
        } else {
          const siteId = await resolveSiteId(resolverClient, opts);
          const libraryName =
            opts.documentLibrary ?? readEnv("SHAREPOINT_DOCUMENT_LIBRARY");
          if (libraryName) {
            driveId = await resolveDriveId(resolverClient, siteId, libraryName);
          } else {
            const defaultDrive = (await resolverClient
              .api(`/sites/${siteId}/drive`)
              .get()) as GraphDrive;
            if (!defaultDrive.id) {
              throw new FilesError(
                "Provider",
                `sharepoint: default drive lookup for site "${siteId}" returned no id.`
              );
            }
            driveId = defaultDrive.id;
          }
        }
        return onedrive({
          client: resolverClient,
          driveId,
          ...(opts.rootFolderPath && { rootFolderPath: opts.rootFolderPath }),
          ...(opts.publicByDefault !== undefined && {
            publicByDefault: opts.publicByDefault,
          }),
          ...(opts.copyTimeoutMs !== undefined && {
            copyTimeoutMs: opts.copyTimeoutMs,
          }),
        });
      } catch (error) {
        // Don't cache failures — let a subsequent call re-attempt resolution.
        // oxlint-disable-next-line sonarjs/no-undefined-assignment -- undefined clears the memoized promise so the next call re-resolves; null would be a cached (falsy) value
        resolved = undefined;
        throw error;
      }
    })();
    return resolved;
  };

  const call = async <T>(
    fn: (inner: OneDriveAdapter) => Promise<T>
  ): Promise<T> => {
    try {
      const inner = await resolve();
      return await fn(inner);
    } catch (error) {
      throw relabelError(error);
    }
  };

  return {
    copy: (from: string, to: string) => call((inner) => inner.copy(from, to)),
    delete: (key: string) => call((inner) => inner.delete(key)),
    download: (key: string, downloadOpts?: DownloadOptions) =>
      call((inner) => inner.download(key, downloadOpts)),
    exists: (key: string) => call((inner) => inner.exists(key)),
    head: (key: string) => call((inner) => inner.head(key)),
    list: (listOpts?: ListOptions): Promise<ListResult> =>
      call((inner) => inner.list(listOpts)),
    name: "sharepoint",
    raw: resolverClient,
    get rootFolderPath(): string {
      // The inner adapter normalizes the path; surface it once resolution
      // has happened. Before resolution, fall back to the raw input.
      return opts.rootFolderPath?.replaceAll(/^\/+|(?<!\/)\/+$/gu, "") ?? "";
    },
    signedUploadUrl: (
      key: string,
      signOpts: SignUploadOptions
    ): Promise<SignedUpload> =>
      call((inner) => inner.signedUploadUrl(key, signOpts)),
    // Delegates to the inner onedrive adapter — same Graph limitation: no
    // signed-URL primitive, so `url()` needs `publicByDefault`.
    signedUrl: { supported: false },
    // Delegates to the inner onedrive adapter, which returns folder common
    // prefixes for a "/" delimiter; listOpts (incl. delimiter) is forwarded.
    supportsDelimiter: true,
    // Delegates to the inner onedrive adapter, which honors Range on Graph's
    // /content endpoint; downloadOpts (incl. range) is forwarded above.
    supportsRange: true,
    // Delegates to the inner onedrive adapter's server-side Graph `/copy`.
    supportsServerSideCopy: true,
    upload: (
      key: string,
      body: Body,
      uploadOpts?: UploadOptions
    ): Promise<UploadResult> =>
      call((inner) => inner.upload(key, body, uploadOpts)),
    url: (key: string, urlOpts?: UrlOptions) =>
      call((inner) => inner.url(key, urlOpts)),
  };
};
