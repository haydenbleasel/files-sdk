import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const WASABI_EXAMPLE = `import { Files } from "files-sdk";
import { wasabi } from "files-sdk/wasabi";

const files = new Files({
  adapter: wasabi({
    bucket: "uploads",
    region: "us-east-1", // or "eu-central-1", "ap-northeast-1", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // WASABI_ACCESS_KEY_ID / WASABI_SECRET_ACCESS_KEY
  }),
});`;

export const Wasabi = () => (
  <section>
    <Heading as="h2" id="adapter-wasabi">
      Wasabi
    </Heading>
    <p>
      Wasabi Hot Cloud Storage via its S3-compatible API. A thin wrapper around
      the S3 adapter - endpoint derived from the region code (
      <code>us-east-1</code>, <code>eu-central-1</code>,{" "}
      <code>ap-northeast-1</code>, …), virtual-hosted-style addressing, errors
      relabelled. Region names mirror AWS but the endpoints are Wasabi's own.
      Auto-loads from <code>WASABI_ACCESS_KEY_ID</code> and{" "}
      <code>WASABI_SECRET_ACCESS_KEY</code>. Generate access keys in the Wasabi
      console under Access Keys.
    </p>
    <CodeBlock code={WASABI_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-wasabi-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Wasabi bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Wasabi storage region - <code>us-east-1</code>,{" "}
            <code>us-east-2</code>, <code>us-central-1</code>,{" "}
            <code>us-west-1</code>, <code>ca-central-1</code>,{" "}
            <code>eu-central-1</code>, <code>eu-central-2</code>,{" "}
            <code>eu-west-1</code>, <code>eu-west-2</code>,{" "}
            <code>ap-northeast-1</code>, <code>ap-northeast-2</code>,{" "}
            <code>ap-southeast-1</code>, <code>ap-southeast-2</code>. Drives the
            endpoint host (<code>{`s3.<region>.wasabisys.com`}</code>) and
            doubles as the SigV4 region. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>WASABI_ACCESS_KEY_ID</code>{" "}
            and <code>WASABI_SECRET_ACCESS_KEY</code>; required if those env
            vars aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://s3.<region>.wasabisys.com`}</code>. Useful behind a
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
            virtual-hosted is canonical for Wasabi.
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
            For buckets with a public read policy the natural value is{" "}
            <code>{`https://<bucket>.s3.<region>.wasabisys.com`}</code>; a
            custom CNAME fronting the bucket also works. Wasabi has no built-in
            CDN, so leaving this unset is the common case. When unset,{" "}
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
