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
  { key: "nb", label: "Netlify", parent: "Netlify Blobs" },
  { key: "minio", label: "MinIO", parent: "MinIO" },
  { key: "spaces", label: "Spaces", parent: "DigitalOcean" },
  { key: "storj", label: "Storj", parent: "Storj" },
  { key: "hetzner", label: "Hetzner", parent: "Hetzner" },
  { key: "akamai", label: "Akamai", parent: "Akamai" },
  { key: "bunny", label: "Bunny", parent: "Bunny Storage" },
  { key: "b2", label: "B2", parent: "Backblaze B2" },
  { key: "wasabi", label: "Wasabi", parent: "Wasabi" },
  { key: "scaleway", label: "Scaleway", parent: "Scaleway" },
  { key: "ovhcloud", label: "OVHcloud", parent: "OVHcloud" },
  { key: "idrive-e2", label: "iDrive e2", parent: "iDrive e2" },
  { key: "vultr", label: "Vultr", parent: "Vultr" },
  { key: "filebase", label: "Filebase", parent: "Filebase" },
  { key: "exoscale", label: "Exoscale", parent: "Exoscale" },
  { key: "oracle-cloud", label: "Oracle", parent: "Oracle Cloud" },
  { key: "ibm-cos", label: "IBM COS", parent: "IBM COS" },
  { key: "tigris", label: "Tigris", parent: "Tigris" },
  { key: "gcs", label: "GCS", parent: "GCS" },
  { key: "google-drive", label: "Drive", parent: "Google Drive" },
  { key: "onedrive", label: "OneDrive", parent: "OneDrive" },
  { key: "dropbox", label: "Dropbox", parent: "Dropbox" },
  { key: "box", label: "Box", parent: "Box" },
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
      akamai: ok,
      azure: ok,
      b2: ok,
      box: warn(
        "Two-stage: walks/creates parent folders by ID under `rootFolderId`, then `uploads.uploadFile` (≤50 MB) or `chunkedUploads.uploadBigFile` (>50 MB). Re-uploads against existing leaf names route through `uploadFileVersion` (overwrite). Stream bodies are buffered up-front - Box's upload manager takes a Node `Readable`, not a Web stream. User `metadata` and `cacheControl` throw - Box exposes file metadata via classifications and metadata templates; drop to `raw.fileMetadata.*` if you need it."
      ),
      bunny: warn(
        "Custom `metadata` and `cacheControl` throw — the Bunny Storage TypeScript SDK exposes content-type/checksum but no arbitrary object metadata or per-object cache-control field. Configure cache behavior on the Pull Zone/CDN."
      ),
      dropbox: warn(
        "Single-call `filesUpload` up to Dropbox's 150 MB limit; bodies above that automatically switch to `filesUploadSession*` (chunked, up to 350 GB) buffered into memory. Stream bodies are buffered up-front since the SDK has no streaming form. User `metadata` and `cacheControl` throw - Dropbox has no native arbitrary-metadata field; use `raw` with `property_groups` (registered template required) if you need it."
      ),
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": ok,
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: warn(
        "Stream bodies are buffered up-front - Netlify's `set()` has no streaming form, so streaming uploads can't avoid materializing the body in memory."
      ),
      onedrive: warn(
        "Single-PUT simple upload, capped at OneDrive's 250 MB simple-upload limit. Bodies above the cap throw - use `signedUploadUrl()` (`createUploadSession` returns a chunkable session URL) or drop to `raw` for chunked uploads. User `metadata` and `cacheControl` throw - Graph drive items have no native arbitrary-metadata field; use `raw` to set Open Extensions if you need them."
      ),
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: ok,
      tigris: ok,
      "ut-private": ok,
      "ut-public": ok,
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "upload",
  },
  {
    cells: {
      akamai: ok,
      azure: ok,
      b2: ok,
      box: warn(
        "Resolves the file ID, then fetches `getDownloadFileUrl` for both buffered and streaming reads - the SDK's native `downloadFile` returns a Node `Readable` that's awkward to expose isomorphically, so the adapter routes through standard HTTP, which gives a `ReadableStream` body."
      ),
      bunny: ok,
      dropbox: warn(
        "`filesDownload` buffers the full body - the SDK has no streaming download primitive. For `as: 'stream'`, the adapter mints a temporary link and fetches it via standard HTTP, which exposes a `ReadableStream` body."
      ),
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": ok,
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: ok,
      onedrive: ok,
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: ok,
      tigris: ok,
      "ut-private": ok,
      "ut-public": ok,
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "download",
  },
  {
    cells: {
      akamai: ok,
      azure: ok,
      b2: ok,
      box: ok,
      bunny: ok,
      dropbox: ok,
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": ok,
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: ok,
      onedrive: ok,
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: ok,
      tigris: ok,
      "ut-private": ok,
      "ut-public": ok,
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "delete",
  },
  {
    cells: {
      akamai: ok,
      azure: ok,
      b2: ok,
      box: warn(
        "Returns immediate-children files only at `rootFolderId` - no recursion, and subfolders are filtered out. `prefix` is filename-prefix only (matched client-side within the page). Pagination uses Box's offset, encoded as a numeric cursor string."
      ),
      bunny: warn(
        "Bunny lists a directory, not a recursive object-prefix scan. The adapter chooses the nearest directory for `prefix`, filters that page client-side, and encodes numeric offsets as cursors after fetching the directory listing."
      ),
      dropbox: warn(
        "Recursive listing under `rootFolderPath` via `filesListFolder({ recursive: true })`; folder entries are filtered out. `prefix` is matched client-side within the returned page and can under-return when the prefix isn't satisfied within a single page. Pagination uses Dropbox's opaque cursor via `filesListFolderContinue`."
      ),
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": warn(
        "Drive has no native key field. The adapter scopes by parent folder and filters client-side to files carrying its `fsdkKey` appProperty - files written into the same folder out-of-band are excluded. `prefix` is filtered page-local and can under-return when the prefix isn't satisfied within a single page."
      ),
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: warn(
        "Netlify's list response only carries key + etag - size, content type, and last-modified come from a follow-up `head()` per item, so list entries return `size: 0` and `type: 'application/octet-stream'` by default. The unified `cursor` is not honoured because Netlify's pagination cursor is internal to the SDK; the adapter iterates the SDK's paginated form and stops once `limit` is satisfied, so `limit` does bound server-side I/O."
      ),
      onedrive: warn(
        "Returns immediate-children files only at `rootFolderPath` - no recursion, and subfolders are filtered out. `prefix` is filename-prefix only (matched client-side within the page). Pagination uses Graph's `@odata.nextLink` as the opaque cursor."
      ),
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: warn(
        "Supabase's stable list API is offset/limit, not cursor-based. The adapter encodes the next offset as a numeric cursor string so the unified API works unchanged - the cursor is opaque to callers but is just `String(offset + page)` underneath."
      ),
      tigris: ok,
      "ut-private": warn(
        "UploadThing's listFiles is offset/limit, not cursor-based - the adapter encodes the next offset as a numeric cursor. `prefix` is unsupported server-side; the adapter filters the returned page client-side, which under-returns when the prefix isn't satisfied within a single page."
      ),
      "ut-public": warn(
        "UploadThing's listFiles is offset/limit, not cursor-based - the adapter encodes the next offset as a numeric cursor. `prefix` is unsupported server-side; the adapter filters the returned page client-side, which under-returns when the prefix isn't satisfied within a single page."
      ),
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "list",
  },
  {
    cells: {
      akamai: ok,
      azure: ok,
      b2: ok,
      box: warn(
        "Box doesn't store user-supplied content types on file content - `head()` returns a type inferred from the filename extension (or `application/octet-stream` when unknown). `size`, `etag`, and `lastModified` come from `getFileById`."
      ),
      bunny: ok,
      dropbox: warn(
        "Dropbox doesn't store user-supplied content types - `filesUpload` accepts no Content-Type. `head()` returns a type inferred from the filename extension (or `application/octet-stream` when unknown). `etag` is Dropbox's `rev` field."
      ),
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": ok,
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: warn(
        "Netlify Blobs has no native size, content-type, or last-modified - the adapter packs them into Netlify's metadata at upload time and reads them back via `getMetadata`. Blobs written outside the SDK come back with `size: 0` and `type: 'application/octet-stream'` because the embedded fields are absent."
      ),
      onedrive: ok,
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: ok,
      tigris: ok,
      "ut-private": warn(
        "UploadThing has no metadata endpoint, so `head()` issues a HEAD request against the resolved file URL (signed for private, CDN for public) and parses size/content-type/etag/last-modified from the response headers. User `metadata` isn't supported."
      ),
      "ut-public": warn(
        "UploadThing has no metadata endpoint, so `head()` issues a HEAD request against the resolved file URL (signed for private, CDN for public) and parses size/content-type/etag/last-modified from the response headers. User `metadata` isn't supported."
      ),
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "head",
  },
  {
    cells: {
      akamai: ok,
      azure: ok,
      b2: ok,
      box: ok,
      bunny: ok,
      dropbox: warn(
        "Resolves via `filesGetMetadata` and returns `false` for folder or deleted entries at the path - matches Dropbox's semantics where the same path can hold a folder or a tombstone. Only true file entries return `true`."
      ),
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": warn(
        "Drive has no native key field. The adapter resolves by parent folder + `fsdkKey` appProperty, so files written into the same folder out-of-band return `false` even if a file with that name exists."
      ),
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: ok,
      onedrive: ok,
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": ok,
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: ok,
      tigris: ok,
      "ut-private": warn(
        "UploadThing has no metadata endpoint, so `exists()` issues a HEAD request against the resolved file URL (signed for private, CDN for public) and treats `404` as `false`."
      ),
      "ut-public": warn(
        "UploadThing has no metadata endpoint, so `exists()` issues a HEAD request against the resolved file URL (signed for private, CDN for public) and treats `404` as `false`."
      ),
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "exists",
  },
  {
    cells: {
      akamai: ok,
      azure: warn(
        "Server-side copy via `syncCopyFromURL` - capped at 256 MB source size. Larger blobs need `beginCopyFromURL` (poller); drop down to `adapter.raw` for that. SAS-only adapter mode reuses the configured token; shared-key mode mints a 5-min read SAS."
      ),
      b2: ok,
      box: ok,
      bunny: warn(
        "Read-then-write — Bunny Storage's TypeScript SDK has no server-side copy primitive, so the source is downloaded and re-uploaded. Not server-side atomic."
      ),
      dropbox: ok,
      exoscale: ok,
      filebase: ok,
      fs: ok,
      gcs: ok,
      "google-drive": ok,
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: warn(
        "Read-then-write - Netlify Blobs has no server-side copy primitive, so the source is fetched and re-uploaded. Not server-side atomic; concurrent writes to the source between the get and put are not detected."
      ),
      onedrive: warn(
        "Async copy on Graph (`POST /items/{id}/copy` returns 202 + monitor URL). The adapter polls the monitor every 500 ms until status is `completed`/`failed`, capped by `copyTimeoutMs` (default 60_000). On timeout the call throws `Provider`; tune `copyTimeoutMs` for large files."
      ),
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": warn(
        "Read-then-write - Workers bindings have no native copy command, so the source is fetched and re-uploaded. Not server-side atomic; concurrent writes to the source between the get and put are not detected."
      ),
      "r2-http": ok,
      "r2-hybrid": warn(
        "Read-then-write - copy goes through the binding (no native copy command on Workers)."
      ),
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: ok,
      tigris: ok,
      "ut-private": warn(
        "Read-then-write - UploadThing has no server-side copy primitive, so the source is downloaded and re-uploaded. Costs an egress + an ingest; not atomic."
      ),
      "ut-public": warn(
        "Read-then-write - UploadThing has no server-side copy primitive, so the source is downloaded and re-uploaded. Costs an egress + an ingest; not atomic."
      ),
      "vb-private": ok,
      "vb-public": ok,
      vultr: ok,
      wasabi: ok,
    },
    method: "copy",
  },
  {
    cells: {
      akamai: ok,
      azure: warn(
        "Signs a SAS read URL. Throws when constructed in SAS-only or anonymous mode (no shared key available to sign). Pass `accountKey` + `accountName` or a `connectionString` that contains an account key, or set `publicBaseUrl` for a public container."
      ),
      b2: ok,
      box: warn(
        "Default mints a signed download URL via `getDownloadFileUrl` - Box controls the TTL server-side, so `expiresIn` is accepted for API symmetry but is not honoured. With `publicByDefault: true`, `upload()` calls `addShareLinkToFile` (open access) and `url()` returns the link's `download_url`. With `publicBaseUrl`, returns `<publicBaseUrl>/<key>`. `responseContentDisposition` always throws - Box's URLs have no Content-Disposition override."
      ),
      bunny: warn(
        "Requires `publicBaseUrl` (for example a Bunny Pull Zone or custom CDN hostname) and returns `<publicBaseUrl>/<key>`. Without it, throws because the Storage API URL requires an `AccessKey` header. `expiresIn` is ignored and `responseContentDisposition` throws — Bunny Storage has no signed-read URL primitive."
      ),
      dropbox: warn(
        "Default mints a 4-hour temporary link via `filesGetTemporaryLink` - `expiresIn` is honored up to Dropbox's 14400s (4h) cap; values above throw. With `publicByDefault: true`, `upload()` creates a public shared link and `url()` returns it (rewritten to `?dl=1` for direct download). With `publicBaseUrl`, returns `<publicBaseUrl>/<key>`. `responseContentDisposition` always throws - Dropbox links have no Content-Disposition override."
      ),
      exoscale: ok,
      filebase: ok,
      fs: warn(
        "Returns a `file://` URL by default - fine for CLIs and tests, not browsers. With `urlBaseUrl` set, returns `<urlBaseUrl>/<key>` so a dev server (Next.js `/public` mount, `serve-static`, etc.) can deliver the body. `responseContentDisposition` requires `urlBaseUrl` - `file://` has no signature mechanism in which to bind the override."
      ),
      gcs: ok,
      "google-drive": warn(
        "Throws by default - Drive has no signed URL primitive. With `publicByDefault: true` at construction, `upload()` grants `anyone, reader` and `url()` returns the permanent Drive download URL (`expiresIn` ignored). `responseContentDisposition` always throws - Drive's download URL has no Content-Disposition override."
      ),
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: no(
        "No URL primitive - Netlify Blobs has no public URL or signing endpoint; reads always go through the SDK with the token. Use `download()` instead, or proxy the body through your application."
      ),
      onedrive: warn(
        "Throws by default - Graph has no signed URL primitive. With `publicByDefault: true` at construction, `upload()` calls `createLink` (anonymous-view scope) and `url()` returns the share link's `webUrl`. The link is permanent (`expiresIn` ignored) and `responseContentDisposition` always throws - Graph has no Content-Disposition override. Anonymous links are blocked on tenants where admins disable them."
      ),
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": no(
        "Throws unless `publicBaseUrl` is set on the adapter (an r2.dev subdomain or a custom domain). For a presigned URL from a Worker, switch to hybrid mode by also passing `accountId` + `accessKeyId` + `secretAccessKey`."
      ),
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: warn(
        "Default mints a signed read URL via `createSignedUrl` (1-hour default). With `public: true`, returns the permanent unsigned `getPublicUrl` result. With `publicBaseUrl`, returns `<publicBaseUrl>/<key>`. `responseContentDisposition` is honored - it threads through Supabase's `download` option in the signed path."
      ),
      tigris: ok,
      "ut-private": warn(
        "Mints a signed read URL via `generateSignedURL` (1-hour default). `responseContentDisposition` throws - UploadThing has no Content-Disposition override on signed or CDN URLs."
      ),
      "ut-public": warn(
        "Returns the permanent CDN URL `https://{appId}.ufs.sh/f/{key}`. `expiresIn` is silently ignored (no signing). `responseContentDisposition` throws - UploadThing has no Content-Disposition override. Use a private adapter or a different provider for buckets with untrusted user-uploaded content."
      ),
      "vb-private": no(
        "No URL primitive for private blobs - the underlying SDK requires an authenticated `blob.get()` call with the token. Use `download()` instead, or instantiate a second public-access adapter."
      ),
      "vb-public": warn(
        "Returns the permanent CDN URL. `expiresIn` is silently ignored (no signing primitive); `responseContentDisposition` throws (no Content-Disposition override available). Use a different provider for buckets with untrusted user-uploaded content."
      ),
      vultr: ok,
      wasabi: ok,
    },
    method: "url",
  },
  {
    cells: {
      akamai: ok,
      azure: warn(
        "PUT URL only - Azure has no POST policy equivalent. `maxSize` throws because Azure SAS has no `content-length-range` policy; enforce upload caps at your application gateway instead. Throws in SAS-only or anonymous mode (no shared key to sign). The returned headers include the required `x-ms-blob-type: BlockBlob`."
      ),
      b2: ok,
      box: no(
        "Throws - Box uploads require a multipart POST with both an `attributes` JSON part and the file bytes part, which fits neither the SDK's PUT-with-headers nor S3-style POST-with-form-fields shape. Use `upload()` server-side, or Box's UI Elements / Content Uploader for browser flows."
      ),
      bunny: no(
        "Throws — Bunny Storage has no presigned upload primitive. Writes go through the Storage API with an `AccessKey` header, so upload server-side via the SDK or proxy through your application."
      ),
      dropbox: no(
        "Throws - Dropbox's `filesGetTemporaryUploadLink` returns a URL that expects POST with a raw body, which fits neither the SDK's PUT-with-headers nor POST-with-form-fields shape. Use `upload()` or drop to `raw.filesGetTemporaryUploadLink(...)` for client-side uploads."
      ),
      exoscale: ok,
      filebase: ok,
      fs: warn(
        "Throws without `urlBaseUrl` - the fs adapter has no built-in upload server, so there's nothing to sign against. With `urlBaseUrl` set, returns a PUT URL with `?expires=`, `?content-type=`, and `?max-size=` query params for a dev upload-handler to validate. The fs adapter does not enforce the params itself."
      ),
      gcs: ok,
      "google-drive": warn(
        "Initiates a Drive resumable session via `POST /upload/drive/v3/files?uploadType=resumable` and returns the session URL as a one-shot PUT. `maxSize` is forwarded as `X-Upload-Content-Length` but Drive does not enforce a server-side size cap - it's advisory. `minSize` is ignored. Throws when the adapter was constructed via the pre-built `client` escape hatch (no auth handle to mint access tokens)."
      ),
      hetzner: ok,
      "ibm-cos": ok,
      "idrive-e2": ok,
      minio: ok,
      nb: no(
        "No presigned upload primitive - Netlify Blobs writes go through the SDK with the token. Upload server-side via the SDK or proxy uploads through your application."
      ),
      onedrive: warn(
        "Initiates a Graph upload session via `POST /createUploadSession` and returns the session URL as a one-shot PUT (the session URL is pre-authenticated by Graph itself). `maxSize` and `minSize` are advisory - Graph does not enforce a server-side `content-length-range` policy on upload sessions; clients can still chunk via `Content-Range` to the same URL."
      ),
      "oracle-cloud": ok,
      ovhcloud: ok,
      "r2-binding": no(
        "Workers bindings can't sign uploads - the secret access key is not available to the runtime. Use hybrid mode (binding + HTTP credentials) to issue presigned upload URLs."
      ),
      "r2-http": ok,
      "r2-hybrid": ok,
      s3: ok,
      scaleway: ok,
      spaces: ok,
      storj: ok,
      supabase: warn(
        "PUT URL only - Supabase has no POST policy equivalent. `maxSize` throws (Supabase signed upload URLs have no `content-length-range` policy; set the bucket-level size limit in the dashboard instead). `expiresIn` is silently ignored - Supabase fixes the TTL at 2 hours server-side. The returned headers include `x-upsert: true`."
      ),
      tigris: ok,
      "ut-private": warn(
        "PUT URL only - built against UploadThing's UFS ingest endpoint with an HMAC-SHA256 signature over the URL. `maxSize` is advisory: UploadThing enforces upload caps via the file-router config tied to the adapter's `slug`, not via the URL signature. `minSize` is ignored (no equivalent on UFS). The user-supplied key is bound as `x-ut-custom-id` so subsequent ops can route by it."
      ),
      "ut-public": warn(
        "PUT URL only - built against UploadThing's UFS ingest endpoint with an HMAC-SHA256 signature over the URL. `maxSize` is advisory: UploadThing enforces upload caps via the file-router config tied to the adapter's `slug`, not via the URL signature. `minSize` is ignored (no equivalent on UFS). The user-supplied key is bound as `x-ut-custom-id` so subsequent ops can route by it."
      ),
      "vb-private": no(
        "No presigned upload primitive. Use `handleUpload()` from `@vercel/blob/client` for browser uploads."
      ),
      "vb-public": no(
        "No presigned upload primitive. Use `handleUpload()` from `@vercel/blob/client` for browser uploads."
      ),
      vultr: ok,
      wasabi: ok,
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
      Every adapter implements the same ten-method surface, but the URL methods
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
