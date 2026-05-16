import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const STORJ_EXAMPLE = `import { Files } from "files-sdk";
import { storj } from "files-sdk/storj";

const files = new Files({
  adapter: storj({
    bucket: "uploads",
    // endpoint defaults to https://gateway.storjshare.io (Gateway MT).
    // Pass a self-hosted Gateway ST URL to override.
    // accessKeyId / secretAccessKey auto-loaded from
    // STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY
  }),
});`;

export const Storj = () => (
  <section>
    <p>
      Storj DCS via its S3-compatible Gateway. A thin wrapper around the S3
      adapter - endpoint defaults to Storj's hosted Gateway MT, path-style
      addressing on, errors relabelled. Auto-loads from{" "}
      <code>STORJ_ACCESS_KEY_ID</code> and <code>STORJ_SECRET_ACCESS_KEY</code>.
      Generate access keys in the Storj console or with{" "}
      <code>uplink share --register</code>.
    </p>
    <CodeBlock code={STORJ_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Storj bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>STORJ_ACCESS_KEY_ID</code>{" "}
            and <code>STORJ_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set. These are S3-style gateway keys, not your Storj access
            grant - the gateway translates them server-side.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Storj S3 gateway URL. Defaults to{" "}
            <code>https://gateway.storjshare.io</code> (Gateway MT - the hosted
            multi-tenant gateway, what most users want). Override with your own
            URL if you self-host Gateway ST.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            SigV4 region used for signing. Defaults to <code>us-east-1</code>.
            SigV4 requires some region in the signature; the Storj gateway
            ignores it for routing, so leave the default unless you have a
            reason to change it.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="forcePathStyle"
          status="optional"
          value="forcePathStyle"
        >
          <p>
            Use path-style addressing (<code>/&lt;bucket&gt;/&lt;key&gt;</code>
            ). Defaults to <code>true</code> for Storj - the gateway routes
            path-style. Flip off only if you've fronted the gateway with
            subdomain routing.
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
            For Storj, the natural value is a linksharing prefix like{" "}
            <code>{`https://link.storjshare.io/raw/<accessGrant>/<bucket>`}</code>{" "}
            - generate one with <code>uplink share --url</code>. When unset,{" "}
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
