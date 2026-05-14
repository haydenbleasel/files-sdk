import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const EXOSCALE_EXAMPLE = `import { Files } from "files-sdk";
import { exoscale } from "files-sdk/exoscale";

const files = new Files({
  adapter: exoscale({
    bucket: "uploads",
    region: "ch-gva-2", // or "de-fra-1", "at-vie-1", "bg-sof-1", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // EXOSCALE_API_KEY / EXOSCALE_API_SECRET
  }),
});`;

export const Exoscale = () => (
  <section>
    <Heading as="h2" id="adapter-exoscale">
      Exoscale Object Storage
    </Heading>
    <p>
      Exoscale Object Storage (SOS) via its S3-compatible API. A thin wrapper
      around the S3 adapter - endpoint derived from the zone code (
      <code>ch-gva-2</code>, <code>ch-dk-2</code>, <code>de-fra-1</code>,{" "}
      <code>de-muc-1</code>, <code>at-vie-1</code>, <code>at-vie-2</code>,{" "}
      <code>bg-sof-1</code>), virtual-hosted-style addressing, errors
      relabelled. Pass the zone as <code>region</code> - Exoscale calls them
      zones but they fill the SigV4 region slot. Auto-loads from{" "}
      <code>EXOSCALE_API_KEY</code> and <code>EXOSCALE_API_SECRET</code>.
      Generate IAM keys in the Exoscale Portal under IAM → API Keys.
    </p>
    <CodeBlock code={EXOSCALE_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-exoscale-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Exoscale bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Exoscale zone code - <code>ch-gva-2</code> (Geneva),{" "}
            <code>ch-dk-2</code> (Zurich), <code>de-fra-1</code> (Frankfurt),{" "}
            <code>de-muc-1</code> (Munich), <code>at-vie-1</code> /{" "}
            <code>at-vie-2</code> (Vienna), <code>bg-sof-1</code> (Sofia).
            Drives the endpoint host (<code>{`sos-<region>.exo.io`}</code>) and
            doubles as the SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>EXOSCALE_API_KEY</code> and{" "}
            <code>EXOSCALE_API_SECRET</code>; required if those env vars aren't
            set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://sos-<region>.exo.io`}</code>. Useful behind a custom
            proxy or for non-default deployments.
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
            virtual-hosted is canonical for SOS.
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
            <code>{`https://sos-<region>.exo.io/<bucket>`}</code> (path-style)
            or <code>{`https://<bucket>.sos-<region>.exo.io`}</code>; a custom
            CNAME fronting the bucket also works. When unset, <code>url()</code>{" "}
            returns a presigned GetObject (1-hour default).
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
