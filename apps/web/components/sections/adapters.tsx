import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const S3_EXAMPLE = `import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({
    bucket: "uploads",
    region: "us-east-1",
    // credentials auto-loaded from the AWS chain
    // (env vars, IAM role, shared profile, ...)
  }),
});`;

const R2_EXAMPLE = `import { Files } from "files-sdk";
import { r2 } from "files-sdk/r2";

const files = new Files({
  adapter: r2({
    bucket: "uploads",
    accountId: process.env.R2_ACCOUNT_ID!,
    // accessKeyId / secretAccessKey auto-loaded
    // from R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY
  }),
});`;

const R2_HYBRID_EXAMPLE = `// Inside a Cloudflare Worker. The binding handles uploads/downloads
// (intra-Worker, no egress fees). The HTTP credentials let url() and
// signedUploadUrl() sign presigned URLs the binding alone can't produce.
const files = new Files({
  adapter: r2({
    binding: env.UPLOADS,
    bucket: "uploads",
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }),
});`;

const VERCEL_BLOB_EXAMPLE = `import { Files } from "files-sdk";
import { vercelBlob } from "files-sdk/vercel-blob";

// BLOB_READ_WRITE_TOKEN is auto-injected on Vercel.
const files = new Files({ adapter: vercelBlob() });`;

const NETLIFY_BLOBS_EXAMPLE = `import { Files } from "files-sdk";
import { netlifyBlobs } from "files-sdk/netlify-blobs";

// On Netlify Functions / Edge / build runtimes, siteID + token are
// auto-detected from NETLIFY_BLOBS_CONTEXT — pass them explicitly only
// when running outside Netlify (e.g. local scripts, your own server).
const files = new Files({
  adapter: netlifyBlobs({
    name: "uploads",
    // siteID: process.env.NETLIFY_SITE_ID,
    // token: process.env.NETLIFY_API_TOKEN,
    // deployScoped: false,           // true uses getDeployStore()
    // consistency: "eventual",       // or "strong"
  }),
});`;

const MINIO_EXAMPLE = `import { Files } from "files-sdk";
import { minio } from "files-sdk/minio";

const files = new Files({
  adapter: minio({
    bucket: "uploads",
    endpoint: "http://localhost:9000",
    // accessKeyId / secretAccessKey auto-loaded from
    // MINIO_ACCESS_KEY_ID / MINIO_SECRET_ACCESS_KEY
  }),
});`;

const DIGITALOCEAN_SPACES_EXAMPLE = `import { Files } from "files-sdk";
import { digitaloceanSpaces } from "files-sdk/digitalocean-spaces";

const files = new Files({
  adapter: digitaloceanSpaces({
    bucket: "uploads",
    region: "nyc3",
    // accessKeyId / secretAccessKey auto-loaded from
    // DO_SPACES_KEY / DO_SPACES_SECRET
  }),
});`;

const STORJ_EXAMPLE = `import { Files } from "files-sdk";
import { storj } from "files-sdk/storj";

const files = new Files({
  adapter: storj({
    bucket: "uploads",
    // endpoint defaults to https://gateway.storjshare.io (Gateway MT).
    // Pass a self-hosted Gateway ST URL to override.
    // accessKeyId / secretAccessKey auto-loaded from
    // STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY
  }),
});`;

const HETZNER_EXAMPLE = `import { Files } from "files-sdk";
import { hetzner } from "files-sdk/hetzner";

const files = new Files({
  adapter: hetzner({
    bucket: "uploads",
    region: "fsn1", // or "nbg1", "hel1"
    // accessKeyId / secretAccessKey auto-loaded from
    // HCLOUD_ACCESS_KEY_ID / HCLOUD_SECRET_ACCESS_KEY
  }),
});`;

const AKAMAI_EXAMPLE = `import { Files } from "files-sdk";
import { akamai } from "files-sdk/akamai";

const files = new Files({
  adapter: akamai({
    bucket: "uploads",
    region: "us-iad-1", // or "nl-ams-1", "fr-par-1", "us-east-1", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // AKAMAI_ACCESS_KEY_ID / AKAMAI_SECRET_ACCESS_KEY
  }),
});`;

const GCS_EXAMPLE = `import { Files } from "files-sdk";
import { gcs } from "files-sdk/gcs";

const files = new Files({
  adapter: gcs({
    bucket: "uploads",
    // No credentials needed in most setups — the @google-cloud/storage
    // SDK auto-discovers Application Default Credentials from
    // GOOGLE_APPLICATION_CREDENTIALS, gcloud auth, or the runtime
    // service account on Cloud Run / GKE / GCE.
  }),
});`;

const GOOGLE_DRIVE_EXAMPLE = `import { Files } from "files-sdk";
import { googleDrive } from "files-sdk/google-drive";

// Service account into a Shared Drive (recommended — the default
// service-account quota is 15 GB and not really intended for storage).
// Add the service account as a member of the Shared Drive in the
// Google Workspace admin console first.
const files = new Files({
  adapter: googleDrive({
    credentials: {
      client_email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL!,
      private_key: process.env.GOOGLE_DRIVE_PRIVATE_KEY!,
    },
    driveId: process.env.GOOGLE_DRIVE_ID!,
    // Shared Drive root id, or a sub-folder id to scope the "bucket".
    rootFolderId: process.env.GOOGLE_DRIVE_ID!,
    // publicByDefault: true → grants anyone-with-link reader on upload
    //                       and url() returns the Drive download URL.
  }),
});`;

const ONEDRIVE_EXAMPLE = `import { Files } from "files-sdk";
import { onedrive } from "files-sdk/onedrive";

// App-only auth (client credentials) into a SharePoint site library.
// Cannot use /me/drive — pass driveId, siteId, or userId instead.
const files = new Files({
  adapter: onedrive({
    clientCredentials: {
      tenantId: process.env.MS_TENANT_ID!,
      clientId: process.env.MS_CLIENT_ID!,
      clientSecret: process.env.MS_CLIENT_SECRET!,
    },
    siteId: process.env.MS_SITE_ID!,
    rootFolderPath: "Uploads",
    // publicByDefault: true → upload() also creates an anonymous-view
    //                       sharing link and url() returns its webUrl.
  }),
});`;

const DROPBOX_EXAMPLE = `import { Files } from "files-sdk";
import { dropbox } from "files-sdk/dropbox";

// OAuth2 refresh-token flow (recommended for server-side apps).
// The adapter exchanges the refresh token at api.dropboxapi.com/oauth2/token
// and caches the access token until ~60s before expiry.
const files = new Files({
  adapter: dropbox({
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN!,
    appKey: process.env.DROPBOX_APP_KEY!,
    appSecret: process.env.DROPBOX_APP_SECRET, // omit for PKCE public clients
    rootFolderPath: "/Uploads",
    // publicByDefault: true → upload() also creates a public shared link
    //                       and url() returns it (rewritten to ?dl=1 for
    //                       direct download).
  }),
});`;

const BOX_EXAMPLE = `import { Files } from "files-sdk";
import { box } from "files-sdk/box";

// Server-side: Client Credentials Grant (recommended for backend services).
// The SDK manages access-token lifetime internally — no manual refresh
// bookkeeping in the adapter.
const files = new Files({
  adapter: box({
    ccg: {
      clientId: process.env.BOX_CLIENT_ID!,
      clientSecret: process.env.BOX_CLIENT_SECRET!,
      enterpriseId: process.env.BOX_ENTERPRISE_ID!,
    },
    rootFolderId: process.env.BOX_ROOT_FOLDER_ID, // defaults to "0" (account root)
    // publicByDefault: true → upload() also calls addShareLinkToFile and
    //                       url() returns the link's download_url.
  }),
});

// Other auth shapes the adapter accepts:
//   developerToken: process.env.BOX_DEVELOPER_TOKEN  // dev-console token
//   oauth: { clientId, clientSecret, refreshToken } // user-app flow
//   jwt:   { configJsonString }                     // JWT server auth
//   client: yourBoxClient                           // pre-built escape hatch`;

const AZURE_EXAMPLE = `import { Files } from "files-sdk";
import { azure } from "files-sdk/azure";

const files = new Files({
  adapter: azure({
    container: "uploads",
    // Auto-loads from AZURE_STORAGE_CONNECTION_STRING, or
    // AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY.
    // Pass connectionString / accountKey / sasToken explicitly to override.
  }),
});`;

