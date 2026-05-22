import type { Adapter } from "../index.js";

/**
 * One registry entry per provider. Each entry knows how to lazy-import its
 * adapter module and construct an instance from a flat opts blob.
 *
 * Provider-specific env vars are read by the adapter itself (every adapter
 * calls `readEnv` for its own conventions — `AWS_*`, `BLOB_READ_WRITE_TOKEN`,
 * etc.), so the registry only needs to thread the values the CLI captured
 * from flags or `--config-json`.
 */
export interface ProviderRegistration {
  /** Human-readable list of required flags or env vars, for `--help` and errors. */
  required: readonly string[];
  /**
   * Optional one-line note surfaced in errors and `--help`. Use this for
   * providers whose configuration doesn't fit the typed flag set — most
   * commonly the OAuth-token providers, where the only path is
   * `--config-json` (or the adapter's own env vars).
   */
  notes?: string;
  /** Construct the adapter from a flat opts object. */
  load: (opts: ProviderOpts) => Promise<Adapter>;
}

/**
 * Union of every shortcut flag the CLI surfaces, plus a passthrough
 * `extra` blob populated from `--config-json`. Each provider's `load`
 * picks the fields it knows about and ignores the rest.
 */
export interface ProviderOpts {
  // S3 family + GCS-style buckets
  bucket?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  publicBaseUrl?: string;
  defaultUrlExpiresIn?: number;

  // Filesystem
  root?: string;
  urlBaseUrl?: string;

  // Vercel Blob / token-based providers
  token?: string;
  access?: "public" | "private";

  // Azure
  accountName?: string;
  accountKey?: string;
  container?: string;
  connectionString?: string;

  // Netlify Blobs
  siteId?: string;
  storeName?: string;

  // Cloudflare R2
  accountId?: string;

  // Supabase
  url?: string;
  serviceRoleKey?: string;

  // Backblaze B2
  applicationKeyId?: string;
  applicationKey?: string;

  // Google Cloud Storage
  projectId?: string;
  keyFilename?: string;

  // Catch-all for the long tail. Merged shallowly *under* the typed fields
  // so the typed flags win — gives the user a way to pass any option the
  // adapter accepts without us hand-coding a flag for it.
  extra?: Record<string, unknown>;
}

// The CLI resolves options at runtime from a flat blob (flags + env +
// --config-json). Adapter factories have strict typed signatures (e.g. some
// require a non-optional `region`), so we keep the merge result as
// `Record<string, unknown>` and cast to the factory's parameter type at the
// call site. Runtime validation in each adapter surfaces missing-required
// fields loudly, which is the right place for that error.
type AnyOpts = Record<string, unknown>;

const merge = (typed: AnyOpts, extra: AnyOpts | undefined): AnyOpts => ({
  ...extra,
  ...typed,
});

const stripUndefined = (o: AnyOpts): AnyOpts => {
  const out: AnyOpts = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
};

const cast = <F extends (opts: never) => unknown>(
  factory: F,
  opts: AnyOpts
): ReturnType<F> => factory(opts as Parameters<F>[0]) as ReturnType<F>;

const s3Credentials = (opts: ProviderOpts) =>
  opts.accessKeyId && opts.secretAccessKey
    ? {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      }
    : undefined;

const s3LikeOpts = (opts: ProviderOpts): AnyOpts =>
  stripUndefined({
    // The s3() adapter reads credentials as a nested object; every other
    // S3-compatible wrapper (akamai, vultr, wasabi, …) reads flat
    // accessKeyId/secretAccessKey and rewraps them internally. Thread both
    // forms so the CLI's --access-key-id flag works against any wrapper.
    accessKeyId: opts.accessKeyId,
    bucket: opts.bucket,
    credentials: s3Credentials(opts),
    defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
    endpoint: opts.endpoint,
    forcePathStyle: opts.forcePathStyle,
    publicBaseUrl: opts.publicBaseUrl,
    region: opts.region,
    secretAccessKey: opts.secretAccessKey,
    sessionToken: opts.sessionToken,
  });

