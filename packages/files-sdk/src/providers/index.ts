/**
 * Static catalog of every storage provider the SDK ships, plus the
 * environment variables each one reads. This module is pure data — it imports
 * no provider SDKs and no adapter code, so it stays zero-dependency and safe to
 * pull into bundles, build tools, sync engines, or config UIs without dragging
 * in `@aws-sdk/client-s3` and friends.
 *
 * It is the single source of truth behind the docs catalog and the CLI's
 * provider list; a test (`test/providers.test.ts`) keeps the env declarations
 * here in sync with the `readEnv(...)` calls in each adapter.
 *
 * @example List every provider and its required env vars.
 * ```typescript
 * import { PROVIDER_NAMES, getProvider } from "files-sdk/providers";
 *
 * for (const slug of PROVIDER_NAMES) {
 *   const { name, env } = getProvider(slug)!;
 *   console.log(name, env.required?.map((v) => v.key) ?? []);
 * }
 * ```
 *
 * @example Find which secrets to inject for one provider.
 * ```typescript
 * import { getSecretEnvVars } from "files-sdk/providers";
 *
 * const secrets = getSecretEnvVars("s3").map((v) => v.key);
 * ```
 */

/** A single environment variable an adapter looks for. */
export interface EnvVar {
  /**
   * Alternative names accepted for the same value, in the order the adapter
   * falls back through them. Empty/absent when there is only one name.
   */
  aliases?: readonly string[];
  /** Short description of what the value is. */
  description: string;
  /** The canonical environment variable name. */
  key: string;
  /**
   * Who actually reads this variable:
   * - `"files-sdk"` — the adapter reads it directly via `readEnv`.
   * - `"sdk-chain"` — files-sdk never reads it; the underlying provider SDK's
   *   credential chain resolves it (e.g. the AWS SDK reading
   *   `AWS_ACCESS_KEY_ID`, or Google Application Default Credentials). Listed
   *   here for completeness so callers know what to set, but it is resolved
   *   outside of files-sdk and may also come from an IAM role, profile, or
   *   metadata server.
   */
  readBy: "files-sdk" | "sdk-chain";
  /** Whether the value is a secret (token, key, password) and should be masked. */
  secret: boolean;
}

/**
 * One way to authenticate. When a provider exposes several
 * {@link ProviderEnvSpec.credentialModes}, the caller satisfies exactly one of
 * them — e.g. Azure accepts a connection string OR an account key OR a SAS
 * token. A flat "is this var required" flag can't express that, which is why
 * credentials are grouped.
 */
export interface EnvGroup {
  /** Human-readable name for this mode (e.g. "Account key", "SAS token"). */
  label: string;
  /**
   * The variables that together satisfy this mode. May be empty for a mode
   * that needs no env vars at all (e.g. an in-code binding or anonymous read).
   */
  vars: readonly EnvVar[];
}

/** The environment a provider expects. */
export interface ProviderEnvSpec {
  /**
   * Non-env configuration the adapter still requires, passed as constructor
   * options (or CLI flags) rather than environment variables — e.g. `bucket`,
   * `region`, `endpoint`, `container`. Informational; not every option is
   * listed, only the ones without a sensible default.
   */
  config?: readonly string[];
  /**
   * Mutually exclusive credential modes; the caller satisfies exactly one.
   * Omitted for providers that take no credentials (the local filesystem) or
   * whose credentials are only ever passed in code.
   */
  credentialModes?: readonly EnvGroup[];
  /** Free-form caveats that the structured fields can't capture. */
  notes?: string;
  /** Optional tuning variables — safe to omit. */
  optional?: readonly EnvVar[];
  /**
   * Variables needed regardless of which credential mode is used (e.g. a
   * bucket name read from the environment, or the project URL).
   */
  required?: readonly EnvVar[];
}

/** A storage provider available as a `files-sdk/<slug>` subpath import. */
export interface Provider {
  /** One-line summary of the provider and how it authenticates. */
  description: string;
  /** Environment the adapter reads. */
  env: ProviderEnvSpec;
  /** Display name (e.g. "AWS S3"). */
  name: string;
  /**
   * Native provider SDKs the adapter imports, listed as optional peer
   * dependencies on `files-sdk`. Empty for adapters that depend only on the
   * runtime (Bun's native S3 client, Node's `node:fs`).
   */
  peerDeps: readonly string[];
  /** Import subpath suffix and CLI `--provider` value (e.g. "s3"). */
  slug: string;
}

const AWS_S3_PEERS = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-presigned-post",
  "@aws-sdk/s3-request-presigner",
] as const;

const GRAPH_PEERS = [
  "@azure/identity",
  "@microsoft/microsoft-graph-client",
] as const;

/**
 * Build the env spec for an S3-compatible adapter — a single "access key"
 * credential mode reading a provider-specific key/secret pair. Mirrors the
 * `s3()`-wrapper pattern these adapters share.
 */
