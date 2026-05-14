import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const AZURE_EXAMPLE = `import { Files } from "files-sdk";
import { azure } from "files-sdk/azure";

const files = new Files({
  adapter: azure({
    container: "uploads",
    // Auto-loads from AZURE_STORAGE_CONNECTION_STRING, or
    // AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY.
    // Pass connectionString / accountKey / sasToken explicitly to override.
  }),
});`;

export const Azure = () => (
  <section>
    <Heading as="h2" id="adapter-azure">
      Azure Blob Storage
    </Heading>
    <p>
      Azure Blob Storage via the official <code>@azure/storage-blob</code> SDK.
      Four credential modes: connection string, account name + account key,
      account name + SAS token, or anonymous (public-read containers only).
      Connection-string parsing recovers the account name + key so signing
      methods keep working.
    </p>
    <CodeBlock code={AZURE_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-azure-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="container" status="required" value="container">
          <p>
            Azure container name. Surfaced as <code>adapter.bucket</code> for
            cross-adapter API consistency, even though Azure's own term is
            "container".
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="connectionString"
          status="optional"
          value="connectionString"
        >
          <p>
            Full Azure Storage connection string (
            <code>
              DefaultEndpointsProtocol=...;AccountName=...;AccountKey=...
            </code>
            ). Highest-precedence credential. Falls back to{" "}
            <code>AZURE_STORAGE_CONNECTION_STRING</code>. The adapter parses out
            the account name + key so signing methods keep working.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accountName"
          status="optional"
          value="accountName"
        >
          <p>
            Storage account name (e.g. <code>mystorageaccount</code>). Used with{" "}
            <code>accountKey</code>, <code>sasToken</code>, or anonymously.
            Falls back to <code>AZURE_STORAGE_ACCOUNT_NAME</code> then{" "}
            <code>AZURE_STORAGE_ACCOUNT</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accountKey"
          status="optional"
          value="accountKey"
        >
          <p>
            Shared-key (account key) for signing. Falls back to{" "}
            <code>AZURE_STORAGE_ACCOUNT_KEY</code> then{" "}
            <code>AZURE_STORAGE_KEY</code>. Required if you want{" "}
            <code>url()</code> or <code>signedUploadUrl()</code> to mint new SAS
            tokens - without it those methods throw.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="sasToken" status="optional" value="sasToken">
          <p>
            Pre-issued SAS token, with or without the leading <code>?</code>.
            Without an account key the signing methods throw -
            reads/writes/listing still work as long as the SAS grants those
            permissions.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="endpoint" status="optional" value="endpoint">
          <p>
            Override the service endpoint host. Defaults to{" "}
            <code>https://&lt;accountName&gt;.blob.core.windows.net</code>.
            Override for Azurite (
            <code>http://127.0.0.1:10000/devstoreaccount1</code>) or sovereign
            clouds (US Government, China).
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
            Use for a public-access container or a CDN (
            <code>*.azureedge.net</code>) in front of the account. When unset,{" "}
            <code>url()</code> returns a SAS read URL (1-hour default).
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-azure-limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> issues PUT-only - Azure SAS has no
        POST-policy equivalent. <code>maxSize</code> throws because Azure can't
        enforce upload caps at the URL level; enforce them at your application
        gateway. <code>copy()</code> uses <code>syncCopyFromURL</code>, which
        caps at 256 MB source size; larger blobs need{" "}
        <code>beginCopyFromURL</code> via <code>adapter.raw</code>.{" "}
        <code>@azure/identity</code> / Managed Identity is not supported in v1 -
        drop down to <code>adapter.raw</code> or wait for a future{" "}
        <code>client</code> option.
      </p>
    </div>
  </section>
);
