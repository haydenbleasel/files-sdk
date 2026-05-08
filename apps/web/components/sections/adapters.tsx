import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

    <Tabs defaultValue="s3">
      <TabsList>
        <TabsTrigger value="s3">S3</TabsTrigger>
        <TabsTrigger value="r2">R2</TabsTrigger>
        <TabsTrigger value="vercel-blob">Vercel Blob</TabsTrigger>
        <TabsTrigger value="minio">MinIO</TabsTrigger>
      </TabsList>

      <TabsContent className="flex flex-col gap-4" value="s3">
        <p>
          AWS S3 (and any S3-compatible bucket). Uses the standard AWS
          credential chain — environment, IAM role, shared profile.
        </p>
        <CodeBlock code={S3_EXAMPLE} lang="ts" />
        <ul>
          <li>
            <code>bucket</code> — required.
          </li>
          <li>
            <code>region</code> — optional. Falls back to{" "}
            <code>AWS_REGION</code>.
          </li>
          <li>
            <code>credentials</code> — optional.{" "}
            <code>{"{ accessKeyId, secretAccessKey, sessionToken? }"}</code>.
          </li>
          <li>
            <code>endpoint</code> — optional. Override for S3-compatible
            services.
          </li>
          <li>
            <code>publicBaseUrl</code> — optional. When set, <code>url()</code>{" "}
            returns <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips
            signing — use this if your bucket is fronted by CloudFront or has a
            public-read policy. When unset, <code>url()</code> returns a
            presigned GetObject (1-hour default).
          </li>
        </ul>
      </TabsContent>

      <TabsContent className="flex flex-col gap-4" value="r2">
        <p>
          Cloudflare R2 over the S3-compatible HTTP API. Auto-loads from{" "}
          <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>,{" "}
          <code>R2_SECRET_ACCESS_KEY</code>. Inside Cloudflare Workers you can
          pass an <code>R2Bucket</code> binding directly instead.
        </p>
        <CodeBlock code={R2_EXAMPLE} lang="ts" />
        <p>
          <code>publicBaseUrl</code> — optional, an <code>r2.dev</code>{" "}
          subdomain or custom domain bound to the bucket. When set,{" "}
          <code>url()</code> returns{" "}
          <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
        </p>
        <Heading as="h4">Hybrid: binding + HTTP credentials</Heading>
        <p>
          Inside a Worker, you can pass <em>both</em> a binding and HTTP
          credentials. Reads and writes go through the binding (no egress, no
          extra round trip); <code>url()</code>, <code>signedUrl()</code>, and{" "}
          <code>signedUploadUrl()</code> route through the HTTP signer because a
          Worker binding has no signing primitive. The S3 client is lazy-loaded
          — bindings-only Workers don't pull <code>@aws-sdk/client-s3</code>{" "}
          into their bundle.
        </p>
        <CodeBlock code={R2_HYBRID_EXAMPLE} lang="ts" />
      </TabsContent>

      <TabsContent className="flex flex-col gap-4" value="vercel-blob">
        <p>
          Vercel Blob. The <code>BLOB_READ_WRITE_TOKEN</code> is auto-injected
          when deployed on Vercel; pass <code>token</code> manually for local
          dev or other hosts.
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
      </TabsContent>

      <TabsContent className="flex flex-col gap-4" value="minio">
        <p>
          MinIO and other self-hosted S3-compatible servers. A thin wrapper
          around the S3 adapter with MinIO-friendly defaults — path-style
          addressing on, region defaulted, errors relabelled. Auto-loads from{" "}
          <code>MINIO_ACCESS_KEY_ID</code> and{" "}
          <code>MINIO_SECRET_ACCESS_KEY</code>.
        </p>
        <CodeBlock code={MINIO_EXAMPLE} lang="ts" />
        <ul>
          <li>
            <code>bucket</code> — required.
          </li>
          <li>
            <code>endpoint</code> — required. The MinIO server URL, e.g.{" "}
            <code>http://localhost:9000</code>.
          </li>
          <li>
            <code>accessKeyId</code> / <code>secretAccessKey</code> — required,
            falling back to the matching env vars.
          </li>
          <li>
            <code>region</code> — optional. Defaults to <code>us-east-1</code>;
            SigV4 requires some region but MinIO ignores it for routing.
          </li>
          <li>
            <code>forcePathStyle</code> — optional. Defaults to{" "}
            <code>true</code>; flip off only if you've set up per-bucket
            subdomain routing.
          </li>
          <li>
            <code>publicBaseUrl</code> — optional. When set, <code>url()</code>{" "}
            returns <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips
            signing. Use this if you've fronted MinIO with a CDN or set a public
            bucket policy. When unset, <code>url()</code> returns a presigned
            GetObject (1-hour default).
          </li>
        </ul>
      </TabsContent>
    </Tabs>
  </section>
);
