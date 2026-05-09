"use client";

import { Check, TriangleAlert, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { Heading } from "@/components/heading";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Status = "ok" | "warn" | "no";

interface Cell {
  status: Status;
  note?: string;
}

const ok: Cell = { status: "ok" };
const warn = (note: string): Cell => ({ note, status: "warn" });
const no = (note: string): Cell => ({ note, status: "no" });

const COLUMNS = [
  { key: "s3", label: "S3", parent: "S3" },
  { key: "r2-http", label: "HTTP", parent: "Cloudflare R2" },
  { key: "r2-binding", label: "binding", parent: "Cloudflare R2" },
  { key: "r2-hybrid", label: "hybrid", parent: "Cloudflare R2" },
  { key: "vb-public", label: "public", parent: "Vercel Blob" },
  { key: "vb-private", label: "private", parent: "Vercel Blob" },
  { key: "minio", label: "MinIO", parent: "MinIO" },
  { key: "spaces", label: "Spaces", parent: "DigitalOcean" },
  { key: "gcs", label: "GCS", parent: "GCS" },
  { key: "azure", label: "Azure", parent: "Azure" },
  { key: "supabase", label: "Supabase", parent: "Supabase" },
  { key: "ut-public", label: "public", parent: "UploadThing" },
  { key: "ut-private", label: "private", parent: "UploadThing" },
  { key: "fs", label: "fs", parent: "Filesystem" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

const ROWS: { method: string; cells: Record<ColumnKey, Cell> }[] = [
  {
    cells: {
      azure: ok,
      fs: ok,
      gcs: ok,
      minio: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: ok,
      "ut-private": ok,
      "ut-public": ok,
      "vb-private": ok,
      "vb-public": ok,
    },
    method: "upload",
  },
  {
    cells: {
      azure: ok,
      fs: ok,
      gcs: ok,
      minio: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: ok,
      "ut-private": ok,
      "ut-public": ok,
      "vb-private": ok,
      "vb-public": ok,
    },
    method: "download",
  },
  {
    cells: {
      azure: ok,
      fs: ok,
      gcs: ok,
      minio: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: ok,
      "ut-private": ok,
      "ut-public": ok,
      "vb-private": ok,
      "vb-public": ok,
    },
    method: "delete",
  },
  {
    cells: {
      azure: ok,
      fs: ok,
      gcs: ok,
      minio: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: warn(
        "Supabase's stable list API is offset/limit, not cursor-based. The adapter encodes the next offset as a numeric cursor string so the unified API works unchanged — the cursor is opaque to callers but is just `String(offset + page)` underneath."
      ),
      "ut-private": warn(
        "UploadThing's listFiles is offset/limit, not cursor-based — the adapter encodes the next offset as a numeric cursor. `prefix` is unsupported server-side; the adapter filters the returned page client-side, which under-returns when the prefix isn't satisfied within a single page."
      ),
      "ut-public": warn(
        "UploadThing's listFiles is offset/limit, not cursor-based — the adapter encodes the next offset as a numeric cursor. `prefix` is unsupported server-side; the adapter filters the returned page client-side, which under-returns when the prefix isn't satisfied within a single page."
      ),
      "vb-private": ok,
      "vb-public": ok,
    },
    method: "list",
  },
  {
    cells: {
      azure: ok,
      fs: ok,
      gcs: ok,
      minio: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: ok,
      "ut-private": warn(
        "UploadThing has no metadata endpoint, so `head()` issues a HEAD request against the resolved file URL (signed for private, CDN for public) and parses size/content-type/etag/last-modified from the response headers. User `metadata` isn't supported."
      ),
      "ut-public": warn(
        "UploadThing has no metadata endpoint, so `head()` issues a HEAD request against the resolved file URL (signed for private, CDN for public) and parses size/content-type/etag/last-modified from the response headers. User `metadata` isn't supported."
      ),
      "vb-private": ok,
      "vb-public": ok,
    },
    method: "head",
  },
  {
    cells: {
      azure: warn(
        "Server-side copy via `syncCopyFromURL` — capped at 256 MB source size. Larger blobs need `beginCopyFromURL` (poller); drop down to `adapter.raw` for that. SAS-only adapter mode reuses the configured token; shared-key mode mints a 5-min read SAS."
      ),
      fs: ok,
      gcs: ok,
      minio: ok,
      "r2-binding": warn(
        "Read-then-write — Workers bindings have no native copy command, so the source is fetched and re-uploaded. Not server-side atomic; concurrent writes to the source between the get and put are not detected."
      ),
      "r2-http": ok,
      "r2-hybrid": warn(
        "Read-then-write — copy goes through the binding (no native copy command on Workers)."
      ),
      s3: ok,
      spaces: ok,
      supabase: ok,
      "ut-private": warn(
        "Read-then-write — UploadThing has no server-side copy primitive, so the source is downloaded and re-uploaded. Costs an egress + an ingest; not atomic."
      ),
      "ut-public": warn(
        "Read-then-write — UploadThing has no server-side copy primitive, so the source is downloaded and re-uploaded. Costs an egress + an ingest; not atomic."
      ),
      "vb-private": ok,
      "vb-public": ok,
    },
    method: "copy",
  },
  {
    cells: {
      azure: warn(
        "Signs a SAS read URL. Throws when constructed in SAS-only or anonymous mode (no shared key available to sign). Pass `accountKey` + `accountName` or a `connectionString` that contains an account key, or set `publicBaseUrl` for a public container."
      ),
      fs: warn(
        "Returns a `file://` URL by default — fine for CLIs and tests, not browsers. With `urlBaseUrl` set, returns `<urlBaseUrl>/<key>` so a dev server (Next.js `/public` mount, `serve-static`, etc.) can deliver the body. `responseContentDisposition` requires `urlBaseUrl` — `file://` has no signature mechanism in which to bind the override."
      ),
      gcs: ok,
      minio: ok,
      "r2-binding": no(
        "Throws unless `publicBaseUrl` is set on the adapter (an r2.dev subdomain or a custom domain). For a presigned URL from a Worker, switch to hybrid mode by also passing `accountId` + `accessKeyId` + `secretAccessKey`."
      ),
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: warn(
        "Default mints a signed read URL via `createSignedUrl` (1-hour default). With `public: true`, returns the permanent unsigned `getPublicUrl` result. With `publicBaseUrl`, returns `<publicBaseUrl>/<key>`. `responseContentDisposition` is honored — it threads through Supabase's `download` option in the signed path."
      ),
      "ut-private": warn(
        "Mints a signed read URL via `generateSignedURL` (1-hour default). `responseContentDisposition` throws — UploadThing has no Content-Disposition override on signed or CDN URLs."
      ),
      "ut-public": warn(
        "Returns the permanent CDN URL `https://{appId}.ufs.sh/f/{key}`. `expiresIn` is silently ignored (no signing). `responseContentDisposition` throws — UploadThing has no Content-Disposition override. Use a private adapter or a different provider for buckets with untrusted user-uploaded content."
      ),
      "vb-private": no(
        "No URL primitive for private blobs — the underlying SDK requires an authenticated `blob.get()` call with the token. Use `download()` instead, or instantiate a second public-access adapter."
      ),
      "vb-public": warn(
        "Returns the permanent CDN URL. `expiresIn` is silently ignored (no signing primitive); `responseContentDisposition` throws (no Content-Disposition override available). Use a different provider for buckets with untrusted user-uploaded content."
      ),
    },
    method: "url",
  },
  {
    cells: {
      azure: warn(
        "PUT URL only — Azure has no POST policy equivalent. `maxSize` throws because Azure SAS has no `content-length-range` policy; enforce upload caps at your application gateway instead. Throws in SAS-only or anonymous mode (no shared key to sign). The returned headers include the required `x-ms-blob-type: BlockBlob`."
      ),
      fs: warn(
        "Throws without `urlBaseUrl` — the fs adapter has no built-in upload server, so there's nothing to sign against. With `urlBaseUrl` set, returns a PUT URL with `?expires=`, `?content-type=`, and `?max-size=` query params for a dev upload-handler to validate. The fs adapter does not enforce the params itself."
      ),
      gcs: ok,
      minio: ok,
      "r2-binding": no(
        "Workers bindings can't sign uploads — the secret access key is not available to the runtime. Use hybrid mode (binding + HTTP credentials) to issue presigned upload URLs."
      ),
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      spaces: ok,
      supabase: warn(
        "PUT URL only — Supabase has no POST policy equivalent. `maxSize` throws (Supabase signed upload URLs have no `content-length-range` policy; set the bucket-level size limit in the dashboard instead). `expiresIn` is silently ignored — Supabase fixes the TTL at 2 hours server-side. The returned headers include `x-upsert: true`."
      ),
      "ut-private": warn(
        "PUT URL only — built against UploadThing's UFS ingest endpoint with an HMAC-SHA256 signature over the URL. `maxSize` is advisory: UploadThing enforces upload caps via the file-router config tied to the adapter's `slug`, not via the URL signature. `minSize` is ignored (no equivalent on UFS). The user-supplied key is bound as `x-ut-custom-id` so subsequent ops can route by it."
      ),
      "ut-public": warn(
        "PUT URL only — built against UploadThing's UFS ingest endpoint with an HMAC-SHA256 signature over the URL. `maxSize` is advisory: UploadThing enforces upload caps via the file-router config tied to the adapter's `slug`, not via the URL signature. `minSize` is ignored (no equivalent on UFS). The user-supplied key is bound as `x-ut-custom-id` so subsequent ops can route by it."
      ),
      "vb-private": no(
        "No presigned upload primitive. Use `handleUpload()` from `@vercel/blob/client` for browser uploads."
      ),
      "vb-public": no(
        "No presigned upload primitive. Use `handleUpload()` from `@vercel/blob/client` for browser uploads."
      ),
    },
    method: "signedUploadUrl",
  },
];

const ICON_BY_STATUS: Record<
  Status,
  { Icon: ComponentType<{ className?: string }>; cls: string; label: string }
> = {
  no: { Icon: X, cls: "text-red-500", label: "Throws" },
  ok: { Icon: Check, cls: "text-emerald-500", label: "Supported" },
  warn: { Icon: TriangleAlert, cls: "text-amber-500", label: "Caveat" },
};

const StatusIcon = ({ cell }: { cell: Cell }) => {
  const { Icon, cls, label } = ICON_BY_STATUS[cell.status];
  const icon = (
    <Icon className={cn("size-4 shrink-0", cls)} aria-label={label} />
  );
  if (!cell.note) {
    return <span className="inline-flex">{icon}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-help focus-visible:outline-1 focus-visible:outline-ring rounded-sm"
          aria-label={`${label}: ${cell.note}`}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent>{cell.note}</TooltipContent>
    </Tooltip>
  );
};

// Header row: providers grouped above their configurations. Each parent
// label spans only its own configurations so the visual grouping stays
// truthful (S3 / MinIO / DigitalOcean span 1, R2 spans 3, Vercel Blob spans 2).
const HEADER_GROUPS: { parent: string; span: number }[] = (() => {
  const groups: { parent: string; span: number }[] = [];
  for (const col of COLUMNS) {
    const last = groups.at(-1);
    if (last && last.parent === col.parent) {
      last.span += 1;
    } else {
      groups.push({ parent: col.parent, span: 1 });
    }
  }
  return groups;
})();

const Legend = ({
  icon: Icon,
  cls,
  children,
}: {
  icon: ComponentType<{ className?: string }>;
  cls: string;
  children: ReactNode;
}) => (
  <span className="inline-flex items-center gap-1.5">
    <Icon className={cn("size-3.5", cls)} />
    <span>{children}</span>
  </span>
);

export const CompatibilityMatrix = () => (
  <section>
    <Heading as="h2">Compatibility matrix</Heading>
    <p>
      Every adapter implements the same nine-method surface, but the URL methods
      and a couple of edge cases vary by provider. Hover the warning and error
      icons for the why behind each one.
    </p>
    <TooltipProvider delayDuration={150}>
      <div className="overflow-x-auto rounded-md border border-dotted">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-dotted">
              <th className="sticky left-0 bg-background px-3 py-2 text-left font-medium text-muted-foreground" />
              {HEADER_GROUPS.map((g, i) => (
                <th
                  className={cn(
                    "px-2 py-2 text-center font-medium text-foreground",
                    i < HEADER_GROUPS.length - 1 && "border-r border-dotted"
                  )}
                  colSpan={g.span}
                  key={g.parent}
                >
                  {g.parent}
                </th>
              ))}
            </tr>
            <tr className="border-b border-dotted">
              <th className="sticky left-0 bg-background px-3 py-2 text-left font-medium text-muted-foreground">
                Method
              </th>
              {COLUMNS.map((col, i) => {
                const next = COLUMNS[i + 1];
                const endsGroup = !next || next.parent !== col.parent;
                const sameAsParent = col.parent === col.label;
                return (
                  <th
                    className={cn(
                      "px-2 py-2 text-center font-normal text-muted-foreground whitespace-nowrap",
                      endsGroup &&
                        i < COLUMNS.length - 1 &&
                        "border-r border-dotted"
                    )}
                    key={col.key}
                  >
                    {sameAsParent ? "" : col.label}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr
                className="border-b border-dotted last:border-b-0"
                key={row.method}
              >
                <th className="sticky left-0 bg-background px-3 py-2 text-left font-mono font-normal whitespace-nowrap">
                  {row.method}
                </th>
                {COLUMNS.map((col, i) => {
                  const next = COLUMNS[i + 1];
                  const endsGroup = !next || next.parent !== col.parent;
                  return (
                    <td
                      className={cn(
                        "px-2 py-2 text-center",
                        endsGroup &&
                          i < COLUMNS.length - 1 &&
                          "border-r border-dotted"
                      )}
                      key={col.key}
                    >
                      <StatusIcon cell={row.cells[col.key]} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </TooltipProvider>
    <p className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
      <Legend icon={Check} cls="text-emerald-500">
        Supported
      </Legend>
      <Legend icon={TriangleAlert} cls="text-amber-500">
        Supported with caveat
      </Legend>
      <Legend icon={X} cls="text-red-500">
        Throws
      </Legend>
    </p>
  </section>
);
