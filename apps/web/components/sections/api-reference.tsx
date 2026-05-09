import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

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

const URL_EXAMPLE = `// One call, every adapter. S3 / R2 / MinIO / GCS sign a GetObject (1h
// default, override with { expiresIn }); Azure signs a SAS read URL with
// the same default; Supabase signs via createSignedUrl (or returns the
// public URL when constructed with public:true); Vercel Blob (public)
// returns its CDN URL. If you configured \`publicBaseUrl\` on the
// adapter, that wins and signing is skipped.
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
          <AccordionItem className="border-dotted" value="contentType">
            <AccordionTrigger>
              <code>contentType</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                string, optional. Inferred from <code>File</code>/
                <code>Blob</code> <code>type</code> when not set.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="cacheControl">
            <AccordionTrigger>
              <code>cacheControl</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>string, optional. Sent verbatim to the provider.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="metadata">
            <AccordionTrigger>
              <code>metadata</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                <code>Record&lt;string, string&gt;</code>, optional. Provider
                user-metadata, returned by <code>head</code> and{" "}
                <code>list</code> where the provider supports it. Vercel Blob
                does not expose user metadata, so it round-trips as{" "}
                <code>undefined</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
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
          <AccordionItem className="border-dotted" value="prefix">
            <AccordionTrigger>
              <code>prefix</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>string, optional.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="limit">
            <AccordionTrigger>
              <code>limit</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>number, optional. Provider-specific cap; defaults to 1000.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="cursor">
            <AccordionTrigger>
              <code>cursor</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                string, optional. Pass <code>cursor</code> from the previous
                result to continue.
              </p>
            </AccordionContent>
          </AccordionItem>
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
        (S3, R2 over HTTP, MinIO, GCS, Azure with shared key, Supabase, R2
        binding when HTTP credentials are also configured) sign a{" "}
        <code>GetObject</code> — defaulting to a 1-hour expiry, override
        per-call via <code>{"{ expiresIn }"}</code> or per-adapter via{" "}
        <code>defaultUrlExpiresIn</code>. If the adapter is constructed with a{" "}
        <code>publicBaseUrl</code> (CDN, custom domain, <code>r2.dev</code>),
        that wins and the URL is built without signing.
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
          <AccordionItem className="border-dotted" value="expiresIn">
            <AccordionTrigger>
              <code>expiresIn</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                number of seconds, optional. Honored on signing adapters;
                ignored on Vercel Blob (no signing primitive). Defaults to the
                adapter's <code>defaultUrlExpiresIn</code> (1 hour).
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem
            className="border-dotted"
            value="responseContentDisposition"
          >
            <AccordionTrigger>
              <code>responseContentDisposition</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                string, optional.{" "}
                <span className="text-foreground">
                  Strongly recommended for buckets with user-uploaded content.
                </span>{" "}
                Without it, the browser uses the stored{" "}
                <code>Content-Type</code> to decide whether to render or
                download — a user-uploaded <code>.html</code> (or SVG with
                embedded scripts) will execute inline at your bucket's origin.
                Pass <code>"attachment"</code> to force a download.{" "}
                <strong>Forces the signing path</strong> on adapters that can
                sign (overrides <code>publicBaseUrl</code>, because permanent
                CDN URLs can't carry the override). Throws on Vercel Blob (no
                Content-Disposition primitive) and on the R2 binding without
                HTTP credentials.
              </p>
            </AccordionContent>
          </AccordionItem>
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
        browser uploads straight to S3/R2/MinIO/GCS/Azure/Supabase. Bandwidth
        and CPU stay off your server.
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
        configured hybrid mode (binding + HTTP credentials). Azure and Supabase
        return PUT URLs but throw on <code>maxSize</code> — neither SAS nor
        Supabase signed upload URLs have a <code>content-length-range</code>{" "}
        equivalent, so enforce upload caps at your application gateway (or, on
        Supabase, at the bucket-level setting in the dashboard).
      </p>
      <CodeBlock code={SIGNED_UPLOAD_EXAMPLE} lang="ts" />
      <div className="flex flex-col gap-2">
        <Heading as="h4" id="files-signed-upload-url-options">
          Options
        </Heading>
        <Accordion className="rounded-md border-dotted" type="multiple">
          <AccordionItem className="border-dotted" value="expiresIn">
            <AccordionTrigger>
              <code>expiresIn</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>number of seconds. Required.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="contentType">
            <AccordionTrigger>
              <code>contentType</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                string, optional. Bound into the signature so the upload's{" "}
                <code>Content-Type</code> must match.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="maxSize">
            <AccordionTrigger>
              <code>maxSize</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                number of bytes, optional.{" "}
                <span className="text-foreground">Strongly recommended.</span>{" "}
                Without it, the signed URL has no server-side size cap — anyone
                with the URL can upload an arbitrarily large file until{" "}
                <code>expiresIn</code> elapses. With it, the adapter switches to
                a presigned POST form that enforces the size via{" "}
                <code>content-length-range</code>.
              </p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem className="border-dotted" value="minSize">
            <AccordionTrigger>
              <code>minSize</code>
            </AccordionTrigger>
            <AccordionContent>
              <p>
                number of bytes, optional. Defaults to <code>1</code> when{" "}
                <code>maxSize</code> is set, so empty uploads are rejected by
                the POST policy. Pass <code>0</code> to allow them.
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
    </section>
  </section>
);
