import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const UPLOAD_EXAMPLE = `await files.upload("avatars/abc.png", file, {
  contentType: "image/png",
  cacheControl: "public, max-age=31536000",
  metadata: { userId: "123" },
});
// → { key, size, contentType, etag, lastModified }`;

const DOWNLOAD_EXAMPLE = `const file = await files.download("avatars/abc.png");
// → StoredFile (Blob-backed)

const stream = await files.download("avatars/abc.png", { as: "stream" });
// → ReadableStream`;

const HEAD_EXAMPLE = `const info = await files.head("avatars/abc.png");
// → StoredFile with no body materialized`;

const DELETE_EXAMPLE = `await files.delete("avatars/abc.png");`;

const COPY_EXAMPLE = `await files.copy("avatars/abc.png", "avatars/abc.bak.png");`;

const LIST_EXAMPLE = `const { items, cursor } = await files.list({
  prefix: "avatars/",
  limit: 100,
});

if (cursor) {
  const next = await files.list({ prefix: "avatars/", cursor });
}`;

const URL_EXAMPLE = `// One call, every adapter. S3 / R2 / MinIO / DO Spaces / Storj / Hetzner / Akamai / GCS sign a GetObject (1h
// default, override with { expiresIn }); Azure signs a SAS read URL with
// the same default; Supabase signs via createSignedUrl (or returns the
// public URL when constructed with public:true); Vercel Blob (public)
// and UploadThing (public-read) return their CDN URLs. If you configured
// \`publicBaseUrl\` on the adapter, that wins and signing is skipped.
const url = await files.url("avatars/abc.png");
const short = await files.url("avatars/abc.png", { expiresIn: 60 });

// Force download (defeat stored XSS from user-uploaded HTML/SVG).
// Forces signing even if \`publicBaseUrl\` is configured — a permanent
// CDN URL has no signature to bind the override into, and silently
// dropping a security ask would be a regression.
const safe = await files.url("avatars/abc.png", {
  responseContentDisposition: "attachment",
});`;

const SIGNED_UPLOAD_EXAMPLE = `// On your server: hand back an upload contract that lets the browser
// PUT/POST the file directly to the bucket. Bytes never touch your server.
const upload = await files.signedUploadUrl("avatars/abc.png", {
  expiresIn: 60,
  contentType: "image/png",
  maxSize: 5_000_000,
});
// → { method: "PUT", url, headers? }
//   | { method: "POST", url, fields }

// In the browser: PUT path (no maxSize) is a plain fetch.
await fetch(upload.url, {
  method: "PUT",
  body: file,
  headers: upload.headers,
});

// POST path (with maxSize) is multipart with the signed policy fields.
const form = new FormData();
for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
form.append("file", file);
await fetch(upload.url, { method: "POST", body: form });`;

