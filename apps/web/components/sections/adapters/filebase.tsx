import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const FILEBASE_EXAMPLE = `import { Files } from "files-sdk";
import { filebase } from "files-sdk/filebase";

const files = new Files({
  adapter: filebase({
    bucket: "uploads",
    // accessKeyId / secretAccessKey auto-loaded from
    // FILEBASE_ACCESS_KEY_ID / FILEBASE_SECRET_ACCESS_KEY
  }),
});`;

export const Filebase = () => (
  <section>
    <Heading as="h2" id="adapter-filebase">
      Filebase
    </Heading>
    <p>
      Filebase via its S3-compatible API. Filebase fronts decentralized storage
      networks (IPFS, Sia, Storj) behind a standard S3 gateway - the network is
      chosen per-bucket in the dashboard, not per-request. A thin wrapper around
      the S3 adapter pointed at <code>https://s3.filebase.com</code>, with
      errors relabelled. Auto-loads from <code>FILEBASE_ACCESS_KEY_ID</code> and{" "}
      <code>FILEBASE_SECRET_ACCESS_KEY</code>. Generate access keys in the
      Filebase console under Access Keys.
    </p>
    <CodeBlock code={FILEBASE_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-filebase-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Filebase bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to{" "}
            <code>FILEBASE_ACCESS_KEY_ID</code> and{" "}
            <code>FILEBASE_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the Filebase endpoint. When unset, defaults to{" "}
            <code>https://s3.filebase.com</code> - Filebase runs a single global
            S3 gateway.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            SigV4 region used for signing. Defaults to <code>us-east-1</code>.
            Filebase ignores it for routing - leave the default.
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
            Filebase supports virtual-hosted style on{" "}
            <code>{`<bucket>.s3.filebase.com`}</code>.
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
            Filebase serves public objects via per-network gateways (e.g. an
            IPFS CID gateway) - point this at the gateway URL the dashboard
            exposes for your bucket. When unset, <code>url()</code> returns a
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
