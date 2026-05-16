import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const NETLIFY_BLOBS_EXAMPLE = `import { Files } from "files-sdk";
import { netlifyBlobs } from "files-sdk/netlify-blobs";

// On Netlify Functions / Edge / build runtimes, siteID + token are
// auto-detected from NETLIFY_BLOBS_CONTEXT - pass them explicitly only
// when running outside Netlify (e.g. local scripts, your own server).
const files = new Files({
  adapter: netlifyBlobs({
    name: "uploads",
    // siteID: process.env.NETLIFY_SITE_ID,
    // token: process.env.NETLIFY_API_TOKEN,
    // deployScoped: false,           // true uses getDeployStore()
    // consistency: "eventual",       // or "strong"
  }),
});`;

export const NetlifyBlobs = () => (
  <section>
    <p>
      Netlify Blobs via the official <code>@netlify/blobs</code> SDK. On Netlify
      runtimes (Functions, Edge Functions, build steps), <code>siteID</code> and{" "}
      <code>token</code> are auto-detected from{" "}
      <code>NETLIFY_BLOBS_CONTEXT</code> - pass them explicitly only when
      running outside Netlify. Falls back to <code>NETLIFY_SITE_ID</code> +{" "}
      <code>NETLIFY_API_TOKEN</code> (or <code>NETLIFY_BLOBS_TOKEN</code>) from
      env.
    </p>
    <CodeBlock code={NETLIFY_BLOBS_EXAMPLE} lang="ts" />
    <p>
      Netlify Blobs has no native size, content-type, or last-modified fields,
      so the adapter packs them - plus <code>cacheControl</code> and user{" "}
      <code>metadata</code> - into Netlify's metadata map at upload time.{" "}
      <code>head()</code> and <code>download()</code> read them back, so the
      unified <code>StoredFile</code> shape works the same as on the cloud
      adapters.
    </p>
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="name" status="required" value="name">
          <p>
            Store name. Netlify keys data per store; the adapter scopes every
            operation to it. Max 64 bytes per Netlify's limits.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="siteID" status="optional" value="siteID">
          <p>
            Netlify site ID. Falls back to <code>NETLIFY_SITE_ID</code>.
            Auto-detected from the runtime context on Netlify - only required
            outside Netlify.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="token" status="optional" value="token">
          <p>
            Netlify access token. Falls back to <code>NETLIFY_API_TOKEN</code>{" "}
            then <code>NETLIFY_BLOBS_TOKEN</code>. Auto-detected from the
            runtime context on Netlify - only required outside Netlify.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="deployScoped"
          status="optional"
          value="deployScoped"
        >
          <p>
            When <code>true</code>, uses <code>getDeployStore()</code> - the
            store is tied to the current deploy and garbage-collected when the
            deploy is removed. Defaults to <code>false</code> (site-scoped,
            persists across deploys), which is the right choice for almost
            everything.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="consistency"
          status="optional"
          value="consistency"
        >
          <p>
            Read consistency mode. <code>"eventual"</code> (default) reads from
            the edge cache and is faster; <code>"strong"</code> reads from the
            origin and guarantees read-your-writes.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>url()</code> throws - Netlify Blobs has no public URL primitive;
        reads always go through the SDK with the token. Use{" "}
        <code>download()</code> instead. <code>signedUploadUrl()</code> throws -
        there is no presigned upload primitive; uploads must go through the SDK
        or be proxied by your application.
      </p>
      <p>
        <code>copy()</code> is a read-then-write - Netlify has no server-side
        copy primitive, so the source is fetched and re-written at the
        destination. Not server-side atomic. <code>list()</code> only carries
        key + etag from Netlify; size, content type, and last-modified come from
        a follow-up <code>head()</code> per item, so list entries return{" "}
        <code>size: 0</code> and <code>type: "application/octet-stream"</code>{" "}
        by default. The unified <code>cursor</code> is not honoured because
        Netlify's pagination cursor is internal to the SDK, but the adapter
        iterates the SDK's paginated form and stops once <code>limit</code> is
        satisfied - so <code>limit</code> does bound server-side I/O. Stream
        uploads are buffered up-front because Netlify's <code>set()</code> has
        no streaming form.
      </p>
    </section>
  </section>
);
