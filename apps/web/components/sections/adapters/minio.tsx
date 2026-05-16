import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const MINIO_EXAMPLE = `import { Files } from "files-sdk";
import { minio } from "files-sdk/minio";

const files = new Files({
  adapter: minio({
    bucket: "uploads",
    endpoint: "http://localhost:9000",
    // accessKeyId / secretAccessKey auto-loaded from
    // MINIO_ACCESS_KEY_ID / MINIO_SECRET_ACCESS_KEY
  }),
});`;

export const Minio = () => (
  <section>
    <p>
      MinIO and other self-hosted S3-compatible servers. A thin wrapper around
      the S3 adapter with MinIO-friendly defaults - path-style addressing on,
      region defaulted, errors relabelled. Auto-loads from{" "}
      <code>MINIO_ACCESS_KEY_ID</code> and <code>MINIO_SECRET_ACCESS_KEY</code>.
    </p>
    <CodeBlock code={MINIO_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>MinIO bucket name. The adapter scopes all operations to it.</p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="required" value="endpoint">
          <p>
            MinIO server URL, e.g. <code>http://localhost:9000</code>. Include
            the scheme - <code>http://</code> for local dev,{" "}
            <code>https://</code> in production.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>MINIO_ACCESS_KEY_ID</code>{" "}
            and <code>MINIO_SECRET_ACCESS_KEY</code>; required if those env vars
            aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            SigV4 region used for signing. Defaults to <code>us-east-1</code>.
            SigV4 requires some region in the signature, but MinIO ignores it
            for routing - leave the default unless you've configured per-region
            buckets.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="forcePathStyle"
          status="optional"
          value="forcePathStyle"
        >
          <p>
            Use path-style addressing (<code>/&lt;bucket&gt;/&lt;key&gt;</code>)
            rather than virtual-hosted style. Defaults to <code>true</code> for
            MinIO; flip off only if you've set up per-bucket subdomain routing
            in front of your server.
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
            Use this if you've fronted MinIO with a CDN or set a public bucket
            policy. When unset, <code>url()</code> returns a presigned GetObject
            (1-hour default).
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
  </section>
);
