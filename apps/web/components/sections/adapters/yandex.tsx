import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const YANDEX_EXAMPLE = `import { Files } from "files-sdk";
import { yandex } from "files-sdk/yandex";

const files = new Files({
  adapter: yandex({
    bucket: "uploads",
    // endpoint defaults to https://storage.yandexcloud.net
    // region defaults to "ru-central1"
    // accessKeyId / secretAccessKey auto-loaded from
    // YANDEX_ACCESS_KEY_ID / YANDEX_SECRET_ACCESS_KEY
  }),
});`;

export const Yandex = () => (
  <section>
    <p>
      Yandex Object Storage via its S3-compatible API. A thin wrapper around the
      S3 adapter - fixed global endpoint, region defaults to{" "}
      <code>"ru-central1"</code> for signing, virtual-hosted-style addressing,
      errors relabelled. Auto-loads from <code>YANDEX_ACCESS_KEY_ID</code> and{" "}
      <code>YANDEX_SECRET_ACCESS_KEY</code>. Generate static access keys in the
      Yandex Cloud console for a service account with the{" "}
      <code>storage.editor</code> role.
    </p>
    <CodeBlock code={YANDEX_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="bucket" status="required" value="bucket">
          <p>
            Yandex Object Storage bucket name. The adapter scopes all operations
            to it.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessKeyId / secretAccessKey"
          status="required"
          value="accessKeyId"
        >
          <p>
            Static credentials. Falls back to <code>YANDEX_ACCESS_KEY_ID</code>{" "}
            and <code>YANDEX_SECRET_ACCESS_KEY</code>; required if those env
            vars aren't set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Yandex Object Storage endpoint. Defaults to{" "}
            <code>https://storage.yandexcloud.net</code> - Yandex serves a
            single global endpoint and routes internally. Override for a private
            deployment or proxy.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="optional" value="region">
          <p>
            SigV4 region used for signing. Defaults to{" "}
            <code>"ru-central1"</code> - Yandex's only public region today. The
            value is required by the signature but doesn't drive routing. Leave
            the default unless you have a reason to change it.
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
            virtual-hosted is canonical for Yandex Object Storage.
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
            For public buckets the natural value is{" "}
            <code>{`https://<bucket>.storage.yandexcloud.net`}</code>; a custom
            domain bound to the bucket also works. When unset,{" "}
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