const s3Compatible = (
  accessKeyEnv: string,
  secretKeyEnv: string,
  config: readonly string[],
  options: {
    accessKeyDescription?: string;
    notes?: string;
    secretKeyDescription?: string;
  } = {}
): ProviderEnvSpec => ({
  config,
  credentialModes: [
    {
      label: "Access key",
      vars: [
        {
          description: options.accessKeyDescription ?? "Access key ID",
          key: accessKeyEnv,
          readBy: "files-sdk",
          secret: true,
        },
        {
          description: options.secretKeyDescription ?? "Secret access key",
          key: secretKeyEnv,
          readBy: "files-sdk",
          secret: true,
        },
      ],
    },
  ],
  ...(options.notes ? { notes: options.notes } : {}),
});

/**
 * Every storage provider, keyed by slug. The `env` of each describes what the
 * adapter reads; see {@link ProviderEnvSpec} for how credential modes work.
 */
export const PROVIDERS = {
  akamai: {
    description:
      "Akamai Cloud Object Storage (formerly Linode) via the S3-compatible API. Endpoint derived from the region/cluster code.",
    env: s3Compatible("AKAMAI_ACCESS_KEY_ID", "AKAMAI_SECRET_ACCESS_KEY", [
      "bucket",
      "endpoint",
    ]),
    name: "Akamai Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "akamai",
  },
  alibaba: {
    description:
      "Alibaba Cloud Object Storage Service (OSS) via the S3-compatible API. Endpoint derived from the region code (cn-hangzhou, ap-southeast-1, ...).",
    env: s3Compatible("ALIBABA_ACCESS_KEY_ID", "ALIBABA_ACCESS_KEY_SECRET", [
      "bucket",
      "region",
    ]),
    name: "Alibaba Cloud OSS",
    peerDeps: AWS_S3_PEERS,
    slug: "alibaba",
  },
  appwrite: {
    description:
      "Appwrite Storage via the official Node.js SDK. Auto-loads configuration from environment variables.",
    env: {
      config: ["bucket"],
      credentialModes: [
        {
          label: "API key",
          vars: [
            {
              aliases: ["APPWRITE_KEY"],
              description: "Appwrite API key",
              key: "APPWRITE_API_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      optional: [
        {
          aliases: ["NEXT_PUBLIC_APPWRITE_ENDPOINT"],
          description:
            "API endpoint (defaults to https://cloud.appwrite.io/v1)",
          key: "APPWRITE_ENDPOINT",
          readBy: "files-sdk",
          secret: false,
        },
      ],
      required: [
        {
          aliases: ["NEXT_PUBLIC_APPWRITE_PROJECT_ID"],
          description: "Appwrite project ID",
          key: "APPWRITE_PROJECT_ID",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "Appwrite",
    peerDeps: ["node-appwrite"],
    slug: "appwrite",
  },
  azure: {
    description:
      "Azure Blob Storage via @azure/storage-blob. Four credential modes - connection string, account key, SAS token, or anonymous.",
    env: {
      config: ["container"],
      credentialModes: [
        {
          label: "Connection string",
          vars: [
            {
              description: "Full storage account connection string",
              key: "AZURE_STORAGE_CONNECTION_STRING",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Account key",
          vars: [
            {
              aliases: ["AZURE_STORAGE_ACCOUNT"],
              description: "Storage account name",
              key: "AZURE_STORAGE_ACCOUNT_NAME",
              readBy: "files-sdk",
              secret: false,
            },
            {
              aliases: ["AZURE_STORAGE_KEY"],
              description: "Storage account access key",
              key: "AZURE_STORAGE_ACCOUNT_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "SAS token",
          vars: [
            {
              aliases: ["AZURE_STORAGE_ACCOUNT"],
              description: "Storage account name",
              key: "AZURE_STORAGE_ACCOUNT_NAME",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "Shared access signature token",
              key: "AZURE_STORAGE_SAS_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Anonymous (public read)",
          vars: [
            {
              aliases: ["AZURE_STORAGE_ACCOUNT"],
              description: "Storage account name",
              key: "AZURE_STORAGE_ACCOUNT_NAME",
              readBy: "files-sdk",
              secret: false,
            },
          ],
        },
      ],
    },
    name: "Azure Blob Storage",
    peerDeps: ["@azure/storage-blob"],
    slug: "azure",
  },
  "backblaze-b2": {
    description:
      "Backblaze B2 via the S3-compatible API. Endpoint derived from the cluster code (us-west-002, us-east-005, eu-central-003, ...).",
    env: s3Compatible(
      "B2_APPLICATION_KEY_ID",
      "B2_APPLICATION_KEY",
      ["bucket"],
      {
        accessKeyDescription: "B2 application key ID",
        secretKeyDescription: "B2 application key",
      }
    ),
    name: "Backblaze B2",
    peerDeps: AWS_S3_PEERS,
    slug: "backblaze-b2",
  },
  box: {
    description:
      "Box via the official typed SDK. Translates virtual keys into nested folders under a configurable rootFolderId.",
    env: {
      credentialModes: [
        {
          label: "Developer token",
          vars: [
            {
              description: "Box developer token (short-lived)",
              key: "BOX_DEVELOPER_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "Production auth (OAuth, Client Credentials Grant, JWT) is configured via constructor options, not env vars. BOX_DEVELOPER_TOKEN is the only env fallback.",
    },
    name: "Box",
    peerDeps: ["box-typescript-sdk-gen"],
    slug: "box",
  },
  "bun-s3": {
    description:
      "AWS S3 (and any S3-compatible bucket) via Bun's native Bun.S3Client instead of @aws-sdk/client-s3. Bun-only.",
    env: {
      config: ["bucket"],
      credentialModes: [
        {
          label: "Bun S3 credential resolution",
          vars: [
            {
              aliases: ["S3_ACCESS_KEY_ID"],
              description: "Access key ID (resolved by Bun)",
              key: "AWS_ACCESS_KEY_ID",
              readBy: "sdk-chain",
              secret: true,
            },
            {
              aliases: ["S3_SECRET_ACCESS_KEY"],
              description: "Secret access key (resolved by Bun)",
              key: "AWS_SECRET_ACCESS_KEY",
              readBy: "sdk-chain",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "Bun-only. Every variable is resolved by Bun's native S3Client, not by files-sdk. Pass `client: Bun.s3` or explicit options to override.",
      optional: [
        {
          aliases: ["S3_REGION"],
          description: "Region (resolved by Bun)",
          key: "AWS_REGION",
          readBy: "sdk-chain",
          secret: false,
        },
        {
          aliases: ["S3_BUCKET"],
          description: "Default bucket (resolved by Bun)",
          key: "AWS_BUCKET",
          readBy: "sdk-chain",
          secret: false,
        },
        {
          aliases: ["S3_SESSION_TOKEN"],
          description:
            "Session token for temporary credentials (resolved by Bun)",
          key: "AWS_SESSION_TOKEN",
          readBy: "sdk-chain",
          secret: true,
        },
      ],
    },
    name: "Bun S3",
    peerDeps: [],
    slug: "bun-s3",
  },
  "bunny-storage": {
    description:
      "Bunny Storage via @bunny.net/storage-sdk. Connects to a Storage Zone with its zone password / access key; auto-loads BUNNY_STORAGE_* env vars (STORAGE_* as aliases).",
    env: {
      credentialModes: [
        {
          label: "Storage Zone password",
          vars: [
            {
              aliases: ["STORAGE_ACCESS_KEY"],
              description: "Storage Zone password / access key",
              key: "BUNNY_STORAGE_ACCESS_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      optional: [
        {
          aliases: ["STORAGE_REGION"],
          description: "Region code (ny, de, sg, ...)",
          key: "BUNNY_STORAGE_REGION",
          readBy: "files-sdk",
          secret: false,
        },
      ],
      required: [
        {
          aliases: ["STORAGE_ZONE"],
          description: "Storage Zone name",
          key: "BUNNY_STORAGE_ZONE",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "Bunny Storage",
    peerDeps: ["@bunny.net/storage-sdk"],
    slug: "bunny-storage",
  },
  cloudinary: {
    description:
      "Cloudinary asset CDN via the official Node SDK. Defaults to resource_type: raw for arbitrary-bytes storage; switch to image/video for transforms.",
    env: {
      credentialModes: [
        {
          label: "Cloudinary URL",
          vars: [
            {
              description: "Full cloudinary://<key>:<secret>@<cloud> URL",
              key: "CLOUDINARY_URL",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Discrete credentials",
          vars: [
            {
              description: "Cloud name",
              key: "CLOUDINARY_CLOUD_NAME",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "API key",
              key: "CLOUDINARY_API_KEY",
              readBy: "files-sdk",
              secret: true,
            },
            {
              description: "API secret",
              key: "CLOUDINARY_API_SECRET",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
    },
    name: "Cloudinary",
    peerDeps: ["cloudinary"],
    slug: "cloudinary",
  },
  convex: {
    description:
      "Convex file storage via the function context (ctx.storage). Used inside Convex actions/mutations/queries; the Convex-assigned storage id is the key.",
    env: {
      config: ["ctx (Convex function context)"],
      notes:
        "No credentials — constructed with the live ctx inside a Convex function. upload/download need an action; list needs a query/mutation.",
    },
    name: "Convex",
    peerDeps: ["convex"],
    slug: "convex",
  },
  "digitalocean-spaces": {
    description:
      "DigitalOcean Spaces via the S3-compatible API. Endpoint derived from the region, virtual-hosted addressing.",
    env: s3Compatible("DO_SPACES_KEY", "DO_SPACES_SECRET", [
      "bucket",
      "region",
    ]),
    name: "DigitalOcean Spaces",
    peerDeps: AWS_S3_PEERS,
    slug: "digitalocean-spaces",
  },
  dropbox: {
    description:
      "Dropbox via the official SDK. Path-addressable, virtual keys map directly to Dropbox paths - no cache.",
    env: {
      credentialModes: [
        {
          label: "Access token",
          vars: [
            {
              description: "Short-lived or long-lived access token",
              key: "DROPBOX_ACCESS_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Refresh token (auto-refresh)",
          vars: [
            {
              description: "OAuth refresh token",
              key: "DROPBOX_REFRESH_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
            {
              description: "Dropbox app key",
              key: "DROPBOX_APP_KEY",
              readBy: "files-sdk",
              secret: true,
            },
            {
              description: "Dropbox app secret",
              key: "DROPBOX_APP_SECRET",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
    },
    name: "Dropbox",
    peerDeps: ["dropbox"],
    slug: "dropbox",
  },
  exoscale: {
    description:
      "Exoscale Object Storage (SOS) via the S3-compatible API. Endpoint derived from the zone code (ch-gva-2, de-fra-1, ...).",
    env: s3Compatible("EXOSCALE_API_KEY", "EXOSCALE_API_SECRET", [
      "bucket",
      "region",
    ]),
    name: "Exoscale Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "exoscale",
  },
  filebase: {
    description:
      "Filebase via the S3-compatible API. Fronts decentralized networks (IPFS, Sia, Storj) chosen per-bucket.",
    env: s3Compatible("FILEBASE_ACCESS_KEY_ID", "FILEBASE_SECRET_ACCESS_KEY", [
      "bucket",
    ]),
    name: "Filebase",
    peerDeps: AWS_S3_PEERS,
    slug: "filebase",
  },
  "firebase-storage": {
    description:
      "Firebase Cloud Storage via the official firebase-admin SDK. Underlying client is @google-cloud/storage, so V4 signed URLs and POST policy uploads come for free.",
    env: {
      credentialModes: [
        {
          label: "Application Default Credentials",
          vars: [
            {
              description: "Path to service-account JSON",
              key: "GOOGLE_APPLICATION_CREDENTIALS",
              readBy: "files-sdk",
              secret: false,
            },
          ],
        },
        {
          label: "Inline service account",
          vars: [
            {
              description: "Service account client email",
              key: "FIREBASE_CLIENT_EMAIL",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "Service account private key",
              key: "FIREBASE_PRIVATE_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      optional: [
        {
          aliases: ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"],
          description: "Firebase / GCP project ID",
          key: "FIREBASE_PROJECT_ID",
          readBy: "files-sdk",
          secret: false,
        },
      ],
      required: [
        {
          description: "Storage bucket name (or pass `bucket`)",
          key: "FIREBASE_STORAGE_BUCKET",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "Firebase Storage",
    peerDeps: ["firebase-admin"],
    slug: "firebase-storage",
  },
  fs: {
    description:
      "Local filesystem - the dev/test adapter. Uses node:fs/promises with a sidecar .meta.json per file. Not for production.",
    env: {
      config: ["root"],
      notes: "Local filesystem — no credentials. Dev/test only.",
    },
    name: "Filesystem",
    peerDeps: [],
    slug: "fs",
  },
  ftp: {
    description:
      "FTP / FTPS via basic-ftp. Node-only. Connect-per-operation with an injectable client for batch work; url() needs an HTTP front (publicBaseUrl).",
    env: {
      config: ["host", "port", "root"],
      credentialModes: [
        {
          label: "Username + password",
          vars: [
            {
              aliases: ["FTP_USER"],
              description: "FTP username (default anonymous)",
              key: "FTP_USERNAME",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "FTP password",
              key: "FTP_PASSWORD",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "Node-only (raw sockets). Plain FTP transmits credentials in cleartext — set FTP_SECURE=true for FTPS. Connect-per-operation; pass a pre-connected `client` for high throughput. `url()` and `signedUploadUrl()` require `publicBaseUrl` — FTP serves no HTTP.",
      optional: [
        {
          description: "Port (default 21)",
          key: "FTP_PORT",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: 'FTPS over TLS — "true" (explicit) or "implicit"',
          key: "FTP_SECURE",
          readBy: "files-sdk",
          secret: false,
        },
      ],
      required: [
        {
          description: "FTP host",
          key: "FTP_HOST",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "FTP",
    peerDeps: ["basic-ftp"],
    slug: "ftp",
  },
  gcs: {
    description:
      "Google Cloud Storage via the official @google-cloud/storage SDK. Application Default Credentials by default.",
    env: {
      config: ["bucket"],
      credentialModes: [
        {
          label: "Application Default Credentials",
          vars: [
            {
              description: "Path to service-account JSON (ADC)",
              key: "GOOGLE_APPLICATION_CREDENTIALS",
              readBy: "sdk-chain",
              secret: false,
            },
          ],
        },
      ],
      notes:
        "Credentials use Google Application Default Credentials, resolved by @google-cloud/storage (env var, `gcloud` login, or metadata server). files-sdk only reads the project ID.",
      optional: [
        {
          aliases: ["GCLOUD_PROJECT"],
          description: "GCP project ID (or pass `projectId`)",
          key: "GOOGLE_CLOUD_PROJECT",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "Google Cloud Storage",
    peerDeps: ["@google-cloud/storage"],
    slug: "gcs",
  },
  "google-drive": {
    description:
      "Google Drive via the official Drive v3 client. Maps unified string keys onto Drive's appProperties with a per-instance LRU cache.",
    env: {
      credentialModes: [
        {
          label: "Service account (inline)",
          vars: [
            {
              description: "Service account email",
              key: "GOOGLE_DRIVE_CLIENT_EMAIL",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "Service account private key",
              key: "GOOGLE_DRIVE_PRIVATE_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Service account (key file)",
          vars: [
            {
              description: "Path to service-account JSON",
              key: "GOOGLE_DRIVE_KEY_FILE",
              readBy: "files-sdk",
              secret: false,
            },
          ],
        },
      ],
      notes:
        "Also supports OAuth client credentials (clientId / clientSecret / refreshToken) via constructor options.",
      optional: [
        {
          description: "User to impersonate (domain-wide delegation)",
          key: "GOOGLE_DRIVE_SUBJECT",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "Shared Drive ID",
          key: "GOOGLE_DRIVE_ID",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "Root folder ID",
          key: "GOOGLE_DRIVE_ROOT_FOLDER_ID",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "Google Drive",
    peerDeps: ["@googleapis/drive", "google-auth-library"],
    slug: "google-drive",
  },
  hetzner: {
    description:
      "Hetzner Object Storage via the S3-compatible API. Endpoint derived from the location code (fsn1, nbg1, hel1).",
    env: s3Compatible("HCLOUD_ACCESS_KEY_ID", "HCLOUD_SECRET_ACCESS_KEY", [
      "bucket",
      "region",
    ]),
    name: "Hetzner Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "hetzner",
  },
  "ibm-cos": {
    description:
      "IBM Cloud Object Storage via the S3-compatible API. Auth uses IBM Cloud HMAC credentials, not IAM API keys.",
    env: s3Compatible(
      "IBM_COS_ACCESS_KEY_ID",
      "IBM_COS_SECRET_ACCESS_KEY",
      ["bucket", "endpoint"],
      {
        notes: "Auth uses IBM Cloud HMAC credentials, not IAM API keys.",
      }
    ),
    name: "IBM Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "ibm-cos",
  },
  "idrive-e2": {
    description:
      "iDrive e2 via the S3-compatible API. Endpoint required (iDrive hostnames are tied to the cluster your bucket lives in).",
    env: s3Compatible(
      "IDRIVE_E2_ACCESS_KEY_ID",
      "IDRIVE_E2_SECRET_ACCESS_KEY",
      ["bucket", "endpoint"]
    ),
    name: "iDrive e2",
    peerDeps: AWS_S3_PEERS,
    slug: "idrive-e2",
  },
  minio: {
    description:
      "MinIO and other self-hosted S3-compatible servers. Path-style addressing on by default; region defaulted; errors relabelled.",
    env: s3Compatible("MINIO_ACCESS_KEY_ID", "MINIO_SECRET_ACCESS_KEY", [
      "bucket",
      "endpoint",
    ]),
    name: "MinIO",
    peerDeps: AWS_S3_PEERS,
    slug: "minio",
  },
  "netlify-blobs": {
    description:
      "Netlify Blobs via @netlify/blobs. Auto-detects siteID and token on Netlify runtimes; falls back to env vars elsewhere.",
    env: {
      config: ["store name"],
      credentialModes: [
        {
          label: "Explicit site + token",
          vars: [
            {
              description: "Netlify site ID",
              key: "NETLIFY_SITE_ID",
              readBy: "files-sdk",
              secret: false,
            },
            {
              aliases: ["NETLIFY_BLOBS_TOKEN"],
              description: "Netlify personal access token",
              key: "NETLIFY_API_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Netlify runtime context (auto)",
          vars: [
            {
              description: "Injected automatically on Netlify runtimes",
              key: "NETLIFY_BLOBS_CONTEXT",
              readBy: "sdk-chain",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "On Netlify, siteID and token are auto-detected. Elsewhere, NETLIFY_SITE_ID and the token must both be set for explicit auth.",
    },
    name: "Netlify Blobs",
    peerDeps: ["@netlify/blobs"],
    slug: "netlify-blobs",
  },
  onedrive: {
    description:
      "OneDrive and SharePoint document libraries via Microsoft Graph. Path-addressable, no virtual-key bookkeeping.",
    env: {
      credentialModes: [
        {
          label: "App-only (client credentials)",
          vars: [
            {
              description: "Azure AD tenant ID",
              key: "ONEDRIVE_TENANT_ID",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "App registration client ID",
              key: "ONEDRIVE_CLIENT_ID",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "App registration client secret",
              key: "ONEDRIVE_CLIENT_SECRET",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Access token",
          vars: [
            {
              description: "Pre-acquired Microsoft Graph access token",
              key: "ONEDRIVE_ACCESS_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      optional: [
        {
          description: "Target drive ID",
          key: "ONEDRIVE_DRIVE_ID",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "SharePoint site ID",
          key: "ONEDRIVE_SITE_ID",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "User ID (app-only flows)",
          key: "ONEDRIVE_USER_ID",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "OneDrive",
    peerDeps: GRAPH_PEERS,
    slug: "onedrive",
  },
  "oracle-cloud": {
    description:
      "Oracle Cloud Infrastructure Object Storage via the S3 compatibility layer. Auth uses HMAC Customer Secret Keys, not regular API keys.",
    env: s3Compatible(
      "OCI_ACCESS_KEY_ID",
      "OCI_SECRET_ACCESS_KEY",
      ["bucket", "region", "endpoint"],
      {
        notes: "Auth uses HMAC Customer Secret Keys, not regular API keys.",
      }
    ),
    name: "Oracle Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "oracle-cloud",
  },
  ovhcloud: {
    description:
      "OVHcloud Object Storage (High Performance S3) via the S3-compatible API. Endpoint derived from the region code.",
    env: s3Compatible("OVH_ACCESS_KEY_ID", "OVH_SECRET_ACCESS_KEY", [
      "bucket",
      "region",
    ]),
    name: "OVHcloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "ovhcloud",
  },
  pocketbase: {
    description:
      "PocketBase via the official JS SDK. Maps the unified key/blob API onto a dedicated collection with a unique key field and a single-file body field.",
    env: {
      credentialModes: [
        {
          label: "Auth token",
          vars: [
            {
              description: "Pre-acquired auth token",
              key: "POCKETBASE_AUTH_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Admin credentials",
          vars: [
            {
              description: "Superuser email",
              key: "POCKETBASE_ADMIN_EMAIL",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "Superuser password",
              key: "POCKETBASE_ADMIN_PASSWORD",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "Anonymous access works for public collections (no auth env vars needed).",
      required: [
        {
          description: "PocketBase backend URL",
          key: "POCKETBASE_URL",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "PocketBase",
    peerDeps: ["pocketbase"],
    slug: "pocketbase",
  },
  r2: {
    description:
      "Cloudflare R2 over the S3-compatible HTTP API. Auto-loads R2_* env vars or accepts an R2Bucket binding inside Workers.",
    env: {
      config: ["bucket"],
      credentialModes: [
        {
          label: "R2 S3 API token (HTTP mode)",
          vars: [
            {
              description: "Cloudflare account ID",
              key: "R2_ACCOUNT_ID",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "R2 access key ID",
              key: "R2_ACCESS_KEY_ID",
              readBy: "files-sdk",
              secret: true,
            },
            {
              description: "R2 secret access key",
              key: "R2_SECRET_ACCESS_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Workers R2Bucket binding (no env vars; pass `binding`)",
          vars: [],
        },
      ],
      notes:
        "HTTP mode reads R2_* env vars. Inside a Cloudflare Worker, pass an R2Bucket binding instead — that path reads no env vars.",
    },
    name: "Cloudflare R2",
    peerDeps: AWS_S3_PEERS,
    slug: "r2",
  },
  s3: {
    description:
      "AWS S3 (and any S3-compatible bucket). Uses the standard AWS credential chain - environment, IAM role, shared profile.",
    env: {
      config: ["bucket"],
      credentialModes: [
        {
          label:
            "AWS credential chain (env, IAM role, shared profile, SSO, ...)",
          vars: [
            {
              description: "AWS access key ID (or any other chain source)",
              key: "AWS_ACCESS_KEY_ID",
              readBy: "sdk-chain",
              secret: true,
            },
            {
              description: "AWS secret access key (or any other chain source)",
              key: "AWS_SECRET_ACCESS_KEY",
              readBy: "sdk-chain",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "Credentials are resolved by the AWS SDK default chain — files-sdk only reads the region. Any chain source works (env vars, IAM role, shared profile, SSO).",
      optional: [
        {
          description: "Session token for temporary credentials",
          key: "AWS_SESSION_TOKEN",
          readBy: "sdk-chain",
          secret: true,
        },
      ],
      required: [
        {
          aliases: ["AWS_DEFAULT_REGION"],
          description: "Bucket region (or pass `region`)",
          key: "AWS_REGION",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "S3",
    peerDeps: AWS_S3_PEERS,
    slug: "s3",
  },
  scaleway: {
    description:
      "Scaleway Object Storage via the S3-compatible API. Endpoint derived from the region code (fr-par, nl-ams, pl-waw).",
    env: s3Compatible("SCW_ACCESS_KEY", "SCW_SECRET_KEY", ["bucket", "region"]),
    name: "Scaleway Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "scaleway",
  },
  sftp: {
    description:
      "SFTP (SSH File Transfer Protocol) via ssh2-sftp-client. Node-only. Connect-per-operation with an injectable client for batch work; url() needs an HTTP front (publicBaseUrl).",
    env: {
      config: ["host", "port", "root"],
      credentialModes: [
        {
          label: "Password",
          vars: [
            {
              description: "SSH username",
              key: "SFTP_USERNAME",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "SSH password",
              key: "SFTP_PASSWORD",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Private key",
          vars: [
            {
              description: "SSH username",
              key: "SFTP_USERNAME",
              readBy: "files-sdk",
              secret: false,
            },
            {
              description: "Private key (PEM)",
              key: "SFTP_PRIVATE_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      notes:
        "Node-only (raw sockets). Connect-per-operation; pass a pre-connected `client` for high throughput. `url()` and `signedUploadUrl()` require `publicBaseUrl` — SFTP serves no HTTP.",
      optional: [
        {
          description: "Passphrase for an encrypted private key",
          key: "SFTP_PASSPHRASE",
          readBy: "files-sdk",
          secret: true,
        },
        {
          description: "Port (default 22)",
          key: "SFTP_PORT",
          readBy: "files-sdk",
          secret: false,
        },
      ],
      required: [
        {
          description: "SFTP host",
          key: "SFTP_HOST",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "SFTP",
    peerDeps: ["ssh2-sftp-client"],
    slug: "sftp",
  },
  sharepoint: {
    description:
      "SharePoint document libraries via Microsoft Graph. Resolves siteUrl and library names; delegates to the OneDrive adapter for the file operations.",
    env: {
      credentialModes: [
        {
          label: "App-only (client credentials)",
          vars: [
            {
              aliases: ["ONEDRIVE_TENANT_ID"],
              description: "Azure AD tenant ID",
              key: "SHAREPOINT_TENANT_ID",
              readBy: "files-sdk",
              secret: false,
            },
            {
              aliases: ["ONEDRIVE_CLIENT_ID"],
              description: "App registration client ID",
              key: "SHAREPOINT_CLIENT_ID",
              readBy: "files-sdk",
              secret: false,
            },
            {
              aliases: ["ONEDRIVE_CLIENT_SECRET"],
              description: "App registration client secret",
              key: "SHAREPOINT_CLIENT_SECRET",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Access token",
          vars: [
            {
              aliases: ["ONEDRIVE_ACCESS_TOKEN"],
              description: "Pre-acquired Microsoft Graph access token",
              key: "SHAREPOINT_ACCESS_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      optional: [
        {
          description: "SharePoint site ID",
          key: "SHAREPOINT_SITE_ID",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "SharePoint site URL",
          key: "SHAREPOINT_SITE_URL",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "SharePoint hostname",
          key: "SHAREPOINT_HOSTNAME",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "Document library drive ID",
          key: "SHAREPOINT_DRIVE_ID",
          readBy: "files-sdk",
          secret: false,
        },
        {
          description: "Document library name",
          key: "SHAREPOINT_DOCUMENT_LIBRARY",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "SharePoint",
    peerDeps: GRAPH_PEERS,
    slug: "sharepoint",
  },
  storj: {
    description:
      "Storj DCS via the S3-compatible Gateway. Defaults to the hosted Gateway MT, path-style addressing on.",
    env: s3Compatible("STORJ_ACCESS_KEY_ID", "STORJ_SECRET_ACCESS_KEY", [
      "bucket",
    ]),
    name: "Storj",
    peerDeps: AWS_S3_PEERS,
    slug: "storj",
  },
  supabase: {
    description:
      "Supabase Storage via @supabase/storage-js. Pass an existing SupabaseClient to share auth/postgrest with the rest of your app.",
    env: {
      config: ["bucket"],
      credentialModes: [
        {
          label: "Service role or API key",
          vars: [
            {
              aliases: ["SUPABASE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"],
              description: "Service role key (admin) or anon key",
              key: "SUPABASE_SERVICE_ROLE_KEY",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
      required: [
        {
          aliases: ["NEXT_PUBLIC_SUPABASE_URL"],
          description: "Supabase project URL",
          key: "SUPABASE_URL",
          readBy: "files-sdk",
          secret: false,
        },
      ],
    },
    name: "Supabase Storage",
    peerDeps: ["@supabase/storage-js"],
    slug: "supabase",
  },
  tencent: {
    description:
      "Tencent Cloud Object Storage (COS) via the S3-compatible API. Endpoint derived from the region code; bucket name must include the -<appid> suffix.",
    env: s3Compatible(
      "TENCENT_SECRET_ID",
      "TENCENT_SECRET_KEY",
      ["bucket", "region"],
      {
        accessKeyDescription: "Tencent Cloud secret ID",
        secretKeyDescription: "Tencent Cloud secret key",
      }
    ),
    name: "Tencent Cloud Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "tencent",
  },
  tigris: {
    description:
      "Tigris globally-distributed object storage via the S3-compatible API. Fixed global endpoint, region defaults to auto.",
    env: s3Compatible("TIGRIS_ACCESS_KEY_ID", "TIGRIS_SECRET_ACCESS_KEY", [
      "bucket",
    ]),
    name: "Tigris",
    peerDeps: AWS_S3_PEERS,
    slug: "tigris",
  },
  uploadthing: {
    description:
      "UploadThing via uploadthing/server. Maps user-supplied keys onto UploadThing's customId.",
    env: {
      credentialModes: [
        {
          label: "API token",
          vars: [
            {
              description: "UploadThing API token",
              key: "UPLOADTHING_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
      ],
    },
    name: "UploadThing",
    peerDeps: ["uploadthing"],
    slug: "uploadthing",
  },
  "vercel-blob": {
    description:
      "Vercel Blob. Prefers Vercel OIDC (VERCEL_OIDC_TOKEN + BLOB_STORE_ID, auto-rotating) and falls back to BLOB_READ_WRITE_TOKEN; pass token, oidcToken, or storeId manually for local dev or other hosts.",
    env: {
      credentialModes: [
        {
          label: "Read-write token",
          vars: [
            {
              description: "Vercel Blob read/write token",
              key: "BLOB_READ_WRITE_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
          ],
        },
        {
          label: "Vercel OIDC (auto-rotating)",
          vars: [
            {
              description: "Vercel OIDC token (auto-injected on Vercel)",
              key: "VERCEL_OIDC_TOKEN",
              readBy: "files-sdk",
              secret: true,
            },
            {
              description: "Blob store ID",
              key: "BLOB_STORE_ID",
              readBy: "files-sdk",
              secret: false,
            },
          ],
        },
      ],
      notes:
        "An explicit `token` wins over OIDC. Locally, set BLOB_READ_WRITE_TOKEN.",
    },
    name: "Vercel Blob",
    peerDeps: ["@vercel/blob"],
    slug: "vercel-blob",
  },
  vultr: {
    description:
      "Vultr Object Storage via the S3-compatible API. Endpoint derived from the region code (ewr, sjc, ams, blr, ...).",
    env: s3Compatible("VULTR_ACCESS_KEY_ID", "VULTR_SECRET_ACCESS_KEY", [
      "bucket",
      "region",
    ]),
    name: "Vultr Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "vultr",
  },
  wasabi: {
    description:
      "Wasabi Hot Cloud Storage via the S3-compatible API. AWS-style region names, Wasabi's own endpoints.",
    env: s3Compatible("WASABI_ACCESS_KEY_ID", "WASABI_SECRET_ACCESS_KEY", [
      "bucket",
      "region",
    ]),
    name: "Wasabi",
    peerDeps: AWS_S3_PEERS,
    slug: "wasabi",
  },
  yandex: {
    description:
      "Yandex Object Storage via the S3-compatible API. Fixed global endpoint, region defaults to ru-central1.",
    env: s3Compatible("YANDEX_ACCESS_KEY_ID", "YANDEX_SECRET_ACCESS_KEY", [
      "bucket",
    ]),
    name: "Yandex Object Storage",
    peerDeps: AWS_S3_PEERS,
    slug: "yandex",
  },
} satisfies Record<string, Provider>;

/** Slug of any provider in the catalog. */
export type ProviderSlug = keyof typeof PROVIDERS;

/** All provider slugs, sorted alphabetically. */
export const PROVIDER_NAMES = Object.keys(
  PROVIDERS
).toSorted() as ProviderSlug[];

/** Look up a provider by slug. Returns `undefined` for unknown slugs. */
export const getProvider = (slug: string): Provider | undefined =>
  (PROVIDERS as Record<string, Provider>)[slug];

/**
 * Every env var a provider references, flattened across required, all
 * credential modes, and optional — de-duplicated by key (a var that appears in
 * several credential modes is returned once). Empty for unknown slugs.
 */
export const listEnvVars = (slug: string): EnvVar[] => {
  const provider = getProvider(slug);
  if (!provider) {
    return [];
  }
  const { env } = provider;
  const all = [
    ...(env.required ?? []),
    ...(env.credentialModes ?? []).flatMap((mode) => mode.vars),
    ...(env.optional ?? []),
  ];
  const byKey = new Map<string, EnvVar>();
  for (const envVar of all) {
    if (!byKey.has(envVar.key)) {
      byKey.set(envVar.key, envVar);
    }
  }
  return [...byKey.values()];
};

/** The secret env vars a provider references (tokens, keys, passwords). */
export const getSecretEnvVars = (slug: string): EnvVar[] =>
  listEnvVars(slug).filter((envVar) => envVar.secret);