const SUPABASE_EXAMPLE = `import { Files } from "files-sdk";
import { supabase } from "files-sdk/supabase";

const files = new Files({
  adapter: supabase({
    bucket: "uploads",
    // Auto-loads url + key from SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL
    // and SUPABASE_SERVICE_ROLE_KEY / SUPABASE_KEY /
    // NEXT_PUBLIC_SUPABASE_ANON_KEY. Or pass an existing SupabaseClient
    // via \`client\` to share with auth/postgrest.
  }),
});`;

const UPLOADTHING_EXAMPLE = `import { Files } from "files-sdk";
import { uploadthing } from "files-sdk/uploadthing";

// UPLOADTHING_TOKEN is auto-loaded from env. The token is a base64
// JSON of { apiKey, appId, regions[] } — the adapter decodes it at
// construction so url() can synthesize the public CDN URL and
// signedUploadUrl() can sign a UFS PUT URL without an API round trip.
const files = new Files({
  adapter: uploadthing({
    // acl: "public-read",       // default; switch to "private" to mint
    //                            // signed URLs through generateSignedURL
    // slug: "mediaUploader",    // required only for signedUploadUrl()
  }),
});`;

const FS_EXAMPLE = `import { Files } from "files-sdk";
import { fs } from "files-sdk/fs";

// Writes objects under \`./.uploads\` with a sidecar \`.meta.json\`
// per file for Content-Type, ETag, and user metadata. Designed for
// dev and CI — same Adapter contract as the cloud adapters, so swap
// it in via env without changing call sites.
const files = new Files({
  adapter: fs({
    root: "./.uploads",
    // Optional: configure if a dev server exposes the same root over
    // HTTP, so url() returns a browser-friendly URL instead of file://.
    // urlBaseUrl: "http://localhost:3000/files",
  }),
});`;

