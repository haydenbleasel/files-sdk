// The plugins that ship with the SDK, each its own `files-sdk/<slug>` subpath
// with a docs page at `/docs/plugins/<slug>`. Feeds the landing page's plugin
// count and grid; keep it in step with `apps/web/docs/plugins/index.mdx`.
export interface Plugin {
  description: string;
  name: string;
  slug: string;
}

export const PLUGINS: Plugin[] = [
  {
    description: "Envelope AES-256-GCM encryption at rest.",
    name: "encryption()",
    slug: "encryption",
  },
  {
    description: "gzip and deflate bodies through Compression Streams.",
    name: "compression()",
    slug: "compression",
  },
  {
    description: "Fail-closed size, MIME and key guards on every write.",
    name: "validation()",
    slug: "validation",
  },
  {
    description: "Snapshots on overwrite and delete, with restore.",
    name: "versioning()",
    slug: "versioning",
  },
  {
    description: "Magic-byte sniffing that sets and guards Content-Type.",
    name: "contentType()",
    slug: "content-type",
  },
  {
    description: "Content-addressed storage that shares identical blobs.",
    name: "dedup()",
    slug: "dedup",
  },
  {
    description: "Meters operations and bytes up and down, optionally grouped.",
    name: "usage()",
    slug: "usage",
  },
  {
    description: "An OpenTelemetry span for every operation.",
    name: "tracing()",
    slug: "tracing",
  },
  {
    description: "A recycle bin with trashed, restore and purge.",
    name: "softDelete()",
    slug: "soft-delete",
  },
  {
    description: "A durable who, what and when log of every mutation.",
    name: "audit()",
    slug: "audit",
  },
  {
    description: "LRU or KV caching for head, url and small downloads.",
    name: "cache()",
    slug: "cache",
  },
  {
    description: "Routes hot and cold keys to different backends.",
    name: "tiering()",
    slug: "tiering",
  },
  {
    description: "Retries provider errors against replica backends.",
    name: "failover()",
    slug: "failover",
  },
  {
    description: "Safe defaults for url and signedUploadUrl.",
    name: "signedUrlPolicy()",
    slug: "signed-url-policy",
  },
  {
    description: "Bundles stored objects into ZIP archives and back.",
    name: "zip()",
    slug: "zip",
  },
];
