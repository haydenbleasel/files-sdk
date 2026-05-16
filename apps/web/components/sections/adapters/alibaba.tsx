import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const ALIBABA_EXAMPLE = `import { Files } from "files-sdk";
import { alibaba } from "files-sdk/alibaba";

const files = new Files({
  adapter: alibaba({
    bucket: "uploads",
    region: "cn-hangzhou", // or "cn-shanghai", "ap-southeast-1", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // ALIBABA_ACCESS_KEY_ID / ALIBABA_ACCESS_KEY_SECRET
  }),
});`;

export const Alibaba = () => (
  <section>
    <p>
      Alibaba Cloud Object Storage Service (OSS) via its S3-compatible API. A
      thin wrapper around the S3 adapter - endpoint derived from the region code
      (<code>cn-hangzhou</code>, <code>cn-shanghai</code>,{" "}
      <code>ap-southeast-1</code>, ...), virtual-hosted-style addressing, errors
      relabelled. Auto-loads from <code>ALIBABA_ACCESS_KEY_ID</code> and{" "}
      <code>ALIBABA_ACCESS_KEY_SECRET</code>. Generate AccessKey pairs in the
      Alibaba Cloud console under RAM → Users.
    </p>
    <CodeBlock code={ALIBABA_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>
            Alibaba OSS bucket name. The adapter scopes all operations to it.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Alibaba OSS region - <code>cn-hangzhou</code>,{" "}
            <code>cn-shanghai</code>, <code>cn-beijing</code>,{" "}
            <code>ap-southeast-1</code> (Singapore), <code>us-east-1</code>{" "}
            (Virginia), <code>eu-central-1</code> (Frankfurt), ... Drives the
            endpoint host (<code>{`oss-<region>.aliyuncs.com`}</code>) and
            doubles as the SigV4 region (pass the bare region, not the{" "}
            <code>oss-</code>-prefixed form). No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>ALIBABA_ACCESS_KEY_ID</code>{" "}
            and <code>ALIBABA_ACCESS_KEY_SECRET</code>; required if those env
            vars aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://oss-<region>.aliyuncs.com`}</code>. Useful behind a
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
            virtual-hosted is canonical for Alibaba OSS.
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
            <code>{`https://<bucket>.oss-<region>.aliyuncs.com`}</code>; a
            custom domain bound to the bucket also works. When unset,{" "}
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