export const Adapters = () => (
  <section>
    <Heading as="h2">Adapters</Heading>
    <p>
      Each adapter is a subpath import. Bring only what you use; the others
      tree-shake away. Adapters auto-load credentials from the standard
      environment variables for that provider — pass options explicitly to
      override. If an adapter is constructed without enough info to
      authenticate, it throws at construction time naming the missing variable.
    </p>

    <section>
      <Heading as="h3" id="adapter-s3">
        S3
      </Heading>
      <p>
        AWS S3 (and any S3-compatible bucket). Uses the standard AWS credential
        chain — environment, IAM role, shared profile.
      </p>
      <CodeBlock code={S3_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-s3-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>S3 bucket name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="optional" value="region">
            <p>
              AWS region the bucket lives in (e.g. <code>us-east-1</code>).
              Falls back to <code>AWS_REGION</code>; required if no env var is
              set.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="credentials"
            status="optional"
            value="credentials"
          >
            <p>
              Static credentials —{" "}
              <code>{"{ accessKeyId, secretAccessKey, sessionToken? }"}</code>.
              Skip to use the AWS credential chain (env vars, IAM role, shared
              profile, EC2/ECS/EKS instance metadata).
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="optional" value="endpoint">
            <p>
              Override the S3 service endpoint. Use this to point at
              S3-compatible services (DigitalOcean Spaces, Wasabi, Backblaze B2,
              LocalStack, etc.).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing —
              use this if your bucket is fronted by CloudFront or has a
              public-read policy. When unset, <code>url()</code> returns a
              presigned GetObject (1-hour default).
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-r2">
        Cloudflare R2
      </Heading>
      <p>
        Cloudflare R2 over the S3-compatible HTTP API. Auto-loads from{" "}
        <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>,{" "}
        <code>R2_SECRET_ACCESS_KEY</code>. Inside Cloudflare Workers you can
        pass an <code>R2Bucket</code> binding directly instead.
      </p>
      <CodeBlock code={R2_EXAMPLE} lang="ts" />
      <p>
        <code>publicBaseUrl</code> — optional, an <code>r2.dev</code> subdomain
        or custom domain bound to the bucket. When set, <code>url()</code>{" "}
        returns <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips
        signing.
      </p>
      <Heading as="h4" id="adapter-r2-hybrid">
        Hybrid: binding + HTTP credentials
      </Heading>
      <p>
        Inside a Worker, you can pass <em>both</em> a binding and HTTP
        credentials. Reads and writes go through the binding (no egress, no
        extra round trip); <code>url()</code> and <code>signedUploadUrl()</code>{" "}
        route through the HTTP signer because a Worker binding has no signing
        primitive. The S3 client is lazy-loaded — bindings-only Workers don't
        pull <code>@aws-sdk/client-s3</code> into their bundle.
      </p>
      <CodeBlock code={R2_HYBRID_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="adapter-vercel-blob">
        Vercel Blob
      </Heading>
      <p>
        Vercel Blob. The <code>BLOB_READ_WRITE_TOKEN</code> is auto-injected
        when deployed on Vercel; pass <code>token</code> manually for local dev
        or other hosts.
      </p>
      <CodeBlock code={VERCEL_BLOB_EXAMPLE} lang="ts" />
      <p>
        <code>downloadTimeoutMs</code> bounds the public-URL fetches issued by{" "}
        <code>download()</code> and the lazy bodies returned from{" "}
        <code>head()</code>/<code>list()</code>. Defaults to 5 minutes; pass{" "}
        <code>0</code> to disable. A hung CDN response would otherwise leak a
        fetch that never resolves.
      </p>
      <p>
        <code>access</code> selects public or private blobs and is fixed at
        construction. Default <code>"public"</code> matches the existing
        behavior. With <code>access: "private"</code>, uploads use Vercel's
        private mode and reads route through <code>blob.get()</code> with the
        token instead of a public URL fetch — there is no permanent public URL
        for private blobs, so <code>url()</code> throws. Need both? Use two
        adapters.
      </p>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-vercel-blob-limitations">
          Limitations
        </Heading>
        <p>
          <code>signedUploadUrl()</code> throws — browser uploads go through{" "}
          <code>handleUpload()</code> from <code>@vercel/blob/client</code>{" "}
          instead of presigned URLs. <code>url()</code> on public blobs returns
          the permanent CDN URL: <code>expiresIn</code> is silently ignored (no
          signing primitive) and <code>responseContentDisposition</code> throws
          (no override available). On <code>access: "private"</code>,{" "}
          <code>url()</code> throws because there's no public URL — use{" "}
          <code>download()</code> instead. User <code>metadata</code> isn't
          supported by the underlying API, so it round-trips as{" "}
          <code>undefined</code>.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-netlify-blobs">
        Netlify Blobs
      </Heading>
      <p>
        Netlify Blobs via the official <code>@netlify/blobs</code> SDK. On
        Netlify runtimes (Functions, Edge Functions, build steps),{" "}
        <code>siteID</code> and <code>token</code> are auto-detected from{" "}
        <code>NETLIFY_BLOBS_CONTEXT</code> — pass them explicitly only when
        running outside Netlify. Falls back to <code>NETLIFY_SITE_ID</code> +{" "}
        <code>NETLIFY_API_TOKEN</code> (or <code>NETLIFY_BLOBS_TOKEN</code>)
        from env.
      </p>
      <CodeBlock code={NETLIFY_BLOBS_EXAMPLE} lang="ts" />
      <p>
        Netlify Blobs has no native size, content-type, or last-modified fields,
        so the adapter packs them — plus <code>cacheControl</code> and user{" "}
        <code>metadata</code> — into Netlify's metadata map at upload time.{" "}
        <code>head()</code> and <code>download()</code> read them back, so the
        unified <code>StoredFile</code> shape works the same as on the cloud
        adapters.
      </p>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-netlify-blobs-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="name" status="required" value="name">
            <p>
              Store name. Netlify keys data per store; the adapter scopes every
              operation to it. Max 64 bytes per Netlify's limits.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="siteID" status="optional" value="siteID">
            <p>
              Netlify site ID. Falls back to <code>NETLIFY_SITE_ID</code>.
              Auto-detected from the runtime context on Netlify — only required
              outside Netlify.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="token" status="optional" value="token">
            <p>
              Netlify access token. Falls back to <code>NETLIFY_API_TOKEN</code>{" "}
              then <code>NETLIFY_BLOBS_TOKEN</code>. Auto-detected from the
              runtime context on Netlify — only required outside Netlify.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="deployScoped"
            status="optional"
            value="deployScoped"
          >
            <p>
              When <code>true</code>, uses <code>getDeployStore()</code> — the
              store is tied to the current deploy and garbage-collected when the
              deploy is removed. Defaults to <code>false</code> (site-scoped,
              persists across deploys), which is the right choice for almost
              everything.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="consistency"
            status="optional"
            value="consistency"
          >
            <p>
              Read consistency mode. <code>"eventual"</code> (default) reads
              from the edge cache and is faster; <code>"strong"</code> reads
              from the origin and guarantees read-your-writes.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-netlify-blobs-limitations">
          Limitations
        </Heading>
        <p>
          <code>url()</code> throws — Netlify Blobs has no public URL primitive;
          reads always go through the SDK with the token. Use{" "}
          <code>download()</code> instead. <code>signedUploadUrl()</code> throws
          — there is no presigned upload primitive; uploads must go through the
          SDK or be proxied by your application.
        </p>
        <p>
          <code>copy()</code> is a read-then-write — Netlify has no server-side
          copy primitive, so the source is fetched and re-written at the
          destination. Not server-side atomic. <code>list()</code> only carries
          key + etag from Netlify; size, content type, and last-modified come
          from a follow-up <code>head()</code> per item, so list entries return{" "}
          <code>size: 0</code> and <code>type: "application/octet-stream"</code>{" "}
          by default. The unified <code>cursor</code> is not honoured because
          Netlify's pagination cursor is internal to the SDK, but the adapter
          iterates the SDK's paginated form and stops once <code>limit</code> is
          satisfied — so <code>limit</code> does bound server-side I/O. Stream
          uploads are buffered up-front because Netlify's <code>set()</code> has
          no streaming form.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-minio">
        MinIO
      </Heading>
      <p>
        MinIO and other self-hosted S3-compatible servers. A thin wrapper around
        the S3 adapter with MinIO-friendly defaults — path-style addressing on,
        region defaulted, errors relabelled. Auto-loads from{" "}
        <code>MINIO_ACCESS_KEY_ID</code> and{" "}
        <code>MINIO_SECRET_ACCESS_KEY</code>.
      </p>
      <CodeBlock code={MINIO_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-minio-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>MinIO bucket name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="required" value="endpoint">
            <p>
              MinIO server URL, e.g. <code>http://localhost:9000</code>. Include
              the scheme — <code>http://</code> for local dev,{" "}
              <code>https://</code> in production.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessKeyId / secretAccessKey"
            status="required"
            value="accessKeyId"
          >
            <p>
              Static credentials. Falls back to <code>MINIO_ACCESS_KEY_ID</code>{" "}
              and <code>MINIO_SECRET_ACCESS_KEY</code>; required if those env
              vars aren't set.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="optional" value="region">
            <p>
              SigV4 region used for signing. Defaults to <code>us-east-1</code>.
              SigV4 requires some region in the signature, but MinIO ignores it
              for routing — leave the default unless you've configured
              per-region buckets.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="forcePathStyle"
            status="optional"
            value="forcePathStyle"
          >
            <p>
              Use path-style addressing (
              <code>/&lt;bucket&gt;/&lt;key&gt;</code>) rather than
              virtual-hosted style. Defaults to <code>true</code> for MinIO;
              flip off only if you've set up per-bucket subdomain routing in
              front of your server.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              Use this if you've fronted MinIO with a CDN or set a public bucket
              policy. When unset, <code>url()</code> returns a presigned
              GetObject (1-hour default).
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-digitalocean-spaces">
        DigitalOcean Spaces
      </Heading>
      <p>
        DigitalOcean Spaces via the S3-compatible API. A thin wrapper around the
        S3 adapter — endpoint derived from the region you pass, errors
        relabelled, virtual-hosted addressing left as the default. Auto-loads
        from <code>DO_SPACES_KEY</code> and <code>DO_SPACES_SECRET</code>.
      </p>
      <CodeBlock code={DIGITALOCEAN_SPACES_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-digitalocean-spaces-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>Spaces name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="required" value="region">
            <p>
              Spaces datacenter region — e.g. <code>nyc3</code>,{" "}
              <code>sfo3</code>, <code>ams3</code>, <code>fra1</code>,{" "}
              <code>sgp1</code>, <code>syd1</code>, <code>blr1</code>,{" "}
              <code>tor1</code>, <code>lon1</code>. Drives the endpoint host;
              there's no env-var fallback.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessKeyId / secretAccessKey"
            status="required"
            value="accessKeyId"
          >
            <p>
              Static credentials. Falls back to <code>DO_SPACES_KEY</code> and{" "}
              <code>DO_SPACES_SECRET</code>; required if those env vars aren't
              set.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="optional" value="endpoint">
            <p>
              Override the Spaces endpoint. Defaults to{" "}
              <code>{`https://\${region}.digitaloceanspaces.com`}</code>. Spaces
              routes by Host header — the SDK prepends the bucket subdomain for
              virtual-hosted style.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="forcePathStyle"
            status="optional"
            value="forcePathStyle"
          >
            <p>
              Use path-style addressing (
              <code>/&lt;bucket&gt;/&lt;key&gt;</code>) rather than
              virtual-hosted style. Defaults to <code>false</code> —
              virtual-hosted (
              <code>{`<bucket>.<region>.digitaloceanspaces.com`}</code>) is the
              canonical Spaces routing.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              Typical values are the Spaces CDN host (
              <code>{`https://<bucket>.<region>.cdn.digitaloceanspaces.com`}</code>
              ) or a custom CNAME you've bound to the Space. When unset,{" "}
              <code>url()</code> returns a presigned GetObject (1-hour default).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the presigned URLs returned by{" "}
              <code>url()</code> when <code>publicBaseUrl</code> isn't set.
              Defaults to 3600 (1 hour). Per-call{" "}
              <code>url(key, {"{ expiresIn }"})</code> overrides.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-storj">
        Storj
      </Heading>
      <p>
        Storj DCS via its S3-compatible Gateway. A thin wrapper around the S3
        adapter — endpoint defaults to Storj's hosted Gateway MT, path-style
        addressing on, errors relabelled. Auto-loads from{" "}
        <code>STORJ_ACCESS_KEY_ID</code> and{" "}
        <code>STORJ_SECRET_ACCESS_KEY</code>. Generate access keys in the Storj
        console or with <code>uplink share --register</code>.
      </p>
      <CodeBlock code={STORJ_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-storj-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>Storj bucket name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessKeyId / secretAccessKey"
            status="required"
            value="accessKeyId"
          >
            <p>
              Static credentials. Falls back to <code>STORJ_ACCESS_KEY_ID</code>{" "}
              and <code>STORJ_SECRET_ACCESS_KEY</code>; required if those env
              vars aren't set. These are S3-style gateway keys, not your Storj
              access grant — the gateway translates them server-side.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="optional" value="endpoint">
            <p>
              Storj S3 gateway URL. Defaults to{" "}
              <code>https://gateway.storjshare.io</code> (Gateway MT — the
              hosted multi-tenant gateway, what most users want). Override with
              your own URL if you self-host Gateway ST.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="optional" value="region">
            <p>
              SigV4 region used for signing. Defaults to <code>us-east-1</code>.
              SigV4 requires some region in the signature; the Storj gateway
              ignores it for routing, so leave the default unless you have a
              reason to change it.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="forcePathStyle"
            status="optional"
            value="forcePathStyle"
          >
            <p>
              Use path-style addressing (
              <code>/&lt;bucket&gt;/&lt;key&gt;</code>). Defaults to{" "}
              <code>true</code> for Storj — the gateway routes path-style. Flip
              off only if you've fronted the gateway with subdomain routing.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              For Storj, the natural value is a linksharing prefix like{" "}
              <code>{`https://link.storjshare.io/raw/<accessGrant>/<bucket>`}</code>{" "}
              — generate one with <code>uplink share --url</code>. When unset,{" "}
              <code>url()</code> returns a presigned GetObject (1-hour default).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the presigned URLs returned by{" "}
              <code>url()</code> when <code>publicBaseUrl</code> isn't set.
              Defaults to 3600 (1 hour). Per-call{" "}
              <code>url(key, {"{ expiresIn }"})</code> overrides.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-hetzner">
        Hetzner Object Storage
      </Heading>
      <p>
        Hetzner Object Storage via its S3-compatible API. A thin wrapper around
        the S3 adapter — endpoint derived from the location code (
        <code>fsn1</code>, <code>nbg1</code>, <code>hel1</code>),
        virtual-hosted-style addressing, errors relabelled. Auto-loads from{" "}
        <code>HCLOUD_ACCESS_KEY_ID</code> and{" "}
        <code>HCLOUD_SECRET_ACCESS_KEY</code>. Generate access keys in the
        Hetzner Cloud Console under Object Storage → Credentials.
      </p>
      <CodeBlock code={HETZNER_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-hetzner-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>Hetzner bucket name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="required" value="region">
            <p>
              Hetzner location code — <code>fsn1</code> (Falkenstein),{" "}
              <code>nbg1</code> (Nuremberg), or <code>hel1</code> (Helsinki).
              Drives the endpoint host (
              <code>{`<region>.your-objectstorage.com`}</code>) and doubles as
              the SigV4 region. No env-var fallback.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessKeyId / secretAccessKey"
            status="required"
            value="accessKeyId"
          >
            <p>
              Static credentials. Falls back to{" "}
              <code>HCLOUD_ACCESS_KEY_ID</code> and{" "}
              <code>HCLOUD_SECRET_ACCESS_KEY</code>; required if those env vars
              aren't set.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="optional" value="endpoint">
            <p>
              Override the default endpoint. When unset, defaults to{" "}
              <code>{`https://<region>.your-objectstorage.com`}</code>. Useful
              behind a custom proxy or for non-default deployments.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="forcePathStyle"
            status="optional"
            value="forcePathStyle"
          >
            <p>
              Use path-style addressing (
              <code>/&lt;bucket&gt;/&lt;key&gt;</code>) rather than
              virtual-hosted style. Defaults to <code>false</code> —
              virtual-hosted is canonical for Hetzner.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              Hetzner Object Storage has no built-in CDN, so this is typically a
              custom CNAME or reverse proxy fronting the bucket. When unset,{" "}
              <code>url()</code> returns a presigned GetObject (1-hour default).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the presigned URLs returned by{" "}
              <code>url()</code> when <code>publicBaseUrl</code> isn't set.
              Defaults to 3600 (1 hour). Per-call{" "}
              <code>url(key, {"{ expiresIn }"})</code> overrides.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-akamai">
        Akamai Cloud Object Storage
      </Heading>
      <p>
        Akamai Cloud Object Storage (formerly Linode Object Storage) via its
        S3-compatible API. A thin wrapper around the S3 adapter — endpoint
        derived from the region/cluster code (<code>us-iad-1</code>,{" "}
        <code>nl-ams-1</code>, <code>fr-par-1</code>, …), virtual-hosted-style
        addressing, errors relabelled. The endpoint domain{" "}
        <code>linodeobjects.com</code> is unchanged from the Linode era — only
        the product branding moved to Akamai. Auto-loads from{" "}
        <code>AKAMAI_ACCESS_KEY_ID</code> and{" "}
        <code>AKAMAI_SECRET_ACCESS_KEY</code>. Generate access keys in the
        Akamai Cloud Manager under Object Storage → Access Keys.
      </p>
      <CodeBlock code={AKAMAI_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-akamai-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>Akamai bucket name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="required" value="region">
            <p>
              Akamai region/cluster code — newer regions follow the{" "}
              <code>us-iad-1</code> (Washington DC), <code>us-mia-1</code>{" "}
              (Miami), <code>nl-ams-1</code> (Amsterdam), <code>fr-par-1</code>{" "}
              (Paris) pattern; older clusters use <code>us-east-1</code>,{" "}
              <code>eu-central-1</code>, <code>ap-south-1</code>. Drives the
              endpoint host (<code>{`<region>.linodeobjects.com`}</code>) and
              doubles as the SigV4 region. No env-var fallback.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessKeyId / secretAccessKey"
            status="required"
            value="accessKeyId"
          >
            <p>
              Static credentials. Falls back to{" "}
              <code>AKAMAI_ACCESS_KEY_ID</code> and{" "}
              <code>AKAMAI_SECRET_ACCESS_KEY</code>; required if those env vars
              aren't set.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="optional" value="endpoint">
            <p>
              Override the default endpoint. When unset, defaults to{" "}
              <code>{`https://<region>.linodeobjects.com`}</code>. Useful behind
              a custom proxy or for non-default deployments.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="forcePathStyle"
            status="optional"
            value="forcePathStyle"
          >
            <p>
              Use path-style addressing (
              <code>/&lt;bucket&gt;/&lt;key&gt;</code>) rather than
              virtual-hosted style. Defaults to <code>false</code> —
              virtual-hosted is canonical for Akamai.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              For buckets with public ACL, the natural value is{" "}
              <code>{`https://<bucket>.<region>.linodeobjects.com`}</code>; a
              custom CNAME fronting the bucket also works. When unset,{" "}
              <code>url()</code> returns a presigned GetObject (1-hour default).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the presigned URLs returned by{" "}
              <code>url()</code> when <code>publicBaseUrl</code> isn't set.
              Defaults to 3600 (1 hour). Per-call{" "}
              <code>url(key, {"{ expiresIn }"})</code> overrides.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-gcs">
        Google Cloud Storage
      </Heading>
      <p>
        Google Cloud Storage via the official <code>@google-cloud/storage</code>{" "}
        SDK. Auth follows the standard Google chain — Application Default
        Credentials by default, with explicit overrides if you need them.
      </p>
      <CodeBlock code={GCS_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-gcs-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>GCS bucket name. The adapter scopes all operations to it.</p>
          </PropAccordionItem>
          <PropAccordionItem
            name="projectId"
            status="optional"
            value="projectId"
          >
            <p>
              GCP project ID. Falls back to <code>GOOGLE_CLOUD_PROJECT</code>{" "}
              then <code>GCLOUD_PROJECT</code>. Application Default Credentials
              carry a project ID, so this is rarely needed.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="keyFilename"
            status="optional"
            value="keyFilename"
          >
            <p>
              Path to a service-account JSON file. Takes precedence over ADC
              when set. Use this when ADC isn't available — typically outside
              GCP runtimes.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="credentials"
            status="optional"
            value="credentials"
          >
            <p>
              Inline service-account credentials —{" "}
              <code>{"{ client_email, private_key }"}</code>. Useful when you
              only have those fields as separate env vars (Vercel, Netlify) and
              don't want to materialize a JSON file. <code>url()</code> and{" "}
              <code>signedUploadUrl()</code> need either inline credentials or
              the <code>iam.serviceAccounts.signBlob</code> permission on the
              runtime service account so the SDK can fall back to IAM SignBlob.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              For a public GCS bucket the natural value is{" "}
              <code>https://storage.googleapis.com/&lt;bucket&gt;</code>; or
              point at a Cloud CDN / load balancer host. When unset,{" "}
              <code>url()</code> returns a V4 signed read URL (1-hour default;
              GCS caps V4 at 7 days).
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-google-drive">
        Google Drive
      </Heading>
      <p>
        Google Drive via the official <code>@googleapis/drive</code> v3 client.
        Drive is a document manager rather than object storage — files have
        opaque <code>fileId</code>s and names can collide, so the adapter maps a
        unified string key onto Drive's <code>appProperties</code> (
        <code>fsdkKey</code>), with a per-instance LRU so reads after the first
        don't re-issue a lookup. Three auth modes: service-account credentials,
        an OAuth refresh token, or a pre-built Drive client (the escape hatch).
      </p>
      <CodeBlock code={GOOGLE_DRIVE_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-google-drive-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem
            name="credentials"
            status="optional"
            value="credentials"
          >
            <p>
              Inline service-account credentials —{" "}
              <code>{"{ client_email, private_key }"}</code>. Mutually exclusive
              with the other auth shapes. Service accounts have a 15 GB personal
              quota — production usage should target a Shared Drive (
              <code>driveId</code>) with the service account added as a member.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="keyFilename"
            status="optional"
            value="keyFilename"
          >
            <p>
              Path to a service-account JSON file. Mutually exclusive with{" "}
              <code>credentials</code>, <code>oauth</code>, and{" "}
              <code>client</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="oauth" status="optional" value="oauth">
            <p>
              OAuth refresh token —{" "}
              <code>{"{ clientId, clientSecret, refreshToken }"}</code>. Use
              this to write into an end-user's Drive (3-legged OAuth). The
              adapter mints fresh access tokens on demand.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="client" status="optional" value="client">
            <p>
              Pre-built <code>@googleapis/drive</code> v3 client — escape hatch
              when you've already wired auth (workload identity, ADC, custom
              auth flows). When passed, the adapter uses it directly. Note that{" "}
              <code>signedUploadUrl()</code> requires an auth handle to mint
              access tokens for the resumable session POST, so it throws when
              constructed via this path — there's no stable public surface to
              recover the auth back from a wrapped client. Pass{" "}
              <code>credentials</code> / <code>keyFilename</code> /{" "}
              <code>oauth</code> instead if you need direct uploads.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="subject" status="optional" value="subject">
            <p>
              Domain-wide delegation subject — the user the service account
              should impersonate. Only honored with <code>credentials</code> or{" "}
              <code>keyFilename</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="driveId" status="optional" value="driveId">
            <p>
              Shared Drive id. Strongly recommended for service-account auth —
              without one the adapter writes against the service account's
              personal 15 GB quota. When set, all queries scope to the Shared
              Drive (<code>corpora=drive</code>,{" "}
              <code>supportsAllDrives=true</code>).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="rootFolderId"
            status="optional"
            value="rootFolderId"
          >
            <p>
              Logical "bucket root" — virtual keys live under this folder.
              Defaults to <code>"root"</code> (My Drive root). When you've
              passed a <code>driveId</code>, set <code>rootFolderId</code> to
              the Shared Drive's root id (or a sub-folder id) so uploads land
              inside it instead of in the impersonated user's drive.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicByDefault"
            status="optional"
            value="publicByDefault"
          >
            <p>
              When <code>true</code>, <code>upload()</code> also creates an
              "anyone with link, reader" permission and <code>url()</code>{" "}
              returns the public Drive download URL. When <code>false</code>{" "}
              (default), <code>url()</code> throws — Drive has no signed URL
              primitive. Fixed at construction; need a mix? Use two adapters or
              grant permissions explicitly via <code>raw</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="fileIdCacheSize"
            status="optional"
            value="fileIdCacheSize"
          >
            <p>
              LRU capacity for the in-memory virtual-key → fileId cache. Drive
              has no native key field; every read after the first would
              otherwise round-trip a <code>files.list</code> to resolve the id,
              which the cache amortizes within a single adapter instance.
              Defaults to 1024.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-google-drive-limitations">
          Limitations
        </Heading>
        <p>
          <code>url()</code> throws unless the adapter is constructed with{" "}
          <code>publicByDefault: true</code> — Drive has no signed URL
          primitive. With <code>publicByDefault</code>, the returned URL is
          permanent (<code>expiresIn</code> is silently ignored) and{" "}
          <code>responseContentDisposition</code> always throws — Drive's
          download URL has no Content-Disposition override.{" "}
          <code>signedUploadUrl()</code> initiates a Drive resumable session and
          returns the session URL as a one-shot PUT; <code>maxSize</code> is
          forwarded as <code>X-Upload-Content-Length</code> (advisory, not
          server-side enforced) and <code>minSize</code> is ignored.{" "}
          <code>list()</code> scopes by parent folder and filters client-side to
          files that carry the adapter's <code>fsdkKey</code> — files written
          into the same folder out-of-band are excluded; <code>prefix</code>{" "}
          filtering is page-local and can under-return when the prefix isn't
          satisfied within a single page. Two files with the same virtual key
          (created out-of-band) make resolution throw <code>Conflict</code>{" "}
          rather than picking one silently. User <code>metadata</code> keys
          starting with <code>fsdk</code> are reserved (the adapter uses that
          prefix on <code>appProperties</code> for bookkeeping).
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-onedrive">
        OneDrive
      </Heading>
      <p>
        OneDrive and SharePoint document libraries via the official{" "}
        <code>@microsoft/microsoft-graph-client</code> SDK. Microsoft Graph is
        path-addressable (<code>/drive/root:/folder/file.txt</code>), so the
        adapter maps virtual keys onto real OneDrive paths — no virtual-key
        cache, no <code>fsdkKey</code> bookkeeping. Four auth shapes (app-only,
        OAuth refresh token, raw access token, pre-built Graph client) and four
        drive targets (<code>/me/drive</code>, <code>driveId</code>,{" "}
        <code>siteId</code>, <code>userId</code>) cover the personal-OneDrive,
        OneDrive-for-Business, and SharePoint-site-library cases.
      </p>
      <CodeBlock code={ONEDRIVE_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-onedrive-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem
            name="clientCredentials"
            status="optional"
            value="clientCredentials"
          >
            <p>
              App-only (client credentials) auth —{" "}
              <code>{"{ tenantId, clientId, clientSecret }"}</code>. Required
              for unattended SharePoint or OneDrive-for-Business access; the app
              acts on its own behalf. Cannot target <code>/me/drive</code> —
              pass <code>driveId</code>, <code>siteId</code>, or{" "}
              <code>userId</code> to specify the drive.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="oauth" status="optional" value="oauth">
            <p>
              Delegated (3-legged) auth via OAuth refresh token —{" "}
              <code>
                {"{ clientId, clientSecret, refreshToken, tenantId? }"}
              </code>
              . The adapter mints fresh access tokens against the tenant's token
              endpoint (<code>tenantId</code> defaults to <code>"common"</code>)
              and caches them until just before expiry.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessToken"
            status="optional"
            value="accessToken"
          >
            <p>
              Static or dynamic access token — a string for one-shot tokens, or
              an async function for callers minting tokens themselves (
              <code>@azure/identity</code>, NextAuth, custom brokers). The
              adapter does not cache; your callable owns refresh.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="client" status="optional" value="client">
            <p>
              Pre-built <code>@microsoft/microsoft-graph-client</code>{" "}
              <code>Client</code> — escape hatch when you've wired auth and
              middleware yourself. Unlike Google Drive's escape hatch,{" "}
              <code>signedUploadUrl()</code> still works because Graph's upload
              session URL is pre-authenticated by Graph itself, no auth handle
              required.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="driveId" status="optional" value="driveId">
            <p>
              Target a specific drive by id (<code>/drives/{"{driveId}"}</code>
              ). Works with any auth shape and is required for{" "}
              <code>clientCredentials</code> since <code>/me/drive</code> needs
              an interactive user. Mutually exclusive with <code>siteId</code> /{" "}
              <code>userId</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="siteId" status="optional" value="siteId">
            <p>
              Target the default document library of a SharePoint site (
              <code>/sites/{"{siteId}"}/drive</code>). Mutually exclusive with{" "}
              <code>driveId</code> / <code>userId</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="userId" status="optional" value="userId">
            <p>
              Target a specific user's drive (
              <code>/users/{"{userId}"}/drive</code>). Typical with app-only
              auth. Mutually exclusive with <code>driveId</code> /{" "}
              <code>siteId</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="rootFolderPath"
            status="optional"
            value="rootFolderPath"
          >
            <p>
              Logical "bucket root" — virtual keys live under this folder path
              (which must already exist on the drive). Defaults to the drive
              root.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicByDefault"
            status="optional"
            value="publicByDefault"
          >
            <p>
              When <code>true</code>, <code>upload()</code> also calls{" "}
              <code>createLink</code> with anonymous-view scope and{" "}
              <code>url()</code> returns the link's <code>webUrl</code>. When{" "}
              <code>false</code> (default), <code>url()</code> throws — Graph
              has no signed URL primitive. Anonymous links are blocked on
              tenants where admins disable them; the adapter surfaces Graph's{" "}
              <code>accessDenied</code> in that case.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="copyTimeoutMs"
            status="optional"
            value="copyTimeoutMs"
          >
            <p>
              Maximum time (ms) to wait for an async copy operation to complete.
              Graph returns 202 plus a monitor URL; the adapter polls until{" "}
              <code>status === "completed"</code> or this timeout elapses, at
              which point it throws <code>Provider</code>. Defaults to{" "}
              <code>60_000</code>.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-onedrive-limitations">
          Limitations
        </Heading>
        <p>
          <code>url()</code> throws unless the adapter is constructed with{" "}
          <code>publicByDefault: true</code> — Graph has no signed URL
          primitive. With <code>publicByDefault</code>, the returned share link
          has no expiry by Graph's default policy (<code>expiresIn</code> is
          silently ignored) and <code>responseContentDisposition</code> always
          throws — Graph has no Content-Disposition override.{" "}
          <code>signedUploadUrl()</code> initiates an upload session via{" "}
          <code>createUploadSession</code> and returns the session URL as a
          one-shot PUT; <code>maxSize</code> and <code>minSize</code> are
          advisory — Graph does not enforce a server-side{" "}
          <code>content-length-range</code> policy on upload sessions. Direct{" "}
          <code>upload()</code> is capped at OneDrive's 250 MB simple-upload
          limit; larger bodies must use <code>signedUploadUrl()</code> or drop
          to <code>raw</code> for chunked sessions. Drive items have no native
          arbitrary-metadata field, so user <code>metadata</code> and{" "}
          <code>cacheControl</code> on <code>upload()</code> throw — use{" "}
          <code>raw</code> to set Open Extensions if you need them.{" "}
          <code>copy()</code> is async on Graph (202 + monitor URL); the adapter
          polls the monitor and resolves when status is <code>"completed"</code>
          , with a configurable <code>copyTimeoutMs</code> ceiling.{" "}
          <code>list()</code> returns immediate-children files only at{" "}
          <code>rootFolderPath</code> — no recursion; subfolders are filtered
          out.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-dropbox">
        Dropbox
      </Heading>
      <p>
        Dropbox via the official <code>dropbox</code> SDK. Path-addressable like
        OneDrive (<code>/folder/file.txt</code>), so virtual keys map directly
        to Dropbox paths — no virtual-key cache, no bookkeeping. Four auth
        shapes (pre-built client, static or dynamic access token, OAuth refresh
        token + app key, or env-var fallback) cover personal Dropbox, Dropbox
        Business, and team-space deployments.
      </p>
      <CodeBlock code={DROPBOX_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-dropbox-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="client" status="optional" value="client">
            <p>
              Pre-built <code>Dropbox</code> client — escape hatch for callers
              that already wire auth themselves (team-space{" "}
              <code>pathRoot</code>, custom headers, shared{" "}
              <code>DropboxAuth</code>). When passed, the adapter delegates auth
              entirely to the SDK; the other auth options are ignored.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accessToken"
            status="optional"
            value="accessToken"
          >
            <p>
              Static or dynamic access token — a string for one-shot tokens, or
              an async function for callers minting tokens themselves. The
              adapter does not cache the result of a callable; your callable
              owns refresh.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="refreshToken"
            status="optional"
            value="refreshToken"
          >
            <p>
              OAuth2 refresh token. Requires <code>appKey</code> (your app's
              client_id); pass <code>appSecret</code> as well for confidential
              clients. The adapter exchanges the refresh token at{" "}
              <code>api.dropboxapi.com/oauth2/token</code> and caches the access
              token until ~60s before expiry.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="appKey" status="optional" value="appKey">
            <p>
              Dropbox app key (<code>client_id</code>). Required when{" "}
              <code>refreshToken</code> is set.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="appSecret"
            status="optional"
            value="appSecret"
          >
            <p>
              Dropbox app secret (<code>client_secret</code>). Required for
              confidential (server-side) clients; omit for PKCE-only public
              clients.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="rootFolderPath"
            status="optional"
            value="rootFolderPath"
          >
            <p>
              Logical "bucket root" — virtual keys live under this folder path
              on the Dropbox account (which must already exist; the adapter does
              not create folders). Defaults to the account root.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicByDefault"
            status="optional"
            value="publicByDefault"
          >
            <p>
              When <code>true</code>, <code>upload()</code> also calls{" "}
              <code>sharingCreateSharedLinkWithSettings</code> with{" "}
              <code>requested_visibility: "public"</code> and <code>url()</code>{" "}
              returns that link's URL (rewritten to <code>?dl=1</code> for
              direct download). When <code>false</code> (default),{" "}
              <code>url()</code> mints a 4-hour temporary link via{" "}
              <code>filesGetTemporaryLink</code>. Public shared links may be
              restricted on Dropbox Business teams; the adapter surfaces
              Dropbox's <code>access_denied</code> error in that case.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
              signing and shared-link creation. Useful when a CDN sits in front
              of pre-shared Dropbox links.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the temporary download links
              returned by <code>url()</code> when neither{" "}
              <code>publicByDefault</code> nor <code>publicBaseUrl</code> is
              set. Capped at <code>14_400</code> (4 hours, the Dropbox maximum).
              Defaults to <code>3600</code>.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-dropbox-limitations">
          Limitations
        </Heading>
        <p>
          <code>signedUploadUrl()</code> throws — Dropbox's{" "}
          <code>filesGetTemporaryUploadLink</code> returns a URL that expects
          POST with a raw body, which fits neither the SDK's PUT-with-headers
          nor POST-with-form-fields shape. Use <code>upload()</code> or drop to{" "}
          <code>raw.filesGetTemporaryUploadLink(...)</code> for client-side
          uploads. Direct <code>upload()</code> handles up to Dropbox's 150 MB
          single-call limit; larger bodies switch to{" "}
          <code>filesUploadSession*</code> (chunked, up to 350 GB).{" "}
          <code>url()</code> is capped at Dropbox's 4-hour temporary-link
          maximum — <code>expiresIn</code> above 14400 throws; use{" "}
          <code>publicByDefault: true</code> for permanent shared links.{" "}
          <code>responseContentDisposition</code> always throws — Dropbox
          temporary and shared links have no Content-Disposition override. User{" "}
          <code>metadata</code> and <code>cacheControl</code> on{" "}
          <code>upload()</code> throw — Dropbox files have no native
          arbitrary-metadata field; use <code>raw</code> with{" "}
          <code>property_groups</code> (requires a registered template) if you
          need it. Stream-mode <code>download()</code> fetches the temporary
          link rather than streaming through the SDK, since{" "}
          <code>filesDownload</code> buffers the full body.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-box">
        Box
      </Heading>
      <p>
        Box via the official <code>box-typescript-sdk-gen</code> SDK. Box files
        live by ID, not by path, so the adapter walks <code>rootFolderId</code>{" "}
        and translates virtual keys (<code>docs/a.txt</code>) into nested Box
        subfolders, auto-creating intermediate folders on <code>upload()</code>.
        Five auth shapes (pre-built client, developer token, OAuth
        refresh-token, Client Credentials Grant, JWT server auth) cover scripts,
        user apps, and enterprise installs — token lifecycle is handled by the
        SDK's built-in <code>Authentication</code> classes.
      </p>
      <CodeBlock code={BOX_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-box-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="client" status="optional" value="box-client">
            <p>
              Pre-built <code>BoxClient</code> — escape hatch for callers that
              already wire auth themselves (custom <code>NetworkSession</code>,
              proxy config, downscoped tokens). When passed, the adapter
              delegates auth entirely to the SDK; the other auth options are
              ignored.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="developerToken"
            status="optional"
            value="developerToken"
          >
            <p>
              Static developer token from the Box developer console. Useful for
              scripts and trying the adapter; production apps should use OAuth,
              CCG, or JWT instead. Falls back to the{" "}
              <code>BOX_DEVELOPER_TOKEN</code> environment variable.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="oauth" status="optional" value="box-oauth">
            <p>
              OAuth2 user-app flow. Pass <code>clientId</code>,{" "}
              <code>clientSecret</code>, and a long-lived{" "}
              <code>refreshToken</code> obtained from the authorization-code
              flow. The adapter seeds the SDK's in-memory token storage with the
              refresh token; the SDK exchanges it for a fresh access token on
              the first API call and re-refreshes when the access token expires.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="ccg" status="optional" value="box-ccg">
            <p>
              Client Credentials Grant — server-side enterprise auth. Pass{" "}
              <code>clientId</code>, <code>clientSecret</code>, and either{" "}
              <code>enterpriseId</code> (authenticate as the service account) or{" "}
              <code>userId</code> (authenticate as a managed/app user). At least
              one of the two is required.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="jwt" status="optional" value="box-jwt">
            <p>
              JWT Server Authentication, configured via Box's developer-console
              JSON blob. Pass either <code>configJsonString</code> (the JSON
              text) or <code>configFilePath</code> (path to the file on disk).
              The SDK handles RSA key decryption and assertion signing.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="rootFolderId"
            status="optional"
            value="rootFolderId"
          >
            <p>
              Logical "bucket root" — virtual keys live under this Box folder
              ID. The folder must already exist; intermediate subfolders are
              auto-created on <code>upload()</code>. Defaults to{" "}
              <code>"0"</code> (the user's root folder).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicByDefault"
            status="optional"
            value="box-publicByDefault"
          >
            <p>
              When <code>true</code>, <code>upload()</code> also calls{" "}
              <code>addShareLinkToFile</code> with <code>access: "open"</code>{" "}
              and <code>url()</code> returns that link's{" "}
              <code>download_url</code> (or <code>url</code> if{" "}
              <code>download_url</code> is absent — typical for non-binary
              previews). When <code>false</code> (default), <code>url()</code>{" "}
              mints a short-lived signed download URL via{" "}
              <code>getDownloadFileUrl</code>. Public shared links may be
              restricted on Box Business or Enterprise plans; the adapter
              surfaces Box's <code>access_denied_insufficient_permissions</code>{" "}
              error in that case.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="box-publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
              signing and shared-link resolution. Useful when a CDN or vanity
              domain sits in front of pre-shared Box links.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="box-defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, accepted by <code>url()</code> when
              minting a signed download URL. Box controls the URL's TTL
              server-side, so this value is accepted for API symmetry but the
              actual lifetime is whatever Box returns. Defaults to{" "}
              <code>3600</code>.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-box-limitations">
          Limitations
        </Heading>
        <p>
          <code>signedUploadUrl()</code> throws — Box uploads require a
          multipart POST with both an <code>attributes</code> JSON part and the
          file bytes part, which fits neither the SDK's PUT-with-headers nor
          POST-with-form-fields shape. Use <code>upload()</code> server-side, or
          Box's UI Elements / Content Uploader for browser flows. Direct{" "}
          <code>upload()</code> handles up to Box's 50 MB single-call limit;
          larger bodies switch to <code>chunkedUploads.uploadBigFile</code>.
          Stream bodies are buffered up-front because the SDK's upload manager
          takes a Node <code>Readable</code> rather than a Web stream.{" "}
          <code>list()</code> returns immediate-children files only at{" "}
          <code>rootFolderId</code> — no recursion, subfolders are filtered out,
          and <code>prefix</code> is matched client-side within the page; for
          deep enumeration drop to <code>raw.folders.getFolderItems</code> and
          recurse manually. <code>responseContentDisposition</code> always
          throws — Box's <code>getDownloadFileUrl</code> and shared-link URLs
          have no Content-Disposition override. User <code>metadata</code> and{" "}
          <code>cacheControl</code> on <code>upload()</code> throw — Box exposes
          file metadata via classifications and metadata templates; drop to{" "}
          <code>raw.fileMetadata.*</code> if you need it. Box doesn't store
          user-supplied content types on file content, so <code>head()</code>{" "}
          and <code>list()</code> return a type inferred from the filename
          extension.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-azure">
        Azure Blob Storage
      </Heading>
      <p>
        Azure Blob Storage via the official <code>@azure/storage-blob</code>{" "}
        SDK. Four credential modes: connection string, account name + account
        key, account name + SAS token, or anonymous (public-read containers
        only). Connection-string parsing recovers the account name + key so
        signing methods keep working.
      </p>
      <CodeBlock code={AZURE_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-azure-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem
            name="container"
            status="required"
            value="container"
          >
            <p>
              Azure container name. Surfaced as <code>adapter.bucket</code> for
              cross-adapter API consistency, even though Azure's own term is
              "container".
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="connectionString"
            status="optional"
            value="connectionString"
          >
            <p>
              Full Azure Storage connection string (
              <code>
                DefaultEndpointsProtocol=...;AccountName=...;AccountKey=...
              </code>
              ). Highest-precedence credential. Falls back to{" "}
              <code>AZURE_STORAGE_CONNECTION_STRING</code>. The adapter parses
              out the account name + key so signing methods keep working.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accountName"
            status="optional"
            value="accountName"
          >
            <p>
              Storage account name (e.g. <code>mystorageaccount</code>). Used
              with <code>accountKey</code>, <code>sasToken</code>, or
              anonymously. Falls back to <code>AZURE_STORAGE_ACCOUNT_NAME</code>{" "}
              then <code>AZURE_STORAGE_ACCOUNT</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="accountKey"
            status="optional"
            value="accountKey"
          >
            <p>
              Shared-key (account key) for signing. Falls back to{" "}
              <code>AZURE_STORAGE_ACCOUNT_KEY</code> then{" "}
              <code>AZURE_STORAGE_KEY</code>. Required if you want{" "}
              <code>url()</code> or <code>signedUploadUrl()</code> to mint new
              SAS tokens — without it those methods throw.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="sasToken" status="optional" value="sasToken">
            <p>
              Pre-issued SAS token, with or without the leading <code>?</code>.
              Without an account key the signing methods throw —
              reads/writes/listing still work as long as the SAS grants those
              permissions.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="endpoint" status="optional" value="endpoint">
            <p>
              Override the service endpoint host. Defaults to{" "}
              <code>https://&lt;accountName&gt;.blob.core.windows.net</code>.
              Override for Azurite (
              <code>http://127.0.0.1:10000/devstoreaccount1</code>) or sovereign
              clouds (US Government, China).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
              Use for a public-access container or a CDN (
              <code>*.azureedge.net</code>) in front of the account. When unset,{" "}
              <code>url()</code> returns a SAS read URL (1-hour default).
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-azure-limitations">
          Limitations
        </Heading>
        <p>
          <code>signedUploadUrl()</code> issues PUT-only — Azure SAS has no
          POST-policy equivalent. <code>maxSize</code> throws because Azure
          can't enforce upload caps at the URL level; enforce them at your
          application gateway. <code>copy()</code> uses{" "}
          <code>syncCopyFromURL</code>, which caps at 256 MB source size; larger
          blobs need <code>beginCopyFromURL</code> via <code>adapter.raw</code>.{" "}
          <code>@azure/identity</code> / Managed Identity is not supported in v1
          — drop down to <code>adapter.raw</code> or wait for a future{" "}
          <code>client</code> option.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-supabase">
        Supabase Storage
      </Heading>
      <p>
        Supabase Storage via the official <code>@supabase/storage-js</code> SDK.
        Auto-loads the project URL and an API key from the standard env vars;
        pass <code>client</code> to share an existing{" "}
        <code>SupabaseClient</code> with the rest of your app (auth, postgrest).
      </p>
      <CodeBlock code={SUPABASE_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-supabase-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="bucket" status="required" value="bucket">
            <p>
              Supabase storage bucket. Must already exist — this SDK does not
              create buckets.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="client" status="optional" value="client">
            <p>
              Existing client to share with the rest of your app (auth,
              postgrest). Highest-precedence credential. Pass either a{" "}
              <code>StorageClient</code> from <code>@supabase/storage-js</code>{" "}
              or a <code>SupabaseClient</code> from{" "}
              <code>@supabase/supabase-js</code> — the adapter unwraps{" "}
              <code>client.storage</code> automatically.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="url" status="required" value="url">
            <p>
              Supabase project URL, e.g. <code>https://xxxx.supabase.co</code>.
              The adapter appends <code>/storage/v1</code> automatically. Falls
              back to <code>SUPABASE_URL</code> then{" "}
              <code>NEXT_PUBLIC_SUPABASE_URL</code>. Required unless{" "}
              <code>client</code> is passed.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="key" status="required" value="key">
            <p>
              Supabase API key. The service role key is required for writes on
              RLS-protected buckets; the anon key works for public buckets.
              Falls back to <code>SUPABASE_SERVICE_ROLE_KEY</code>,{" "}
              <code>SUPABASE_KEY</code>, then{" "}
              <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Required unless{" "}
              <code>client</code> is passed.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="public" status="optional" value="public">
            <p>
              Treat the bucket as public. When <code>true</code>,{" "}
              <code>url()</code> returns the permanent unsigned{" "}
              <code>getPublicUrl()</code> result instead of minting a signed
              read URL. Supabase has no API to detect bucket visibility, so the
              adapter trusts what you pass — a wrong value yields a 4xx on
              fetch.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="publicBaseUrl"
            status="optional"
            value="publicBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
              signing and <code>getPublicUrl()</code>. Use for a CDN in front of
              the project. Implies <code>public: true</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the signed read URLs returned by{" "}
              <code>url()</code> when neither <code>public</code> nor{" "}
              <code>publicBaseUrl</code> is set. Defaults to 3600 (1 hour).
              Per-call <code>url(key, {"{ expiresIn }"})</code> overrides.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-supabase-limitations">
          Limitations
        </Heading>
        <p>
          <code>signedUploadUrl()</code> issues PUT-only. <code>maxSize</code>{" "}
          throws — Supabase signed upload URLs have no{" "}
          <code>content-length-range</code> equivalent; set the bucket-level
          file size limit in the Supabase dashboard or enforce caps at your
          application gateway. <code>expiresIn</code> on{" "}
          <code>signedUploadUrl()</code> is ignored — Supabase fixes the TTL at
          2 hours server-side. <code>list()</code> uses Supabase's V1
          offset/limit API; the adapter encodes <code>offset</code> as a numeric
          cursor string so it threads through the unified API.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-uploadthing">
        UploadThing
      </Heading>
      <p>
        UploadThing via the official <code>uploadthing/server</code> SDK.
        UploadThing generates its own internal file keys, so the adapter maps
        the user-supplied key onto UploadThing's <code>customId</code> with{" "}
        <code>defaultKeyType: "customId"</code> — every subsequent operation
        routes by your key, not the auto-generated one.
      </p>
      <CodeBlock code={UPLOADTHING_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-uploadthing-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="token" status="optional" value="token">
            <p>
              UploadThing token (base64 JSON of{" "}
              <code>{"{ apiKey, appId, regions }"}</code>). Falls back to{" "}
              <code>UPLOADTHING_TOKEN</code>; the adapter throws at construction
              if neither is set, or if the token doesn't decode to that shape —
              so misconfiguration surfaces immediately rather than on the first
              call.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="acl" status="optional" value="acl">
            <p>
              <code>"public-read"</code> (default) or <code>"private"</code>.
              Drives both the upload-time ACL and <code>url()</code> behavior —{" "}
              <code>public-read</code> returns the permanent CDN URL,{" "}
              <code>private</code> mints a short-lived signed URL via{" "}
              <code>generateSignedURL</code>. Fixed at construction, so a single{" "}
              <code>Files</code> instance is unambiguously one or the other.
              Need both? Use two adapters.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="slug" status="optional" value="slug">
            <p>
              UploadThing file-router slug. Required only by{" "}
              <code>signedUploadUrl()</code>, which embeds it as{" "}
              <code>x-ut-slug</code> on the ingest URL — UploadThing validates
              the upload against the route's config (allowed file types and
              sizes). Server-side <code>upload()</code> doesn't need it.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, for the signed read URLs returned by{" "}
              <code>url()</code> when <code>acl: "private"</code>. Defaults to
              3600 (1 hour); UploadThing caps signed URLs at 7 days. Per-call{" "}
              <code>url(key, {"{ expiresIn }"})</code> overrides.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="region" status="optional" value="region">
            <p>
              Override the region alias used to construct the ingest URL for{" "}
              <code>signedUploadUrl()</code> (e.g. <code>fra1</code>,{" "}
              <code>sea1</code>). Defaults to the first region in the decoded
              token, falling back to <code>sea1</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="downloadTimeoutMs"
            status="optional"
            value="downloadTimeoutMs"
          >
            <p>
              Timeout in milliseconds for the HEAD/GET fallbacks issued by{" "}
              <code>head()</code>, <code>download()</code>, and lazy bodies
              returned from <code>list()</code>. Defaults to 5 minutes; pass{" "}
              <code>0</code> to disable. A hung CDN response would otherwise
              leak a fetch that never resolves.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-uploadthing-limitations">
          Limitations
        </Heading>
        <p>
          <code>copy()</code> is a read-then-write — UploadThing has no
          server-side copy primitive, so the source is downloaded and
          re-uploaded; not atomic and pays both an egress and an ingest cost.{" "}
          <code>head()</code> falls back to a HEAD request against the resolved
          file URL because UploadThing has no metadata endpoint — fields come
          from response headers, and user <code>metadata</code> isn't supported
          by the underlying API. <code>list()</code> uses UploadThing's
          offset/limit API; the adapter encodes <code>offset</code> as a numeric
          cursor string, and <code>prefix</code> is filtered client-side over
          each page (it can under-return when the prefix isn't satisfied within
          a single page). <code>signedUploadUrl()</code> issues PUT URLs against
          the UFS ingest endpoint — <code>maxSize</code> is advisory
          (UploadThing enforces caps via the file-router config tied to{" "}
          <code>slug</code>, not via the URL signature) and <code>minSize</code>{" "}
          is ignored. <code>url()</code> throws on{" "}
          <code>responseContentDisposition</code> — UploadThing has no
          Content-Disposition override on signed or CDN URLs.
        </p>
      </div>
    </section>

    <section>
      <Heading as="h3" id="adapter-fs">
        Filesystem
      </Heading>
      <p>
        Local filesystem. The dev/test adapter — point it at a directory and it
        implements the same <code>Adapter</code> contract as the cloud adapters
        using <code>node:fs/promises</code>. Each upload writes the body and a
        sidecar <code>.meta.json</code> file alongside it (Content-Type, ETag,
        user metadata) so reads round-trip cleanly. Not for production: there's
        no replication, no signing, no auth.
      </p>
      <CodeBlock code={FS_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-fs-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="root" status="required" value="root">
            <p>
              Directory the adapter manages. Absolute or relative; created on
              first upload. All operations are scoped to this directory — keys
              that resolve outside it (e.g. <code>../etc/passwd</code>) throw{" "}
              <code>Provider</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="urlBaseUrl"
            status="optional"
            value="urlBaseUrl"
          >
            <p>
              Origin used to build URLs from <code>url()</code>. When set,{" "}
              <code>url(key)</code> returns{" "}
              <code>{`\`\${urlBaseUrl}/\${key}\``}</code> — useful when a dev
              server (Next.js <code>/public</code> mount,{" "}
              <code>serve-static</code>, etc.) is exposing the same{" "}
              <code>root</code>. When unset, <code>url()</code> returns a{" "}
              <code>file://</code> URL — fine for CLIs/tests, not browsers.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="defaultUrlExpiresIn"
            status="optional"
            value="defaultUrlExpiresIn"
          >
            <p>
              Default expiry, in seconds, threaded into the{" "}
              <code>?expires=</code> query string of{" "}
              <code>signedUploadUrl()</code> for parity with the cloud adapters.
              Defaults to 3600. The fs adapter does not enforce expiry itself; a
              dev upload-handler can validate the param.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-fs-storage-layout">
          Storage layout
        </Heading>
        <p>
          Body at <code>{`\${root}/\${key}`}</code>; sidecar at{" "}
          <code>{`\${root}/\${key}.meta.json`}</code>. Sidecars survive{" "}
          <code>cp -r</code> / <code>git mv</code> / partial-tree deletion.{" "}
          <code>list()</code> hides them. ETag is a SHA-1-derived stable hash
          computed at upload time.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="adapter-fs-limitations">
          Limitations
        </Heading>
        <p>
          <code>signedUploadUrl()</code> throws without <code>urlBaseUrl</code>—
          there's no upload server to sign against. <code>url()</code> throws on{" "}
          <code>responseContentDisposition</code> without{" "}
          <code>urlBaseUrl</code>: <code>file://</code> has no signature in
          which to bind the override. Files written by hand into{" "}
          <code>root</code> without a sidecar are still readable —{" "}
          <code>contentType</code> falls back to{" "}
          <code>application/octet-stream</code> and <code>etag</code> is absent.
        </p>
      </div>
    </section>
  </section>
);
