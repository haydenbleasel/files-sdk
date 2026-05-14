import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const OVHCLOUD_EXAMPLE = `import { Files } from "files-sdk";
import { ovhcloud } from "files-sdk/ovhcloud";

const files = new Files({
  adapter: ovhcloud({
    bucket: "uploads",
    region: "gra", // or "sbg", "de", "uk", "waw", "sgp", "syd"
    // accessKeyId / secretAccessKey auto-loaded from
    // OVH_ACCESS_KEY_ID / OVH_SECRET_ACCESS_KEY
  }),
});`;

export const Ovhcloud = () => (
  <section>
    <Heading as="h2" id="adapter-ovhcloud">
      OVHcloud Object Storage
    </Heading>
    <p>
      OVHcloud Object Storage (High Performance S3) via its S3-compatible API. A
      thin wrapper around the S3 adapter - endpoint derived from the region code
      (<code>gra</code>, <code>sbg</code>, <code>bhs</code>, <code>de</code>,{" "}
      <code>uk</code>, <code>waw</code>, <code>sgp</code>, <code>syd</code>),
      virtual-hosted-style addressing, errors relabelled. For the Standard
      (Swift-backed) tier, pass{" "}
      <code>{`https://s3.<region>.cloud.ovh.net`}</code> as the explicit{" "}
      <code>endpoint</code>. Auto-loads from <code>OVH_ACCESS_KEY_ID</code> and{" "}
      <code>OVH_SECRET_ACCESS_KEY</code>. Generate S3 credentials in the
      OVHcloud Control Panel under Public Cloud → Object Storage → S3 users.
    </p>
    <CodeBlock code={OVHCLOUD_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-ovhcloud-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>OVHcloud bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            OVHcloud region code - <code>gra</code> (Gravelines),{" "}
            <code>sbg</code> (Strasbourg), <code>bhs</code> (Beauharnois),{" "}
            <code>de</code> (Frankfurt), <code>uk</code> (London),{" "}
            <code>waw</code> (Warsaw), <code>sgp</code> (Singapore),{" "}
            <code>syd</code> (Sydney). Drives the High Performance S3 endpoint
            host (<code>{`s3.<region>.io.cloud.ovh.net`}</code>) and doubles as
            the SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>OVH_ACCESS_KEY_ID</code> and{" "}
            <code>OVH_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://s3.<region>.io.cloud.ovh.net`}</code> (High
            Performance). For the Standard tier, pass{" "}
            <code>{`https://s3.<region>.cloud.ovh.net`}</code> explicitly.
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
            virtual-hosted is canonical for OVHcloud.
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
            For public containers the natural value is{" "}
            <code>{`https://<bucket>.s3.<region>.io.cloud.ovh.net`}</code>; a
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
    </div>
  </section>
);
