import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const VULTR_EXAMPLE = `import { Files } from "files-sdk";
import { vultr } from "files-sdk/vultr";

const files = new Files({
  adapter: vultr({
    bucket: "uploads",
    region: "ewr", // or "sjc", "ams", "blr", "del", "sgp", "lux"
    // accessKeyId / secretAccessKey auto-loaded from
    // VULTR_ACCESS_KEY_ID / VULTR_SECRET_ACCESS_KEY
  }),
});`;

export const Vultr = () => (
  <section>
    <p>
      Vultr Object Storage via its S3-compatible API. A thin wrapper around the
      S3 adapter - endpoint derived from the region code (<code>ewr</code>,{" "}
      <code>sjc</code>, <code>ams</code>, <code>blr</code>, <code>del</code>,{" "}
      <code>sgp</code>, <code>lux</code>), virtual-hosted-style addressing,
      errors relabelled. Auto-loads from <code>VULTR_ACCESS_KEY_ID</code> and{" "}
      <code>VULTR_SECRET_ACCESS_KEY</code>. Generate access keys in the Vultr
      customer portal under Object Storage → your subscription → Overview.
    </p>
    <CodeBlock code={VULTR_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Vultr bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Vultr region code - <code>ewr</code> (New Jersey), <code>sjc</code>{" "}
            (Silicon Valley), <code>ams</code> (Amsterdam), <code>blr</code>{" "}
            (Bangalore), <code>del</code> (Delhi), <code>sgp</code> (Singapore),{" "}
            <code>lux</code> (Luxembourg). Drives the endpoint host (
            <code>{`<region>.vultrobjects.com`}</code>) and doubles as the SigV4
            region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>VULTR_ACCESS_KEY_ID</code>{" "}
            and <code>VULTR_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://<region>.vultrobjects.com`}</code>. Useful behind a
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
            virtual-hosted is canonical for Vultr.
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
            For buckets with public ACL the natural value is{" "}
            <code>{`https://<bucket>.<region>.vultrobjects.com`}</code>; a
            custom CNAME fronting the bucket also works. Vultr has no built-in
            CDN. When unset, <code>url()</code> returns a presigned GetObject
            (1-hour default).
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
