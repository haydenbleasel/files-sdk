import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const UPLOADTHING_EXAMPLE = `import { Files } from "files-sdk";
import { uploadthing } from "files-sdk/uploadthing";

// UPLOADTHING_TOKEN is auto-loaded from env. The token is a base64
// JSON of { apiKey, appId, regions[] } - the adapter decodes it at
// construction so url() can synthesize the public CDN URL and
// signedUploadUrl() can sign a UFS PUT URL without an API round trip.
const files = new Files({
  adapter: uploadthing({
    // acl: "public-read",       // default; switch to "private" to mint
    //                            // signed URLs through generateSignedURL
    // slug: "mediaUploader",    // required only for signedUploadUrl()
  }),
});`;

export const Uploadthing = () => (
  <section>
    <Heading as="h2" id="adapter-uploadthing">
      UploadThing
    </Heading>
    <p>
      UploadThing via the official <code>uploadthing/server</code> SDK.
      UploadThing generates its own internal file keys, so the adapter maps the
      user-supplied key onto UploadThing's <code>customId</code> with{" "}
      <code>defaultKeyType: "customId"</code> - every subsequent operation
      routes by your key, not the auto-generated one.
    </p>
    <CodeBlock code={UPLOADTHING_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-uploadthing-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="token" status="optional" value="token">
          <p>
            UploadThing token (base64 JSON of{" "}
            <code>{"{ apiKey, appId, regions }"}</code>). Falls back to{" "}
            <code>UPLOADTHING_TOKEN</code>; the adapter throws at construction
            if neither is set, or if the token doesn't decode to that shape - so
            misconfiguration surfaces immediately rather than on the first call.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="acl" status="optional" value="acl">
          <p>
            <code>"public-read"</code> (default) or <code>"private"</code>.
            Drives both the upload-time ACL and <code>url()</code> behavior -{" "}
            <code>public-read</code> returns the permanent CDN URL,{" "}
            <code>private</code> mints a short-lived signed URL via{" "}
            <code>generateSignedURL</code>. Fixed at construction, so a single{" "}
            <code>Files</code> instance is unambiguously one or the other. Need
            both? Use two adapters.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="slug" status="optional" value="slug">
          <p>
            UploadThing file-router slug. Required only by{" "}
            <code>signedUploadUrl()</code>, which embeds it as{" "}
            <code>x-ut-slug</code> on the ingest URL - UploadThing validates the
            upload against the route's config (allowed file types and sizes).
            Server-side <code>upload()</code> doesn't need it.
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
            <code>0</code> to disable. A hung CDN response would otherwise leak
            a fetch that never resolves.
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-uploadthing-limitations">
        Limitations
      </Heading>
      <p>
        <code>copy()</code> is a read-then-write - UploadThing has no
        server-side copy primitive, so the source is downloaded and re-uploaded;
        not atomic and pays both an egress and an ingest cost.{" "}
        <code>head()</code> falls back to a HEAD request against the resolved
        file URL because UploadThing has no metadata endpoint - fields come from
        response headers, and user <code>metadata</code> isn't supported by the
        underlying API. <code>list()</code> uses UploadThing's offset/limit API;
        the adapter encodes <code>offset</code> as a numeric cursor string, and{" "}
        <code>prefix</code> is filtered client-side over each page (it can
        under-return when the prefix isn't satisfied within a single page).{" "}
        <code>signedUploadUrl()</code> issues PUT URLs against the UFS ingest
        endpoint - <code>maxSize</code> is advisory (UploadThing enforces caps
        via the file-router config tied to <code>slug</code>, not via the URL
        signature) and <code>minSize</code> is ignored. <code>url()</code>{" "}
        throws on <code>responseContentDisposition</code> - UploadThing has no
        Content-Disposition override on signed or CDN URLs.
      </p>
    </div>
  </section>
);
