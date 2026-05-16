import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const FS_EXAMPLE = `import { Files } from "files-sdk";
import { fs } from "files-sdk/fs";

// Writes objects under \`./.uploads\` with a sidecar \`.meta.json\`
// per file for Content-Type, ETag, and user metadata. Designed for
// dev and CI - same Adapter contract as the cloud adapters, so swap
// it in via env without changing call sites.
const files = new Files({
  adapter: fs({
    root: "./.uploads",
    // Optional: configure if a dev server exposes the same root over
    // HTTP, so url() returns a browser-friendly URL instead of file://.
    // urlBaseUrl: "http://localhost:3000/files",
  }),
});`;

export const Fs = () => (
  <section>
    <p>
      Local filesystem. The dev/test adapter - point it at a directory and it
      implements the same <code>Adapter</code> contract as the cloud adapters
      using <code>node:fs/promises</code>. Each upload writes the body and a
      sidecar <code>.meta.json</code> file alongside it (Content-Type, ETag,
      user metadata) so reads round-trip cleanly. Not for production: there's no
      replication, no signing, no auth.
    </p>
    <CodeBlock code={FS_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="root" status="required" value="root">
          <p>
            Directory the adapter manages. Absolute or relative; created on
            first upload. All operations are scoped to this directory - keys
            that resolve outside it (e.g. <code>../etc/passwd</code>) throw{" "}
            <code>Provider</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="urlBaseUrl"
          status="optional"
          value="urlBaseUrl"
        >
          <p>
            Origin used to build URLs from <code>url()</code>. When set,{" "}
            <code>url(key)</code> returns{" "}
            <code>{`\`\${urlBaseUrl}/\${key}\``}</code> - useful when a dev
            server (Next.js <code>/public</code> mount,{" "}
            <code>serve-static</code>, etc.) is exposing the same{" "}
            <code>root</code>. When unset, <code>url()</code> returns a{" "}
            <code>file://</code> URL - fine for CLIs/tests, not browsers.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="defaultUrlExpiresIn"
          status="optional"
          value="defaultUrlExpiresIn"
        >
          <p>
            Default expiry, in seconds, threaded into the <code>?expires=</code>{" "}
            query string of <code>signedUploadUrl()</code> for parity with the
            cloud adapters. Defaults to 3600. The fs adapter does not enforce
            expiry itself; a dev upload-handler can validate the param.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="storage-layout">
        Storage layout
      </Heading>
      <p>
        Body at <code>{`\${root}/\${key}`}</code>; sidecar at{" "}
        <code>{`\${root}/\${key}.meta.json`}</code>. Sidecars survive{" "}
        <code>cp -r</code> / <code>git mv</code> / partial-tree deletion.{" "}
        <code>list()</code> hides them. ETag is a SHA-1-derived stable hash
        computed at upload time.
      </p>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> throws without <code>urlBaseUrl</code>-
        there's no upload server to sign against. <code>url()</code> throws on{" "}
        <code>responseContentDisposition</code> without <code>urlBaseUrl</code>:{" "}
        <code>file://</code> has no signature in which to bind the override.
        Files written by hand into <code>root</code> without a sidecar are still
        readable - <code>contentType</code> falls back to{" "}
        <code>application/octet-stream</code> and <code>etag</code> is absent.
      </p>
    </section>
  </section>
);