export const ApiReference = () => (
  <section>
    <Heading as="h2">API reference</Heading>
    <p>
      Every method is available on the <code>Files</code> instance. The unified
      surface only covers what every adapter can do cleanly — anything
      provider-specific lives on <code>files.raw</code>.
    </p>

    <section>
      <Heading as="h3" id="files-upload">
        files.upload(key, body, options?)
      </Heading>
      <p>
        Writes a body to <code>key</code>. Accepts native <code>File</code>,{" "}
        <code>Blob</code>, <code>ReadableStream</code>, <code>ArrayBuffer</code>
        , or <code>string</code>. Content type is inferred from the input when
        possible.
      </p>
      <CodeBlock code={UPLOAD_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="files-upload-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem
            name="contentType"
            status="optional"
            value="contentType"
          >
            <p>
              MIME type stored alongside the object and returned to readers in
              the <code>Content-Type</code> response header. Inferred from{" "}
              <code>File</code> / <code>Blob</code> <code>type</code> when not
              set; falls back to <code>application/octet-stream</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="cacheControl"
            status="optional"
            value="cacheControl"
          >
            <p>
              <code>Cache-Control</code> header stored on the object. Sent
              verbatim to the provider; controls how downstream caches and
              browsers cache reads of this key.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="metadata" status="optional" value="metadata">
            <p>
              <code>Record&lt;string, string&gt;</code> of arbitrary user
              metadata stored alongside the object. Returned by{" "}
              <code>head()</code> and <code>list()</code> where the provider
              supports it. Vercel Blob and UploadThing have no user-metadata
              primitive, so it round-trips as <code>undefined</code> there.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="files-download">
        files.download(key, options?)
      </Heading>
      <p>
        Reads an object. Returns a <code>StoredFile</code> by default
        (Blob-backed). Pass <code>{'{ as: "stream" }'}</code> to opt into a{" "}
        <code>ReadableStream</code> for large objects.
      </p>
      <CodeBlock code={DOWNLOAD_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="files-head">
        files.head(key)
      </Heading>
      <p>
        Returns the same <code>StoredFile</code> shape as <code>download</code>,
        without materializing the body. Calling a body accessor on the result
        lazy-fetches.
      </p>
      <CodeBlock code={HEAD_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="files-delete">
        files.delete(key)
      </Heading>
      <p>
        Removes an object. No-op friendly: a missing key resolves successfully
        on providers that treat delete as idempotent, and throws{" "}
        <code>FilesError</code> with <code>code: "NotFound"</code> on ones that
        don't.
      </p>
      <CodeBlock code={DELETE_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="files-copy">
        files.copy(from, to)
      </Heading>
      <p>
        Server-side copy where the provider supports it; falls back to read +
        write otherwise.
      </p>
      <CodeBlock code={COPY_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="files-list">
        files.list(options?)
      </Heading>
      <p>
        Cursor-paginated listing with prefix filter. Each item is a{" "}
        <code>StoredFile</code> with a lazy body accessor.
      </p>
      <CodeBlock code={LIST_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="files-list-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem name="prefix" status="optional" value="prefix">
            <p>
              Filter results to keys that start with this string. Omit to list
              everything in the bucket.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="limit" status="optional" value="limit">
            <p>
              Maximum number of items to return per page. Capped per-provider
              (most providers max around 1000). Defaults to 1000.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="cursor" status="optional" value="cursor">
            <p>
              Continuation token from a prior result. Pass the{" "}
              <code>cursor</code> field of the previous page back in to fetch
              the next page; omit on the first call.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="files-url">
        files.url(key, options?)
      </Heading>
      <p>
        Returns a URL the caller can use to fetch <code>key</code>. Every
        adapter returns the most direct URL it can produce. Signing adapters
        (S3, R2 over HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai,
        GCS, Azure with shared key, Supabase, UploadThing in{" "}
        <code>private</code> mode, R2 binding when HTTP credentials are also
        configured) sign a <code>GetObject</code> — defaulting to a 1-hour
        expiry, override per-call via <code>{"{ expiresIn }"}</code> or
        per-adapter via <code>defaultUrlExpiresIn</code>. If the adapter is
        constructed with a <code>publicBaseUrl</code> (CDN, custom domain,{" "}
        <code>r2.dev</code>) or UploadThing's <code>public-read</code> ACL, that
        wins and the URL is built without signing.
      </p>
      <p>
        Two configurations have no URL primitive and throw: Vercel Blob in{" "}
        <code>access: "private"</code> mode, and an R2 Workers binding without
        either <code>publicBaseUrl</code> or HTTP credentials.
      </p>
      <CodeBlock code={URL_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="files-url-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem
            name="expiresIn"
            status="optional"
            value="expiresIn"
          >
            <p>
              URL expiry, in seconds. Honored on signing adapters (S3, R2 over
              HTTP, MinIO, DigitalOcean Spaces, Storj, Hetzner, Akamai, GCS,
              Azure with shared key, Supabase, R2 hybrid, UploadThing in{" "}
              <code>private</code> mode); ignored on Vercel Blob and on
              UploadThing's <code>public-read</code> mode (no signing
              primitive). Defaults to the adapter's{" "}
              <code>defaultUrlExpiresIn</code> (1 hour).
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="responseContentDisposition"
            status="optional"
            value="responseContentDisposition"
          >
            <p>
              Override the <code>Content-Disposition</code> header on the
              response.{" "}
              <span className="text-foreground">
                Strongly recommended for buckets with user-uploaded content.
              </span>{" "}
              Without it, the browser uses the stored <code>Content-Type</code>{" "}
              to decide whether to render or download — a user-uploaded{" "}
              <code>.html</code> (or SVG with embedded scripts) will execute
              inline at your bucket's origin. Pass <code>"attachment"</code> to
              force a download. <strong>Forces the signing path</strong> on
              adapters that can sign (overrides <code>publicBaseUrl</code>,
              because permanent CDN URLs can't carry the override). Throws on
              Vercel Blob and UploadThing (no Content-Disposition primitive on
              either) and on the R2 binding without HTTP credentials.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>

    <section>
      <Heading as="h3" id="files-signed-upload-url">
        files.signedUploadUrl(key, options)
      </Heading>
      <p>
        Returns a discriminated PUT-or-POST contract so a client (typically a
        browser) can upload directly to the bucket without proxying bytes
        through your server. The flow is: your server calls{" "}
        <code>signedUploadUrl()</code>, returns the result to the browser, the
        browser uploads straight to the provider directly. Bandwidth and CPU
        stay off your server.
      </p>
      <p>
        Without <code>maxSize</code>, the adapter returns a presigned PUT URL —
        simpler, but with no server-side size cap. With <code>maxSize</code>,
        the adapter switches to a presigned POST form whose policy enforces the
        size at the bucket via <code>content-length-range</code>. In practice
        you should always pass <code>maxSize</code> — without it, anyone with
        the URL can DoS your storage costs until <code>expiresIn</code> elapses.
      </p>
      <p>
        Vercel Blob throws here — its upload model goes through{" "}
        <code>handleUpload()</code> from <code>@vercel/blob/client</code>{" "}
        instead of presigned URLs. The R2 Workers binding throws unless you've
        configured hybrid mode (binding + HTTP credentials). Azure, Supabase,
        and UploadThing return PUT URLs but treat <code>maxSize</code> as
        advisory rather than enforced — Azure and Supabase have no{" "}
        <code>content-length-range</code> equivalent (Azure throws on the
        option, Supabase throws too), and UploadThing enforces caps via the
        file-router config tied to the adapter's <code>slug</code> instead of
        via the URL signature. Enforce upload caps at your application gateway
        (or at the provider's dashboard-level bucket/route setting).
      </p>
      <CodeBlock code={SIGNED_UPLOAD_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="files-signed-upload-url-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <PropAccordionItem
            name="expiresIn"
            status="required"
            value="expiresIn"
          >
            <p>
              How long the signed URL stays valid, in seconds. After it elapses,
              the URL stops working and the client must request a new one.
            </p>
          </PropAccordionItem>
          <PropAccordionItem
            name="contentType"
            status="optional"
            value="contentType"
          >
            <p>
              MIME type bound into the signature. The browser's PUT/POST must
              send a matching <code>Content-Type</code> header or the provider
              rejects the upload.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="maxSize" status="optional" value="maxSize">
            <p>
              Maximum upload size in bytes, enforced server-side.{" "}
              <span className="text-foreground">Strongly recommended.</span>{" "}
              Without it, the adapter falls back to a presigned PUT URL with no
              server-side size cap — anyone with the URL can upload an
              arbitrarily large file until <code>expiresIn</code> elapses. With
              it, the adapter switches to a presigned POST form whose policy
              enforces the size via <code>content-length-range</code>.
            </p>
          </PropAccordionItem>
          <PropAccordionItem name="minSize" status="optional" value="minSize">
            <p>
              Minimum upload size in bytes for the presigned POST policy.
              Defaults to <code>1</code> when <code>maxSize</code> is set, so
              empty uploads are rejected (the most common app assumption — "file
              present means real content" — fails silently when 0-byte uploads
              land). Pass <code>0</code> to allow empty uploads. Only consulted
              when <code>maxSize</code> is set.
            </p>
          </PropAccordionItem>
        </Accordion>
      </div>
    </section>
  </section>
);
