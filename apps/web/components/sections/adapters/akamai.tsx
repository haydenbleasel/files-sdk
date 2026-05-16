import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const AKAMAI_EXAMPLE = `import { Files } from "files-sdk";
import { akamai } from "files-sdk/akamai";

const files = new Files({
  adapter: akamai({
    bucket: "uploads",
    region: "us-iad-1", // or "nl-ams-1", "fr-par-1", "us-east-1", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // AKAMAI_ACCESS_KEY_ID / AKAMAI_SECRET_ACCESS_KEY
  }),
});`;

export const Akamai = () => (
  <section>
    <p>
      Akamai Cloud Object Storage (formerly Linode Object Storage) via its
      S3-compatible API. A thin wrapper around the S3 adapter - endpoint derived
      from the region/cluster code (<code>us-iad-1</code>, <code>nl-ams-1</code>
      , <code>fr-par-1</code>, …), virtual-hosted-style addressing, errors
      relabelled. The endpoint domain <code>linodeobjects.com</code> is
      unchanged from the Linode era - only the product branding moved to Akamai.
      Auto-loads from <code>AKAMAI_ACCESS_KEY_ID</code> and{" "}
      <code>AKAMAI_SECRET_ACCESS_KEY</code>. Generate access keys in the Akamai
      Cloud Manager under Object Storage → Access Keys.
    </p>
    <CodeBlock code={AKAMAI_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Akamai bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Akamai region/cluster code - newer regions follow the{" "}
            <code>us-iad-1</code> (Washington DC), <code>us-mia-1</code>{" "}
            (Miami), <code>nl-ams-1</code> (Amsterdam), <code>fr-par-1</code>{" "}
            (Paris) pattern; older clusters use <code>us-east-1</code>,{" "}
            <code>eu-central-1</code>, <code>ap-south-1</code>. Drives the
            endpoint host (<code>{`<region>.linodeobjects.com`}</code>) and
            doubles as the SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>AKAMAI_ACCESS_KEY_ID</code>{" "}
            and <code>AKAMAI_SECRET_ACCESS_KEY</code>; required if those env
            vars aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://<region>.linodeobjects.com`}</code>. Useful behind a
            custom proxy or for non-default deployments.
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
            virtual-hosted is canonical for Akamai.
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
            For buckets with public ACL, the natural value is{" "}
            <code>{`https://<bucket>.<region>.linodeobjects.com`}</code>; a
            custom CNAME fronting the bucket also works. When unset,{" "}
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
