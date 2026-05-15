import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const CLOUDINARY_EXAMPLE = `import { Files } from "files-sdk";
import { cloudinary } from "files-sdk/cloudinary";

const files = new Files({
  adapter: cloudinary({
    // Auto-loads from CLOUDINARY_URL (cloudinary://key:secret@cloud)
    // or CLOUDINARY_CLOUD_NAME + CLOUDINARY_API_KEY + CLOUDINARY_API_SECRET.
    //
    // Defaults to resource_type: "raw" - closest to S3-style
    // arbitrary-bytes storage. Switch to "image" / "video" if the
    // bucket holds those types and you want transforms.
    resourceType: "raw",
    type: "upload",
  }),
});`;

export const Cloudinary = () => (
  <section>
    <p>
      Cloudinary asset CDN via the official <code>cloudinary</code> Node SDK.
      Defaults to <code>resource_type: &quot;raw&quot;</code> for
      arbitrary-bytes storage so keys round-trip cleanly through the adapter;
      switch to <code>&quot;image&quot;</code> or <code>&quot;video&quot;</code>{" "}
      if you want Cloudinary&apos;s transformation features. Falls back to{" "}
      <code>CLOUDINARY_URL</code> or individual env vars when no explicit
      credentials are passed.
    </p>
    <CodeBlock code={CLOUDINARY_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="cloudName" status="optional" value="cloudName">
          <p>
            Cloudinary cloud name. Falls back to{" "}
            <code>CLOUDINARY_CLOUD_NAME</code> or the <code>cloud_name</code>{" "}
            parsed out of <code>CLOUDINARY_URL</code>. Required (the adapter
            throws if it cannot resolve a cloud name from options or env).
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="apiKey" status="optional" value="apiKey">
          <p>
            Cloudinary API key. Falls back to <code>CLOUDINARY_API_KEY</code> or
            the key parsed out of <code>CLOUDINARY_URL</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="apiSecret" status="optional" value="apiSecret">
          <p>
            Cloudinary API secret. Falls back to{" "}
            <code>CLOUDINARY_API_SECRET</code> or the secret parsed out of{" "}
            <code>CLOUDINARY_URL</code>. Required for{" "}
            <code>signedUploadUrl()</code> and for signing private/authenticated{" "}
            <code>url()</code> calls.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="resourceType"
          status="optional"
          value="resourceType"
        >
          <p>
            Cloudinary <code>resource_type</code> bucket. One of{" "}
            <code>&quot;image&quot;</code>, <code>&quot;video&quot;</code>,{" "}
            <code>&quot;raw&quot;</code>. Defaults to{" "}
            <code>&quot;raw&quot;</code> for S3-style arbitrary-bytes semantics.
            Cloudinary stores assets under a concrete type per upload, so
            subsequent reads must match — mixed-type buckets need separate
            adapter instances.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="type" status="optional" value="type">
          <p>
            Cloudinary delivery type. One of <code>&quot;upload&quot;</code>{" "}
            (public CDN, the default), <code>&quot;private&quot;</code>,{" "}
            <code>&quot;authenticated&quot;</code>. For the non-public types,{" "}
            <code>url()</code> mints a short-lived signed URL.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="secure" status="optional" value="secure">
          <p>
            Serve assets over HTTPS. Defaults to <code>true</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="signedUrlExpiresIn"
          status="optional"
          value="signedUrlExpiresIn"
        >
          <p>
            Default expiry (seconds) for signed <code>url()</code> output on
            private/authenticated assets. Per-call <code>opts.expiresIn</code>{" "}
            wins. Defaults to <code>3600</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Pre-configured <code>cloudinary.v2</code> namespace — escape hatch
            for callers that have already called{" "}
            <code>cloudinary.config()</code> themselves. When passed, the
            adapter skips its own config call.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        Cloudinary&apos;s SDK keeps configuration as module-level global state,
        so mounting multiple <code>cloudinary()</code> adapters in the same
        process with different credentials will see only the last config win —
        use the <code>client</code> escape hatch with separately configured SDK
        instances if you need that. <code>signedUploadUrl()</code> returns a
        Cloudinary form-POST shape (<code>method: &quot;POST&quot;</code> with{" "}
        <code>fields</code>), not a single presigned URL. <code>expiresIn</code>{" "}
        on signed-upload URLs is informational — Cloudinary signatures are fixed
        at 1h. <code>maxSize</code> and <code>minSize</code> are not enforced
        server-side; use an upload preset with <code>max_file_size</code> if you
        need that. <code>UploadOptions</code> <code>cacheControl</code> and{" "}
        <code>metadata</code> throw — Cloudinary doesn&apos;t expose HTTP cache
        headers per-asset and has no arbitrary-metadata field on the upload call
        (use <code>raw</code> for <code>context</code>).{" "}
        <code>responseContentDisposition</code> on <code>url()</code> throws —
        Cloudinary has no per-request Content-Disposition override.{" "}
        <code>copy()</code> re-uploads from the source delivery URL — copies
        produce new <code>asset_id</code>/<code>etag</code>, not byte-identical
        references. <code>list(&#123; limit &#125;)</code> is clamped to 500
        (Cloudinary Admin API ceiling).
      </p>
    </section>
  </section>
);
