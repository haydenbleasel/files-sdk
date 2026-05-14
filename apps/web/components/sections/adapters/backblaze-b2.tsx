import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const B2_EXAMPLE = `import { Files } from "files-sdk";
import { backblazeB2 } from "files-sdk/backblaze-b2";

const files = new Files({
  adapter: backblazeB2({
    bucket: "uploads",
    region: "us-west-002", // or "us-east-005", "eu-central-003", ...
    // accessKeyId / secretAccessKey auto-loaded from
    // B2_APPLICATION_KEY_ID / B2_APPLICATION_KEY
  }),
});`;

export const BackblazeB2 = () => (
  <section>
    <Heading as="h2" id="adapter-backblaze-b2">
      Backblaze B2
    </Heading>
    <p>
      Backblaze B2 via its S3-compatible API. A thin wrapper around the S3
      adapter - endpoint derived from the cluster code (<code>us-west-002</code>
      , <code>us-east-005</code>, <code>eu-central-003</code>, …),
      virtual-hosted-style addressing, errors relabelled. Auto-loads from{" "}
      <code>B2_APPLICATION_KEY_ID</code> and <code>B2_APPLICATION_KEY</code>.
      Generate an application key in the Backblaze console under Account →
      Application Keys; the bucket's cluster is shown next to its endpoint.
    </p>
    <CodeBlock code={B2_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-backblaze-b2-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>B2 bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            B2 cluster code - <code>us-west-000</code>, <code>us-west-001</code>
            , <code>us-west-002</code>, <code>us-east-004</code>,{" "}
            <code>us-east-005</code>, <code>eu-central-003</code>, etc. Drives
            the endpoint host (<code>{`s3.<region>.backblazeb2.com`}</code>) and
            doubles as the SigV4 region. Each bucket lives in exactly one
            cluster - pick the wrong one and B2 responds with a <code>301</code>{" "}
            redirect. No env-var fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials - B2 application key ID and key. Falls back to{" "}
            <code>B2_APPLICATION_KEY_ID</code> and{" "}
            <code>B2_APPLICATION_KEY</code>; required if those env vars aren't
            set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the default endpoint. When unset, defaults to{" "}
            <code>{`https://s3.<region>.backblazeb2.com`}</code>. Useful behind
            a custom proxy or for non-default deployments.
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
            virtual-hosted is canonical for B2.
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
            For public buckets the natural value is B2's friendly download URL
            prefix (
            <code>{`https://f<NNN>.backblazeb2.com/file/<bucket>`}</code>, shown
            in the B2 console under your bucket → Endpoint), or a custom domain
            proxied through Cloudflare. When unset, <code>url()</code> returns a
            presigned GetObject (1-hour default).
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
