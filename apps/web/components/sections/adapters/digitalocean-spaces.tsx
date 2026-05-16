import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const DIGITALOCEAN_SPACES_EXAMPLE = `import { Files } from "files-sdk";
import { digitaloceanSpaces } from "files-sdk/digitalocean-spaces";

const files = new Files({
  adapter: digitaloceanSpaces({
    bucket: "uploads",
    region: "nyc3",
    // accessKeyId / secretAccessKey auto-loaded from
    // DO_SPACES_KEY / DO_SPACES_SECRET
  }),
});`;

export const DigitalOceanSpaces = () => (
  <section>
    <p>
      DigitalOcean Spaces via the S3-compatible API. A thin wrapper around the
      S3 adapter - endpoint derived from the region you pass, errors relabelled,
      virtual-hosted addressing left as the default. Auto-loads from{" "}
      <code>DO_SPACES_KEY</code> and <code>DO_SPACES_SECRET</code>.
    </p>
    <CodeBlock code={DIGITALOCEAN_SPACES_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Spaces name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Spaces datacenter region - e.g. <code>nyc3</code>, <code>sfo3</code>
            , <code>ams3</code>, <code>fra1</code>, <code>sgp1</code>,{" "}
            <code>syd1</code>, <code>blr1</code>, <code>tor1</code>,{" "}
            <code>lon1</code>. Drives the endpoint host; there's no env-var
            fallback.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>DO_SPACES_KEY</code> and{" "}
            <code>DO_SPACES_SECRET</code>; required if those env vars aren't
            set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the Spaces endpoint. Defaults to{" "}
            <code>{`https://\${region}.digitaloceanspaces.com`}</code>. Spaces
            routes by Host header - the SDK prepends the bucket subdomain for
            virtual-hosted style.
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
            virtual-hosted (
            <code>{`<bucket>.<region>.digitaloceanspaces.com`}</code>) is the
            canonical Spaces routing.
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
            Typical values are the Spaces CDN host (
            <code>{`https://<bucket>.<region>.cdn.digitaloceanspaces.com`}</code>
            ) or a custom CNAME you've bound to the Space. When unset,{" "}
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
