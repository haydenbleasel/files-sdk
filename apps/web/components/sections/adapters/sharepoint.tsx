import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const SHAREPOINT_EXAMPLE = `import { Files } from "files-sdk";
import { sharepoint } from "files-sdk/sharepoint";

const files = new Files({
  adapter: sharepoint({
    siteUrl: "https://contoso.sharepoint.com/sites/marketing",
    documentLibrary: "Reports", // optional, omit for default library
    clientCredentials: {
      tenantId: process.env.SHAREPOINT_TENANT_ID!,
      clientId: process.env.SHAREPOINT_CLIENT_ID!,
      clientSecret: process.env.SHAREPOINT_CLIENT_SECRET!,
    },
    rootFolderPath: "Uploads",
  }),
});`;

export const Sharepoint = () => (
  <section>
    <p>
      SharePoint document libraries via Microsoft Graph. Wraps the{" "}
      <code>onedrive</code> adapter and adds SharePoint-shaped resolution —{" "}
      <code>siteUrl</code> parsing, named <code>documentLibrary</code> lookup,
      and <code>SHAREPOINT_*</code> env-var fallbacks. Resolution is lazy: the
      first method call triggers Graph traffic to convert names into drive IDs,
      then subsequent calls reuse the resolved drive.
    </p>
    <CodeBlock code={SHAREPOINT_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="siteUrl" status="optional" value="siteUrl">
          <p>
            SharePoint site URL (e.g.{" "}
            <code>https://contoso.sharepoint.com/sites/marketing</code>).
            Resolved to a site ID via Graph{" "}
            <code>
              GET /sites/{"{hostname}"}:/{"{path}"}
            </code>
            . Falls back to <code>SHAREPOINT_SITE_URL</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="siteId" status="optional" value="siteId">
          <p>
            Direct SharePoint site ID (the Graph triple{" "}
            <code>{"<host>,<id1>,<id2>"}</code>). Skips URL/hostname resolution.
            Falls back to <code>SHAREPOINT_SITE_ID</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="hostname" status="optional" value="hostname">
          <p>
            SharePoint hostname (e.g. <code>contoso.sharepoint.com</code>) for
            sites with no path component. Combine with <code>sitePath</code> for
            sub-sites. Falls back to <code>SHAREPOINT_HOSTNAME</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="sitePath" status="optional" value="sitePath">
          <p>
            Site path on the hostname (e.g. <code>/sites/marketing</code>). Used
            with <code>hostname</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="documentLibrary"
          status="optional"
          value="documentLibrary"
        >
          <p>
            Name of the SharePoint document library to target (e.g.{" "}
            <code>Documents</code>, <code>Reports</code>). Resolved to a drive
            ID via <code>GET /sites/{"{siteId}"}/drives</code>. Omit to use the
            site&apos;s default library. Falls back to{" "}
            <code>SHAREPOINT_DOCUMENT_LIBRARY</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="driveId" status="optional" value="driveId">
          <p>
            Explicit drive ID. Skips both site and library resolution entirely.
            Falls back to <code>SHAREPOINT_DRIVE_ID</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="clientCredentials"
          status="optional"
          value="clientCredentials"
        >
          <p>
            App-only (client credentials) auth -{" "}
            <code>{"{ tenantId, clientId, clientSecret }"}</code>. Same shape as{" "}
            <code>onedrive()</code>. Falls back to{" "}
            <code>SHAREPOINT_TENANT_ID</code> +{" "}
            <code>SHAREPOINT_CLIENT_ID</code> +{" "}
            <code>SHAREPOINT_CLIENT_SECRET</code>, then to the{" "}
            <code>ONEDRIVE_*</code> equivalents.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="oauth" status="optional" value="oauth">
          <p>
            Delegated OAuth refresh-token auth. Same shape as{" "}
            <code>onedrive()</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessToken"
          status="optional"
          value="accessToken"
        >
          <p>
            Static or dynamic access token. Falls back to{" "}
            <code>SHAREPOINT_ACCESS_TOKEN</code> then{" "}
            <code>ONEDRIVE_ACCESS_TOKEN</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Pre-built <code>@microsoft/microsoft-graph-client</code>{" "}
            <code>Client</code>. Same escape hatch as <code>onedrive()</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="rootFolderPath"
          status="optional"
          value="rootFolderPath"
        >
          <p>
            Logical &quot;bucket root&quot; - virtual keys live under this
            folder path within the document library. Must already exist on the
            drive.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicByDefault"
          status="optional"
          value="publicByDefault"
        >
          <p>
            When <code>true</code>, <code>upload()</code> also creates an
            anonymous-view sharing link and <code>url()</code> returns it.
            Subject to tenant link-sharing policy.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="copyTimeoutMs"
          status="optional"
          value="copyTimeoutMs"
        >
          <p>
            Maximum time (ms) to wait for an async copy operation. Defaults to{" "}
            <code>60_000</code>.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        The SharePoint adapter delegates to <code>onedrive</code> after
        resolution, so every OneDrive limitation applies: <code>url()</code>{" "}
        throws without <code>publicByDefault: true</code>;{" "}
        <code>signedUploadUrl()</code> initiates a chunked upload session (not a
        single-PUT presigned URL); <code>upload()</code> is capped at the 250 MB
        simple-upload limit; <code>delete()</code> moves items to the recycle
        bin (soft delete); <code>copy()</code> is async; user{" "}
        <code>cacheControl</code> and <code>metadata</code> on{" "}
        <code>upload()</code> throw; <code>list()</code> is non-recursive.{" "}
        SharePoint-specific: <code>siteUrl</code> parsing errors and missing{" "}
        <code>documentLibrary</code> names throw <code>Provider</code> at first
        call (resolution is lazy, so construction never fails for these).
        Resolution makes 1-2 extra Graph round-trips on first use; the result is
        cached for the adapter&apos;s lifetime.
      </p>
    </section>
  </section>
);
