import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const SCALEWAY_EXAMPLE = `import { Files } from "files-sdk";
import { scaleway } from "files-sdk/scaleway";

const files = new Files({
  adapter: scaleway({
    bucket: "uploads",
    region: "fr-par", // or "nl-ams", "pl-waw"
    // accessKeyId / secretAccessKey auto-loaded from
    // SCW_ACCESS_KEY / SCW_SECRET_KEY
  }),
});`;

export const Scaleway = () => (
  <section>
    <Heading as="h2" id="adapter-scaleway">
      Scaleway Object Storage
    </Heading>
    <p>
      Scaleway Object Storage via its S3-compatible API. A thin wrapper around
      the S3 adapter - endpoint derived from the region code (
      <code>fr-par</code>, <code>nl-ams</code>, <code>pl-waw</code>),
      virtual-hosted-style addressing, errors relabelled. Auto-loads from{" "}
      <code>SCW_ACCESS_KEY</code> and <code>SCW_SECRET_KEY</code>. Generate
      access keys in the Scaleway console under Identity and Access Management →
      API Keys.
    </p>
    <CodeBlock code={SCALEWAY_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-scaleway-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Scaleway bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Scaleway region - <code>fr-par</code> (Paris), <code>nl-ams</code>{" "}
            (Amsterdam), <code>pl-waw</code> (Warsaw). Drives the endpoint host
            (<code>{`s3.<region>.scw.cloud`}</code>) and doubles as the SigV4
            region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>SCW_ACCESS_KEY</code> and{" "}
            <code>SCW_SECRET_KEY</code>; required if those env vars aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://s3.<region>.scw.cloud`}</code>. Useful behind a
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
            virtual-hosted is canonical for Scaleway.
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
            For buckets with public read the natural value is{" "}
            <code>{`https://<bucket>.s3.<region>.scw.cloud`}</code>; a custom
            domain fronting the bucket also works. When unset,{" "}
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
