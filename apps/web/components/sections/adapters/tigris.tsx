import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const TIGRIS_EXAMPLE = `import { Files } from "files-sdk";
import { tigris } from "files-sdk/tigris";

const files = new Files({
  adapter: tigris({
    bucket: "uploads",
    // endpoint defaults to https://fly.storage.tigris.dev
    // region defaults to "auto" (Tigris routes globally)
    // accessKeyId / secretAccessKey auto-loaded from
    // TIGRIS_ACCESS_KEY_ID / TIGRIS_SECRET_ACCESS_KEY
  }),
});`;

export const Tigris = () => (
  <section>
    <Heading as="h2" id="adapter-tigris">
      Tigris
    </Heading>
    <p>
      Tigris globally-distributed object storage via its S3-compatible API. A
      thin wrapper around the S3 adapter - fixed global endpoint, region
      defaults to <code>"auto"</code> for signing, virtual-hosted-style
      addressing, errors relabelled. Auto-loads from{" "}
      <code>TIGRIS_ACCESS_KEY_ID</code> and{" "}
      <code>TIGRIS_SECRET_ACCESS_KEY</code>. Generate access keys in the Tigris
      console (or via the Fly CLI: <code>fly storage create</code>).
    </p>
    <CodeBlock code={TIGRIS_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-tigris-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Tigris bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>TIGRIS_ACCESS_KEY_ID</code>{" "}
            and <code>TIGRIS_SECRET_ACCESS_KEY</code>; required if those env
            vars aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Tigris endpoint. Defaults to{" "}
            <code>https://fly.storage.tigris.dev</code> - Tigris serves a single
            global endpoint and routes to the nearest region automatically.
            Override for pinned-region testing or a private deployment.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            SigV4 region used for signing. Defaults to <code>"auto"</code> -
            Tigris doesn't use the SigV4 region for routing, but the signature
            requires <em>some</em> value. Leave the default unless you have a
            reason to change it.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="forcePathStyle"
          status="optional"
          value="forcePathStyle"
        >
          <p>
            Use path-style addressing (<code>/&lt;bucket&gt;/&lt;key&gt;</code>)
            rather than virtual-hosted style. Defaults to <code>false</code> -
            virtual-hosted is canonical for Tigris.
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
            For public buckets the natural value is{" "}
            <code>{`https://<bucket>.fly.storage.tigris.dev`}</code>; a custom
            domain bound to the bucket also works. When unset,{" "}
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
);
