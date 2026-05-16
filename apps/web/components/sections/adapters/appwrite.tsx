import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const APPWRITE_EXAMPLE = `import { Files } from "files-sdk";
import { appwrite } from "files-sdk/appwrite";

const files = new Files({
  adapter: appwrite({
    bucket: "uploads",
    // Auto-loads from APPWRITE_ENDPOINT, APPWRITE_PROJECT_ID,
    // and APPWRITE_API_KEY. Or pass an existing node-appwrite
    // Client or Storage instance via \`client\`.
    //
    // Note: Appwrite keys (IDs) must be alphanumeric/dashes
    // and max 36 chars. Slashes (/) are not supported.
  }),
});`;

export const Appwrite = () => (
  <section>
    <p>
      Appwrite Storage. Uses the official Node.js SDK under the hood. Supports
      auto-loading configuration from environment variables.
    </p>
    <CodeBlock code={APPWRITE_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>Appwrite storage bucket ID.</p>
        </PropAccordionItem>
        <PropAccordionItem name="projectId" status="optional" value="projectId">
          <p>
            Appwrite project ID. Falls back to <code>APPWRITE_PROJECT_ID</code>{" "}
            then <code>NEXT_PUBLIC_APPWRITE_PROJECT_ID</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Appwrite API endpoint. Defaults to{" "}
            <code>https://cloud.appwrite.io/v1</code>. Falls back to{" "}
            <code>APPWRITE_ENDPOINT</code> then{" "}
            <code>NEXT_PUBLIC_APPWRITE_ENDPOINT</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="key" status="optional" value="key">
          <p>
            Appwrite API key. Falls back to <code>APPWRITE_API_KEY</code> then{" "}
            <code>APPWRITE_KEY</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Existing <code>Client</code> or <code>Storage</code> instance from{" "}
            <code>node-appwrite</code>. When passed, it takes precedence over{" "}
            <code>endpoint</code>, <code>projectId</code>, and <code>key</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="public" status="optional" value="public">
          <p>
            Treat the bucket as public. When <code>true</code>,{" "}
            <code>url()</code> returns a constructed permanent public URL. When{" "}
            <code>false</code> (default), <code>url()</code> throws.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> throws — Appwrite does not support
        S3-style presigned upload URLs. <code>url()</code> throws by default
        (Appwrite cannot mint presigned read URLs with API keys); set{" "}
        <code>public: true</code> for public buckets. <code>copy()</code> is
        read-then-write (no native server-side copy). File IDs (keys) must start
        with an alphanumeric and use only <code>[a-zA-Z0-9._-]</code>, max 36
        characters (no slashes) — invalid keys are rejected before the API call.{" "}
        <code>UploadOptions</code> <code>cacheControl</code> and{" "}
        <code>metadata</code> throw — Appwrite&apos;s <code>createFile</code>{" "}
        has no equivalent fields. <code>contentType</code> is silently ignored —
        Appwrite auto-detects mime from the payload and exposes no override.{" "}
        <code>list(&#123; prefix &#125;)</code> queries{" "}
        <code>startsWith(&quot;$id&quot;, ...)</code> against the canonical file
        ID; files created outside the adapter where the display{" "}
        <code>name</code> differs from <code>$id</code> won&apos;t be matched by
        prefix.
      </p>
    </section>
  </section>
);
