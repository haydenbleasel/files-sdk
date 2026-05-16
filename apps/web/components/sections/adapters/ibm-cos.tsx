import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const IBM_COS_EXAMPLE = `import { Files } from "files-sdk";
import { ibmCos } from "files-sdk/ibm-cos";

const files = new Files({
  adapter: ibmCos({
    bucket: "uploads",
    region: "us-south", // or "eu-de", "jp-tok", "au-syd", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // IBM_COS_ACCESS_KEY_ID / IBM_COS_SECRET_ACCESS_KEY (HMAC credentials)
  }),
});`;

export const IbmCos = () => (
  <section>
    <p>
      IBM Cloud Object Storage via its S3-compatible API. A thin wrapper around
      the S3 adapter - endpoint derived from the region code (
      <code>us-south</code>, <code>us-east</code>, <code>eu-de</code>,{" "}
      <code>eu-gb</code>, <code>jp-tok</code>, <code>au-syd</code>,{" "}
      <code>br-sao</code>, <code>ca-tor</code>, …), virtual-hosted-style
      addressing, errors relabelled. Auth uses IBM Cloud's <em>HMAC</em>{" "}
      credentials (not IAM API keys) - tick "Include HMAC Credential" under
      Advanced options when creating the service credential. Auto-loads from{" "}
      <code>IBM_COS_ACCESS_KEY_ID</code> and{" "}
      <code>IBM_COS_SECRET_ACCESS_KEY</code>.
    </p>
    <CodeBlock code={IBM_COS_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>IBM COS bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            IBM Cloud region code - <code>us-south</code>, <code>us-east</code>,{" "}
            <code>eu-de</code>, <code>eu-gb</code>, <code>eu-es</code>,{" "}
            <code>jp-tok</code>, <code>jp-osa</code>, <code>au-syd</code>,{" "}
            <code>br-sao</code>, <code>ca-tor</code>. Drives the endpoint host (
            <code>{`s3.<region>.cloud-object-storage.appdomain.cloud`}</code>)
            and doubles as the SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            HMAC credentials - generate when creating the IBM COS service
            credential with Advanced options → "Include HMAC Credential" ticked.
            Distinct from IBM Cloud IAM API keys. Falls back to{" "}
            <code>IBM_COS_ACCESS_KEY_ID</code> and{" "}
            <code>IBM_COS_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to the public{" "}
            <code>
              {`https://s3.<region>.cloud-object-storage.appdomain.cloud`}
            </code>
            . For direct (no-egress) access from inside the same IBM Cloud
            region, pass{" "}
            <code>
              {`https://s3.direct.<region>.cloud-object-storage.appdomain.cloud`}
            </code>{" "}
            (or the equivalent <code>private</code> host).
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
            virtual-hosted is canonical for IBM COS.
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
            For buckets with a public access policy the natural value is{" "}
            <code>
              {`https://<bucket>.s3.<region>.cloud-object-storage.appdomain.cloud`}
            </code>
            ; a custom CNAME fronting the bucket also works. When unset,{" "}
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
