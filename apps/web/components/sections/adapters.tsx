import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

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
// (intra-Worker, no egress fees). The HTTP credentials let url() /
// signedUrl() / signedUploadUrl() sign presigned URLs the binding alone
// can't produce.
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
          <AccordionItem className="border-dotted" value="bucket">
            <AccordionTrigger>
              <code>bucket</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>required.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="region">
            <AccordionTrigger>
              <code>region</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. Falls back to <code>AWS_REGION</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="credentials">
            <AccordionTrigger>
              <code>credentials</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional.{" "}
                <code>{"{ accessKeyId, secretAccessKey, sessionToken? }"}</code>
                .
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="endpoint">
            <AccordionTrigger>
              <code>endpoint</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>optional. Override for S3-compatible services.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="publicBaseUrl">
            <AccordionTrigger>
              <code>publicBaseUrl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. When set, <code>url()</code> returns{" "}
                <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing
                — use this if your bucket is fronted by CloudFront or has a
                public-read policy. When unset, <code>url()</code> returns a
                presigned GetObject (1-hour default).
              </p>
            </AccordionContent>
          </AccordionItem>
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
        extra round trip); <code>url()</code>, <code>signedUrl()</code>, and{" "}
        <code>signedUploadUrl()</code> route through the HTTP signer because a
        Worker binding has no signing primitive. The S3 client is lazy-loaded —
        bindings-only Workers don't pull <code>@aws-sdk/client-s3</code> into
        their bundle.
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
      <p>
        <span className="text-foreground">Limitations.</span>{" "}
        <code>signedUrl</code> and <code>signedUploadUrl</code> both throw —
        public blob URLs don't expire, private blobs require an authenticated
        SDK call, and browser uploads go through <code>handleUpload()</code>{" "}
        from <code>@vercel/blob/client</code> instead of presigned URLs. User{" "}
        <code>metadata</code> isn't supported by the underlying API, so it
        round-trips as <code>undefined</code>.
      </p>
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
          <AccordionItem className="border-dotted" value="bucket">
            <AccordionTrigger>
              <code>bucket</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>required.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="endpoint">
            <AccordionTrigger>
              <code>endpoint</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                required. The MinIO server URL, e.g.{" "}
                <code>http://localhost:9000</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="accessKeyId">
            <AccordionTrigger>
              <code>accessKeyId</code> / <code>secretAccessKey</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>required, falling back to the matching env vars.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="region">
            <AccordionTrigger>
              <code>region</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. Defaults to <code>us-east-1</code>; SigV4 requires
                some region but MinIO ignores it for routing.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="forcePathStyle">
            <AccordionTrigger>
              <code>forcePathStyle</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. Defaults to <code>true</code>; flip off only if you've
                set up per-bucket subdomain routing.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="publicBaseUrl">
            <AccordionTrigger>
              <code>publicBaseUrl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. When set, <code>url()</code> returns{" "}
                <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips
                signing. Use this if you've fronted MinIO with a CDN or set a
                public bucket policy. When unset, <code>url()</code> returns a
                presigned GetObject (1-hour default).
              </p>
            </AccordionContent>
          </AccordionItem>
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
          <AccordionItem className="border-dotted" value="bucket">
            <AccordionTrigger>
              <code>bucket</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>required.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="projectId">
            <AccordionTrigger>
              <code>projectId</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. Falls back to <code>GOOGLE_CLOUD_PROJECT</code> then{" "}
                <code>GCLOUD_PROJECT</code>. ADC carries a project ID, so this
                is rarely needed.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="keyFilename">
            <AccordionTrigger>
              <code>keyFilename</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. Path to a service-account JSON file. Use this when ADC
                isn't available.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="credentials">
            <AccordionTrigger>
              <code>credentials</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. <code>{"{ client_email, private_key }"}</code>. Useful
                when you only have those fields as separate env vars and don't
                want to materialize a JSON file. <code>url()</code> and{" "}
                <code>signedUploadUrl()</code> need either inline credentials or
                the <code>iam.serviceAccounts.signBlob</code> permission on the
                runtime service account so the SDK can fall back to IAM
                SignBlob.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="publicBaseUrl">
            <AccordionTrigger>
              <code>publicBaseUrl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. When set, <code>url()</code> returns{" "}
                <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips
                signing. For a public GCS bucket the natural value is{" "}
                <code>https://storage.googleapis.com/&lt;bucket&gt;</code>; or
                point at a Cloud CDN / load balancer host. When unset,{" "}
                <code>url()</code> returns a V4 signed read URL (1-hour default;
                GCS caps V4 at 7 days).
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
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
          <AccordionItem className="border-dotted" value="container">
            <AccordionTrigger>
              <code>container</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                required. Surfaced as <code>adapter.bucket</code> for
                cross-adapter API consistency, even though Azure's term is
                "container".
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="connectionString">
            <AccordionTrigger>
              <code>connectionString</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                highest precedence. Falls back to{" "}
                <code>AZURE_STORAGE_CONNECTION_STRING</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="accountName">
            <AccordionTrigger>
              <code>accountName</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                falls back to <code>AZURE_STORAGE_ACCOUNT_NAME</code> then{" "}
                <code>AZURE_STORAGE_ACCOUNT</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="accountKey">
            <AccordionTrigger>
              <code>accountKey</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                falls back to <code>AZURE_STORAGE_ACCOUNT_KEY</code> then{" "}
                <code>AZURE_STORAGE_KEY</code>. Required if you want{" "}
                <code>url()</code> or <code>signedUploadUrl()</code> to mint new
                SAS tokens.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="sasToken">
            <AccordionTrigger>
              <code>sasToken</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                pre-issued SAS, with or without leading <code>?</code>. Without
                an account key the signing methods throw — reads/writes still
                work as long as the SAS grants those permissions.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="endpoint">
            <AccordionTrigger>
              <code>endpoint</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. Defaults to{" "}
                <code>https://&lt;accountName&gt;.blob.core.windows.net</code>.
                Override for Azurite (local emulator) or sovereign clouds (US
                Government, China).
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="publicBaseUrl">
            <AccordionTrigger>
              <code>publicBaseUrl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. When set, <code>url()</code> returns{" "}
                <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips
                signing. Use for a public-access container or a CDN (
                <code>*.azureedge.net</code>) in front of the account. When
                unset, <code>url()</code> returns a SAS read URL (1-hour
                default).
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="limitations">
            <AccordionTrigger>Limitations</AccordionTrigger>
            <AccordionContent>
              <p>
                <code>signedUploadUrl()</code> issues PUT-only — Azure SAS has
                no POST-policy equivalent. <code>maxSize</code> throws because
                Azure can't enforce upload caps at the URL level; enforce them
                at your application gateway. <code>copy()</code> uses{" "}
                <code>syncCopyFromURL</code>, which caps at 256 MB source size;
                larger blobs need <code>beginCopyFromURL</code> via{" "}
                <code>adapter.raw</code>. <code>@azure/identity</code> / Managed
                Identity is not supported in v1 — drop down to{" "}
                <code>adapter.raw</code> or wait for a future{" "}
                <code>client</code> option.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
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
          <AccordionItem className="border-dotted" value="bucket">
            <AccordionTrigger>
              <code>bucket</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                required. Must already exist (this SDK does not create buckets).
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="client">
            <AccordionTrigger>
              <code>client</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional, highest precedence. Either a{" "}
                <code>StorageClient</code> from{" "}
                <code>@supabase/storage-js</code> or a{" "}
                <code>SupabaseClient</code> from{" "}
                <code>@supabase/supabase-js</code> — the adapter unwraps{" "}
                <code>client.storage</code> automatically.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="url">
            <AccordionTrigger>
              <code>url</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                Supabase project URL, e.g. <code>https://xxxx.supabase.co</code>
                . The adapter appends <code>/storage/v1</code>. Falls back to{" "}
                <code>SUPABASE_URL</code> then{" "}
                <code>NEXT_PUBLIC_SUPABASE_URL</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="key">
            <AccordionTrigger>
              <code>key</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                API key. The service role key is required for writes on
                RLS-protected buckets; the anon key works for public buckets.
                Falls back to <code>SUPABASE_SERVICE_ROLE_KEY</code>,{" "}
                <code>SUPABASE_KEY</code>, then{" "}
                <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="public">
            <AccordionTrigger>
              <code>public</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                boolean, optional. Set to <code>true</code> for a public bucket
                so <code>url()</code> returns the permanent unsigned{" "}
                <code>getPublicUrl()</code> result instead of minting a signed
                read URL. Supabase has no API to detect bucket visibility, so
                the adapter trusts what you pass — a wrong value yields a 4xx on
                fetch.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="publicBaseUrl">
            <AccordionTrigger>
              <code>publicBaseUrl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. When set, <code>url()</code> returns{" "}
                <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
                signing and <code>getPublicUrl()</code>. Use for a CDN in front
                of the project. Implies <code>public: true</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="defaultUrlExpiresIn">
            <AccordionTrigger>
              <code>defaultUrlExpiresIn</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                number of seconds, optional. Default expiry for signed read URLs
                returned by <code>url()</code>. Defaults to 3600.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="limitations">
            <AccordionTrigger>Limitations</AccordionTrigger>
            <AccordionContent>
              <p>
                <code>signedUploadUrl()</code> issues PUT-only.{" "}
                <code>maxSize</code> throws — Supabase signed upload URLs have
                no <code>content-length-range</code> equivalent; set the
                bucket-level file size limit in the Supabase dashboard or
                enforce caps at your application gateway. <code>expiresIn</code>{" "}
                on <code>signedUploadUrl()</code> is ignored — Supabase fixes
                the TTL at 2 hours server-side. <code>list()</code> uses
                Supabase's V1 offset/limit API; the adapter encodes{" "}
                <code>offset</code> as a numeric cursor string so it threads
                through the unified API.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
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
          <AccordionItem className="border-dotted" value="root">
            <AccordionTrigger>
              <code>root</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                required. Absolute or relative directory the adapter manages.
                Created on first upload. All operations are scoped to this
                directory; keys that resolve outside it (e.g.{" "}
                <code>../etc/passwd</code>) throw <code>Provider</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="urlBaseUrl">
            <AccordionTrigger>
              <code>urlBaseUrl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                optional. When set, <code>url(key)</code> returns{" "}
                <code>{`\`\${urlBaseUrl}/\${key}\``}</code> — useful when a dev
                server (Next.js <code>/public</code> mount,{" "}
                <code>serve-static</code>, etc.) is exposing the same{" "}
                <code>root</code>. When unset, <code>url()</code> returns a{" "}
                <code>file://</code> URL — fine for CLIs/tests, not browsers.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="defaultUrlExpiresIn">
            <AccordionTrigger>
              <code>defaultUrlExpiresIn</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                number of seconds, optional. Threaded into the{" "}
                <code>?expires=</code> query string of{" "}
                <code>signedUploadUrl()</code> for parity with the cloud
                adapters. Defaults to 3600. The fs adapter does not enforce
                expiry itself; a dev upload-handler can validate the param.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="storageLayout">
            <AccordionTrigger>Storage layout</AccordionTrigger>
            <AccordionContent>
              <p>
                Body at <code>{`\${root}/\${key}`}</code>; sidecar at{" "}
                <code>{`\${root}/\${key}.meta.json`}</code>. Sidecars survive{" "}
                <code>cp -r</code> / <code>git mv</code> / partial-tree
                deletion. <code>list()</code> hides them. ETag is a
                SHA-1-derived stable hash computed at upload time.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="limitations">
            <AccordionTrigger>Limitations</AccordionTrigger>
            <AccordionContent>
              <p>
                <code>signedUploadUrl()</code> throws without{" "}
                <code>urlBaseUrl</code> — there's no upload server to sign
                against. <code>url()</code> throws on{" "}
                <code>responseContentDisposition</code> without{" "}
                <code>urlBaseUrl</code>: <code>file://</code> has no signature
                in which to bind the override. Files written by hand into{" "}
                <code>root</code> without a sidecar are still readable —{" "}
                <code>contentType</code> falls back to{" "}
                <code>application/octet-stream</code> and <code>etag</code> is
                absent.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>
  </section>
);
