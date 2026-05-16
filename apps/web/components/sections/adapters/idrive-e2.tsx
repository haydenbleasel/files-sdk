import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const IDRIVE_E2_EXAMPLE = `import { Files } from "files-sdk";
import { idriveE2 } from "files-sdk/idrive-e2";

const files = new Files({
  adapter: idriveE2({
    bucket: "uploads",
    endpoint: "https://q9z7.va.idrivee2-NN.com",
    // accessKeyId / secretAccessKey auto-loaded from
    // IDRIVE_E2_ACCESS_KEY_ID / IDRIVE_E2_SECRET_ACCESS_KEY
  }),
});`;

export const IdriveE2 = () => (
  <section>
    <p>
      iDrive e2 via its S3-compatible API. A thin wrapper around the S3 adapter
      with iDrive-friendly defaults - endpoint is required (iDrive e2 hostnames
      are tied to the cluster your bucket lives in and don't follow a public
      pattern; copy it from the iDrive e2 dashboard), region defaulted, errors
      relabelled. Auto-loads from <code>IDRIVE_E2_ACCESS_KEY_ID</code> and{" "}
      <code>IDRIVE_E2_SECRET_ACCESS_KEY</code>. Generate access keys in the
      iDrive e2 dashboard under Access Keys.
    </p>
    <CodeBlock code={IDRIVE_E2_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>iDrive e2 bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="required" value="endpoint">
          <p>
            iDrive e2 endpoint URL, e.g.{" "}
            <code>https://q9z7.va.idrivee2-NN.com</code>. Each iDrive e2 region
            uses a unique hostname assigned at provisioning - look it up in the
            iDrive e2 dashboard under Access Keys → Endpoint.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to{" "}
            <code>IDRIVE_E2_ACCESS_KEY_ID</code> and{" "}
            <code>IDRIVE_E2_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            SigV4 region used for signing. Defaults to <code>us-east-1</code>.
            iDrive e2 ignores it for routing (the endpoint host carries that
            information), but the SigV4 signature still needs some value.
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
            iDrive e2 supports virtual-hosted style on the bucket subdomain.
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
            iDrive e2 has no built-in CDN, so this is typically a custom CNAME
            or reverse proxy fronting the bucket. When unset, <code>url()</code>{" "}
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
    </section>
  </section>
);
