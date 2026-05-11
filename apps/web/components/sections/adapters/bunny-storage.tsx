import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const BUNNY_STORAGE_EXAMPLE = `import { Files } from "files-sdk";
import { bunnyStorage } from "files-sdk/bunny-storage";

const files = new Files({
  adapter: bunnyStorage({
    zone: "uploads",
    region: "de",
    // accessKey auto-loaded from BUNNY_STORAGE_ACCESS_KEY
    // publicBaseUrl: "https://files.example.com",
  }),
});`;

export const BunnyStorage = () => (
  <section>
    <Heading as="h3" id="adapter-bunny-storage">
      Bunny Storage
    </Heading>
    <p>
      Bunny Storage via the official <code>@bunny.net/storage-sdk</code>. The
      adapter connects to a Storage Zone with its zone password / API access key
      and uses Bunny's HTTP Storage API for reads, writes, listing, and deletes.
      Auto-loads from <code>BUNNY_STORAGE_ZONE</code>,{" "}
      <code>BUNNY_STORAGE_ACCESS_KEY</code>, and{" "}
      <code>BUNNY_STORAGE_REGION</code>, with the SDK's{" "}
      <code>STORAGE_ZONE</code>, <code>STORAGE_ACCESS_KEY</code>, and{" "}
      <code>STORAGE_REGION</code> names as aliases.
    </p>
    <CodeBlock code={BUNNY_STORAGE_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h4" id="adapter-bunny-storage-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="zone" status="required" value="zone">
          <p>
            Bunny Storage Zone name. Falls back to{" "}
            <code>BUNNY_STORAGE_ZONE</code>, then <code>STORAGE_ZONE</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="accessKey" status="required" value="accessKey">
          <p>
            Storage Zone password / API access key. Falls back to{" "}
            <code>BUNNY_STORAGE_ACCESS_KEY</code>, <code>BUNNY_ACCESS_KEY</code>
            , then <code>STORAGE_ACCESS_KEY</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="region" status="required" value="region">
          <p>
            Primary Storage Zone region, e.g. <code>"de"</code>,{" "}
            <code>"ny"</code>, or <code>"syd"</code>. You can also pass{" "}
            <code>BunnyStorageSDK.regions.StorageRegion.Falkenstein</code>.
            Falls back to <code>BUNNY_STORAGE_REGION</code>, then{" "}
            <code>STORAGE_REGION</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Existing connected storage zone from{" "}
            <code>@bunny.net/storage-sdk</code>. When passed, the adapter uses
            it directly and ignores <code>zone</code>, <code>accessKey</code>,
            and <code>region</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicBaseUrl"
          status="optional"
          value="publicBaseUrl"
        >
          <p>
            Public origin used by <code>url()</code>, usually a Bunny Pull Zone
            or custom CDN hostname in front of the Storage Zone. When set,{" "}
            <code>url(key)</code> returns{" "}
            <code>{`\`\${publicBaseUrl}/\${key}\``}</code>. When unset,{" "}
            <code>url()</code> throws because the Storage API URL requires an{" "}
            <code>AccessKey</code> header.
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
    <div className="flex flex-col gap-2">
      <Heading as="h4" id="adapter-bunny-storage-limitations">
        Limitations
      </Heading>
      <p>
        <code>copy()</code> is a read-then-write because Bunny Storage has no
        server-side copy primitive in the TypeScript SDK; it is not atomic.{" "}
        <code>signedUploadUrl()</code> throws because Bunny Storage has no
        presigned upload primitive. <code>url()</code> requires{" "}
        <code>publicBaseUrl</code> and returns a permanent CDN URL;{" "}
        <code>expiresIn</code> is ignored and{" "}
        <code>responseContentDisposition</code> throws because there is no
        signature where that override can be bound. Custom <code>metadata</code>{" "}
        and <code>cacheControl</code> on upload are not supported by the Storage
        SDK.
      </p>
    </div>
  </section>
);
