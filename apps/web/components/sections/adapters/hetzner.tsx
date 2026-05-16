import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

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

export const Hetzner = () => (
  <section>
    <p>
      Hetzner Object Storage via its S3-compatible API. A thin wrapper around
      the S3 adapter - endpoint derived from the location code (
      <code>fsn1</code>, <code>nbg1</code>, <code>hel1</code>),
      virtual-hosted-style addressing, errors relabelled. Auto-loads from{" "}
      <code>HCLOUD_ACCESS_KEY_ID</code> and{" "}
      <code>HCLOUD_SECRET_ACCESS_KEY</code>. Generate access keys in the Hetzner
      Cloud Console under Object Storage → Credentials.
    </p>
    <CodeBlock code={HETZNER_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Hetzner bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Hetzner location code - <code>fsn1</code> (Falkenstein),{" "}
            <code>nbg1</code> (Nuremberg), or <code>hel1</code> (Helsinki).
            Drives the endpoint host (
            <code>{`<region>.your-objectstorage.com`}</code>) and doubles as the
            SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>HCLOUD_ACCESS_KEY_ID</code>{" "}
            and <code>HCLOUD_SECRET_ACCESS_KEY</code>; required if those env
            vars aren't set.
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
            Use path-style addressing (<code>/&lt;bucket&gt;/&lt;key&gt;</code>)
            rather than virtual-hosted style. Defaults to <code>false</code> -
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
    </section>
  </section>
);
