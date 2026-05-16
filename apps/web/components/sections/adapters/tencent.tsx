import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const TENCENT_EXAMPLE = `import { Files } from "files-sdk";
import { tencent } from "files-sdk/tencent";

const files = new Files({
  adapter: tencent({
    bucket: "uploads-1250000000", // <name>-<appid>
    region: "ap-guangzhou", // or "ap-shanghai", "na-siliconvalley", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // TENCENT_SECRET_ID / TENCENT_SECRET_KEY
  }),
});`;

export const Tencent = () => (
  <section>
    <p>
      Tencent Cloud Object Storage (COS) via its S3-compatible API. A thin
      wrapper around the S3 adapter - endpoint derived from the region code (
      <code>ap-guangzhou</code>, <code>ap-shanghai</code>,{" "}
      <code>na-siliconvalley</code>, ...), virtual-hosted-style addressing,
      errors relabelled. Auto-loads from <code>TENCENT_SECRET_ID</code> and{" "}
      <code>TENCENT_SECRET_KEY</code>. Generate API keys in the Tencent Cloud
      console under Cloud Access Management → API Keys.
    </p>
    <CodeBlock code={TENCENT_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>
            Tencent COS bucket name. Must include the{" "}
            <code>-&lt;appid&gt;</code> suffix (e.g.{" "}
            <code>uploads-1250000000</code>) — COS namespaces buckets by{" "}
            <code>&lt;name&gt;-&lt;appid&gt;</code> and the S3-compatible API
            expects the full form. The adapter scopes all operations to it.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Tencent COS region - <code>ap-guangzhou</code>,{" "}
            <code>ap-shanghai</code>, <code>ap-beijing</code>,{" "}
            <code>ap-singapore</code>, <code>na-siliconvalley</code>,{" "}
            <code>eu-frankfurt</code>, ... Drives the endpoint host (
            <code>{`cos.<region>.myqcloud.com`}</code>) and doubles as the SigV4
            region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>TENCENT_SECRET_ID</code> and{" "}
            <code>TENCENT_SECRET_KEY</code>; required if those env vars aren't
            set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://cos.<region>.myqcloud.com`}</code>. Useful behind a
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
            virtual-hosted is canonical for Tencent COS.
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
            <code>{`https://<bucket>.cos.<region>.myqcloud.com`}</code>; a CDN
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
    </section>
  </section>
);