export const PROVIDERS: Record<string, ProviderRegistration> = {
  akamai: {
    load: async (opts) => {
      const { akamai } = await import("../akamai/index.js");
      return cast(akamai, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--endpoint"],
  },
  alibaba: {
    load: async (opts) => {
      const { alibaba } = await import("../alibaba/index.js");
      return cast(alibaba, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  appwrite: {
    load: async (opts) => {
      const { appwrite } = await import("../appwrite/index.js");
      return cast(appwrite, merge({}, opts.extra));
    },
    notes:
      "configure via --config-json (endpoint, projectId, apiKey, bucketId) or APPWRITE_* env vars",
    required: [],
  },
  azure: {
    load: async (opts) => {
      const { azure } = await import("../azure/index.js");
      return cast(
        azure,
        merge(
          stripUndefined({
            accountKey: opts.accountKey,
            accountName: opts.accountName,
            connectionString: opts.connectionString,
            container: opts.container as string,
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
            publicBaseUrl: opts.publicBaseUrl,
          }),
          opts.extra
        )
      );
    },
    required: ["--container"],
  },
  "backblaze-b2": {
    load: async (opts) => {
      const { backblazeB2 } = await import("../backblaze-b2/index.js");
      return cast(backblazeB2, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket"],
  },
  box: {
    load: async (opts) => {
      const { box } = await import("../box/index.js");
      return cast(box, merge({}, opts.extra));
    },
    notes:
      "OAuth-based — configure via --config-json (clientId, clientSecret, refreshToken, etc.) or BOX_* env vars",
    required: [],
  },
  "bunny-storage": {
    load: async (opts) => {
      const { bunnyStorage } = await import("../bunny-storage/index.js");
      return cast(bunnyStorage, merge({}, opts.extra));
    },
    notes:
      "configure via --config-json (zone, accessKey, region, publicBaseUrl) or BUNNY_STORAGE_* env vars (STORAGE_* as aliases)",
    required: [],
  },
  cloudinary: {
    load: async (opts) => {
      const { cloudinaryAdapter } = await import("../cloudinary/index.js");
      return cast(cloudinaryAdapter, merge({}, opts.extra));
    },
    notes:
      "configure via --config-json (cloudName, apiKey, apiSecret) or CLOUDINARY_URL env var",
    required: [],
  },
  "digitalocean-spaces": {
    load: async (opts) => {
      const { digitaloceanSpaces } =
        await import("../digitalocean-spaces/index.js");
      return cast(digitaloceanSpaces, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  dropbox: {
    load: async (opts) => {
      const { dropbox } = await import("../dropbox/index.js");
      return cast(
        dropbox,
        merge(stripUndefined({ accessToken: opts.token }), opts.extra)
      );
    },
    notes:
      "OAuth-based — pass --token <accessToken>, or use --config-json for refresh-token flows / DROPBOX_ACCESS_TOKEN env var",
    required: [],
  },
  exoscale: {
    load: async (opts) => {
      const { exoscale } = await import("../exoscale/index.js");
      return cast(exoscale, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  filebase: {
    load: async (opts) => {
      const { filebase } = await import("../filebase/index.js");
      return cast(filebase, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket"],
  },
  "firebase-storage": {
    load: async (opts) => {
      const { firebaseStorage } = await import("../firebase-storage/index.js");
      return cast(
        firebaseStorage,
        merge(
          stripUndefined({
            bucket: opts.bucket,
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
            projectId: opts.projectId,
            publicBaseUrl: opts.publicBaseUrl,
            serviceAccountPath: opts.keyFilename,
          }),
          opts.extra
        )
      );
    },
    notes:
      "Service-account credentials — pass --key-filename for a JSON file, or use --config-json for inline credentials / FIREBASE_* env vars",
    required: [],
  },
  fs: {
    load: async (opts) => {
      const { fs } = await import("../fs/index.js");
      return cast(
        fs,
        merge(
          stripUndefined({
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
            root: opts.root as string,
            urlBaseUrl: opts.urlBaseUrl,
          }),
          opts.extra
        )
      );
    },
    required: ["--root"],
  },
  ftp: {
    load: async (opts) => {
      const { ftp } = await import("../ftp/index.js");
      return cast(
        ftp,
        merge(stripUndefined({ publicBaseUrl: opts.publicBaseUrl }), opts.extra)
      );
    },
    notes:
      "connection via --config-json (host, port, user, password, secure, root) or FTP_* env vars",
    required: [],
  },
  gcs: {
    load: async (opts) => {
      const { gcs } = await import("../gcs/index.js");
      return cast(
        gcs,
        merge(
          stripUndefined({
            bucket: opts.bucket as string,
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
            keyFilename: opts.keyFilename,
            projectId: opts.projectId,
            publicBaseUrl: opts.publicBaseUrl,
          }),
          opts.extra
        )
      );
    },
    required: ["--bucket"],
  },
  "google-drive": {
    load: async (opts) => {
      const { googleDrive } = await import("../google-drive/index.js");
      return cast(googleDrive, merge({}, opts.extra));
    },
    notes:
      "OAuth-based — configure via --config-json (clientId, clientSecret, refreshToken, folderId) or GOOGLE_* env vars",
    required: [],
  },
  hetzner: {
    load: async (opts) => {
      const { hetzner } = await import("../hetzner/index.js");
      return cast(hetzner, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  "ibm-cos": {
    load: async (opts) => {
      const { ibmCos } = await import("../ibm-cos/index.js");
      return cast(ibmCos, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--endpoint"],
  },
  "idrive-e2": {
    load: async (opts) => {
      const { idriveE2 } = await import("../idrive-e2/index.js");
      return cast(idriveE2, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--endpoint"],
  },
  minio: {
    load: async (opts) => {
      const { minio } = await import("../minio/index.js");
      return cast(minio, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--endpoint"],
  },
  "netlify-blobs": {
    load: async (opts) => {
      const { netlifyBlobs } = await import("../netlify-blobs/index.js");
      return cast(
        netlifyBlobs,
        merge(
          stripUndefined({
            name: opts.storeName as string,
            siteID: opts.siteId,
            token: opts.token,
          }),
          opts.extra
        )
      );
    },
    required: ["--store-name"],
  },
  onedrive: {
    load: async (opts) => {
      const { onedrive } = await import("../onedrive/index.js");
      return cast(onedrive, merge({}, opts.extra));
    },
    notes:
      "OAuth-based — configure via --config-json (Microsoft Graph clientId, clientSecret, tenantId, etc.)",
    required: [],
  },
  "oracle-cloud": {
    load: async (opts) => {
      const { oracleCloud } = await import("../oracle-cloud/index.js");
      return cast(oracleCloud, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region", "--endpoint"],
  },
  ovhcloud: {
    load: async (opts) => {
      const { ovhcloud } = await import("../ovhcloud/index.js");
      return cast(ovhcloud, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  pocketbase: {
    load: async (opts) => {
      const { pocketbase } = await import("../pocketbase/index.js");
      return cast(
        pocketbase,
        merge(
          stripUndefined({
            publicBaseUrl: opts.publicBaseUrl,
            url: opts.url,
          }),
          opts.extra
        )
      );
    },
    notes:
      "configure via --config-json (collection, adminEmail, adminPassword, authToken, keyField, fileField) or POCKETBASE_* env vars; --url sets the backend URL",
    required: [],
  },
  r2: {
    load: async (opts) => {
      const { r2 } = await import("../r2/index.js");
      return cast(
        r2,
        merge(
          stripUndefined({
            accessKeyId: opts.accessKeyId,
            accountId: opts.accountId,
            bucket: opts.bucket as string,
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
            publicBaseUrl: opts.publicBaseUrl,
            secretAccessKey: opts.secretAccessKey,
          }),
          opts.extra
        )
      );
    },
    required: ["--bucket"],
  },
  s3: {
    load: async (opts) => {
      const { s3 } = await import("../s3/index.js");
      return cast(s3, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket"],
  },
  scaleway: {
    load: async (opts) => {
      const { scaleway } = await import("../scaleway/index.js");
      return cast(scaleway, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  sftp: {
    load: async (opts) => {
      const { sftp } = await import("../sftp/index.js");
      return cast(
        sftp,
        merge(stripUndefined({ publicBaseUrl: opts.publicBaseUrl }), opts.extra)
      );
    },
    notes:
      "connection via --config-json (host, port, username, password, privateKey, root) or SFTP_* env vars",
    required: [],
  },
  sharepoint: {
    load: async (opts) => {
      const { sharepoint } = await import("../sharepoint/index.js");
      return cast(sharepoint, merge({}, opts.extra));
    },
    notes:
      "OAuth-based — configure via --config-json (Microsoft Graph clientId, clientSecret, tenantId, siteId, driveId)",
    required: [],
  },
  storj: {
    load: async (opts) => {
      const { storj } = await import("../storj/index.js");
      return cast(storj, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket"],
  },
  supabase: {
    load: async (opts) => {
      const { supabase } = await import("../supabase/index.js");
      return cast(
        supabase,
        merge(
          stripUndefined({
            bucket: opts.bucket as string,
            defaultUrlExpiresIn: opts.defaultUrlExpiresIn,
            key: opts.serviceRoleKey,
            url: opts.url,
          }),
          opts.extra
        )
      );
    },
    required: ["--bucket"],
  },
  tencent: {
    load: async (opts) => {
      const { tencent } = await import("../tencent/index.js");
      return cast(tencent, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  tigris: {
    load: async (opts) => {
      const { tigris } = await import("../tigris/index.js");
      return cast(tigris, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket"],
  },
  uploadthing: {
    load: async (opts) => {
      const { uploadthing } = await import("../uploadthing/index.js");
      return cast(
        uploadthing,
        merge(stripUndefined({ token: opts.token }), opts.extra)
      );
    },
    notes: "pass --token <uploadthingToken> or set UPLOADTHING_TOKEN",
    required: [],
  },
  "vercel-blob": {
    load: async (opts) => {
      const { vercelBlob } = await import("../vercel-blob/index.js");
      return cast(
        vercelBlob,
        merge(
          stripUndefined({
            access: opts.access,
            token: opts.token,
          }),
          opts.extra
        )
      );
    },
    required: [],
  },
  vultr: {
    load: async (opts) => {
      const { vultr } = await import("../vultr/index.js");
      return cast(vultr, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  wasabi: {
    load: async (opts) => {
      const { wasabi } = await import("../wasabi/index.js");
      return cast(wasabi, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket", "--region"],
  },
  yandex: {
    load: async (opts) => {
      const { yandex } = await import("../yandex/index.js");
      return cast(yandex, merge(s3LikeOpts(opts), opts.extra));
    },
    required: ["--bucket"],
  },
};

/**
 * Providers in the `files-sdk/providers` catalog that the CLI deliberately
 * does not surface. `bun-s3` is Bun-only; the CLI runs under Node, where
 * `Bun.S3Client` doesn't exist — Node users reach for the `s3` provider
 * instead. `convex` is constructed from a live in-function context
 * (`ctx.storage`) that only exists inside a running Convex function, so it
 * can't be built from CLI config/env. The `providers.test.ts` drift guard
 * treats these as the only allowed gaps between the catalog and this registry.
 */
export const CLI_EXCLUDED_PROVIDERS = new Set(["bun-s3", "convex"]);

export const PROVIDER_NAMES = Object.keys(PROVIDERS).toSorted();
