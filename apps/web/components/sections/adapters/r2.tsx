import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";

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

export const R2 = () => (
  <section>
    <p>
      Cloudflare R2 over the S3-compatible HTTP API. Auto-loads from{" "}
      <code>R2_ACCOUNT_ID</code>, <code>R2_ACCESS_KEY_ID</code>,{" "}
      <code>R2_SECRET_ACCESS_KEY</code>. Inside Cloudflare Workers you can pass
      an <code>R2Bucket</code> binding directly instead.
    </p>
    <CodeBlock code={R2_EXAMPLE} lang="ts" />
    <p>
      <code>publicBaseUrl</code> - optional, an <code>r2.dev</code> subdomain or
      custom domain bound to the bucket. When set, <code>url()</code> returns{" "}
      <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips signing.
    </p>
    <Heading as="h2" id="hybrid">
      Hybrid: binding + HTTP credentials
    </Heading>
    <p>
      Inside a Worker, you can pass <em>both</em> a binding and HTTP
      credentials. Reads and writes go through the binding (no egress, no extra
      round trip); <code>url()</code> and <code>signedUploadUrl()</code> route
      through the HTTP signer because a Worker binding has no signing primitive.
      The S3 client is lazy-loaded - bindings-only Workers don't pull{" "}
      <code>@aws-sdk/client-s3</code> into their bundle.
    </p>
    <CodeBlock code={R2_HYBRID_EXAMPLE} lang="ts" />
  </section>
);
