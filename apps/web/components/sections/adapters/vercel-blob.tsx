import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";

const VERCEL_BLOB_EXAMPLE = `import { Files } from "files-sdk";
import { vercelBlob } from "files-sdk/vercel-blob";

// On Vercel: VERCEL_OIDC_TOKEN + BLOB_STORE_ID are auto-injected when the
// Blob store is connected to the project (OIDC, recommended). Off Vercel,
// or as a fallback, BLOB_READ_WRITE_TOKEN is used.
const files = new Files({ adapter: vercelBlob() });`;

const VERCEL_BLOB_EXPLICIT_OIDC_EXAMPLE = `// Frameworks that don't load .env.local into process.env (Vite, etc.)
// need OIDC credentials passed explicitly.
const files = new Files({
  adapter: vercelBlob({
    oidcToken: loadOidcToken(),
    storeId: loadStoreId(),
  }),
});`;

export const VercelBlob = () => (
  <section>
    <p>
      Vercel Blob. On Vercel, the adapter prefers Vercel's{" "}
      <strong>OIDC authentication</strong> when <code>VERCEL_OIDC_TOKEN</code>{" "}
      and <code>BLOB_STORE_ID</code> are present (both are auto-injected when
      the Blob store is connected to the project). OIDC tokens rotate
      automatically, so they remove the risk that a long-lived secret leaks from
      the codebase or environment. Off Vercel - or if OIDC isn't configured -
      the adapter falls back to <code>BLOB_READ_WRITE_TOKEN</code>. An explicit{" "}
      <code>token</code> option always wins.
    </p>
    <CodeBlock code={VERCEL_BLOB_EXAMPLE} lang="ts" />
    <p>
      Pass <code>oidcToken</code> and <code>storeId</code> directly for runtimes
      that don't expose <code>process.env</code>, or to bypass env detection
      entirely:
    </p>
    <CodeBlock code={VERCEL_BLOB_EXPLICIT_OIDC_EXAMPLE} lang="ts" />
    <p>
      <code>downloadTimeoutMs</code> bounds the public-URL fetches issued by{" "}
      <code>download()</code> and the lazy bodies returned from{" "}
      <code>head()</code>/<code>list()</code>. Defaults to 5 minutes; pass{" "}
      <code>0</code> to disable. A hung CDN response would otherwise leak a
      fetch that never resolves.
    </p>
    <p>
      <code>access</code> selects public or private blobs and is fixed at
      construction. Default <code>"public"</code> matches the existing behavior.
      With <code>access: "private"</code>, uploads use Vercel's private mode and
      reads route through <code>blob.get()</code> with whichever credentials the
      adapter resolved (OIDC or read-write token) instead of a public URL fetch
      - there is no permanent public URL for private blobs, so{" "}
      <code>url()</code> throws. Need both? Use two adapters.
    </p>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> throws - browser uploads go through{" "}
        <code>handleUpload()</code> from <code>@vercel/blob/client</code>{" "}
        instead of presigned URLs. <code>url()</code> on public blobs returns
        the permanent CDN URL: <code>expiresIn</code> is silently ignored (no
        signing primitive) and <code>responseContentDisposition</code> throws
        (no override available). On <code>access: "private"</code>,{" "}
        <code>url()</code> throws because there's no public URL - use{" "}
        <code>download()</code> instead. User <code>metadata</code> isn't
        supported by the underlying API, so it round-trips as{" "}
        <code>undefined</code>.
      </p>
    </section>
  </section>
);
