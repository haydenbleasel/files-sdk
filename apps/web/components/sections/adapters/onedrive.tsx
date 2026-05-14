import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const ONEDRIVE_EXAMPLE = `import { Files } from "files-sdk";
import { onedrive } from "files-sdk/onedrive";

// App-only auth (client credentials) into a SharePoint site library.
// Cannot use /me/drive - pass driveId, siteId, or userId instead.
const files = new Files({
  adapter: onedrive({
    clientCredentials: {
      tenantId: process.env.ONEDRIVE_TENANT_ID!,
      clientId: process.env.ONEDRIVE_CLIENT_ID!,
      clientSecret: process.env.ONEDRIVE_CLIENT_SECRET!,
    },
    siteId: process.env.ONEDRIVE_SITE_ID!,
    rootFolderPath: "Uploads",
    // publicByDefault: true → upload() also creates an anonymous-view
    //                       sharing link and url() returns its webUrl.
  }),
});`;

export const Onedrive = () => (
  <section>
    <Heading as="h2" id="adapter-onedrive">
      OneDrive
    </Heading>
    <p>
      OneDrive and SharePoint document libraries via the official{" "}
      <code>@microsoft/microsoft-graph-client</code> SDK. Microsoft Graph is
      path-addressable (<code>/drive/root:/folder/file.txt</code>), so the
      adapter maps virtual keys onto real OneDrive paths - no virtual-key cache,
      no <code>fsdkKey</code> bookkeeping. Five auth shapes (app-only, OAuth
      refresh token, raw access token, pre-built Graph client, or env-var
      fallback) and four drive targets (<code>/me/drive</code>,{" "}
      <code>driveId</code>, <code>siteId</code>, <code>userId</code>) cover the
      personal-OneDrive, OneDrive-for-Business, and SharePoint-site-library
      cases.
    </p>
    <CodeBlock code={ONEDRIVE_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-onedrive-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem
          name="clientCredentials"
          status="optional"
          value="clientCredentials"
        >
          <p>
            App-only (client credentials) auth -{" "}
            <code>{"{ tenantId, clientId, clientSecret }"}</code>. Required for
            unattended SharePoint or OneDrive-for-Business access; the app acts
            on its own behalf. Cannot target <code>/me/drive</code> - pass{" "}
            <code>driveId</code>, <code>siteId</code>, or <code>userId</code> to
            specify the drive. Falls back to the <code>ONEDRIVE_TENANT_ID</code>{" "}
            + <code>ONEDRIVE_CLIENT_ID</code> +{" "}
            <code>ONEDRIVE_CLIENT_SECRET</code> environment variables.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="oauth" status="optional" value="oauth">
          <p>
            Delegated (3-legged) auth via OAuth refresh token -{" "}
            <code>{"{ clientId, clientSecret, refreshToken, tenantId? }"}</code>
            . The adapter mints fresh access tokens against the tenant's token
            endpoint (<code>tenantId</code> defaults to <code>"common"</code>)
            and caches them until just before expiry.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessToken"
          status="optional"
          value="accessToken"
        >
          <p>
            Static or dynamic access token - a string for one-shot tokens, or an
            async function for callers minting tokens themselves (
            <code>@azure/identity</code>, NextAuth, custom brokers). The adapter
            does not cache; your callable owns refresh. Falls back to the{" "}
            <code>ONEDRIVE_ACCESS_TOKEN</code> environment variable (string form
            only).
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Pre-built <code>@microsoft/microsoft-graph-client</code>{" "}
            <code>Client</code> - escape hatch when you've wired auth and
            middleware yourself. Unlike Google Drive's escape hatch,{" "}
            <code>signedUploadUrl()</code> still works because Graph's upload
            session URL is pre-authenticated by Graph itself, no auth handle
            required.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="driveId" status="optional" value="driveId">
          <p>
            Target a specific drive by id (<code>/drives/{"{driveId}"}</code>
            ). Works with any auth shape and is required for{" "}
            <code>clientCredentials</code> since <code>/me/drive</code> needs an
            interactive user. Mutually exclusive with <code>siteId</code> /{" "}
            <code>userId</code>. Falls back to the{" "}
            <code>ONEDRIVE_DRIVE_ID</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="siteId" status="optional" value="siteId">
          <p>
            Target the default document library of a SharePoint site (
            <code>/sites/{"{siteId}"}/drive</code>). Mutually exclusive with{" "}
            <code>driveId</code> / <code>userId</code>. Falls back to the{" "}
            <code>ONEDRIVE_SITE_ID</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="userId" status="optional" value="userId">
          <p>
            Target a specific user's drive (
            <code>/users/{"{userId}"}/drive</code>). Typical with app-only auth.
            Mutually exclusive with <code>driveId</code> / <code>siteId</code>.
            Falls back to the <code>ONEDRIVE_USER_ID</code> environment
            variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="rootFolderPath"
          status="optional"
          value="rootFolderPath"
        >
          <p>
            Logical "bucket root" - virtual keys live under this folder path
            (which must already exist on the drive). Defaults to the drive root.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicByDefault"
          status="optional"
          value="publicByDefault"
        >
          <p>
            When <code>true</code>, <code>upload()</code> also calls{" "}
            <code>createLink</code> with anonymous-view scope and{" "}
            <code>url()</code> returns the link's <code>webUrl</code>. When{" "}
            <code>false</code> (default), <code>url()</code> throws - Graph has
            no signed URL primitive. Anonymous links are blocked on tenants
            where admins disable them; the adapter surfaces Graph's{" "}
            <code>accessDenied</code> in that case.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="copyTimeoutMs"
          status="optional"
          value="copyTimeoutMs"
        >
          <p>
            Maximum time (ms) to wait for an async copy operation to complete.
            Graph returns 202 plus a monitor URL; the adapter polls until{" "}
            <code>status === "completed"</code> or this timeout elapses, at
            which point it throws <code>Provider</code>. Defaults to{" "}
            <code>60_000</code>.
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-onedrive-limitations">
        Limitations
      </Heading>
      <p>
        <code>url()</code> throws unless the adapter is constructed with{" "}
        <code>publicByDefault: true</code> - Graph has no signed URL primitive.
        With <code>publicByDefault</code>, the returned share link has no expiry
        by Graph's default policy (<code>expiresIn</code> is silently ignored)
        and <code>responseContentDisposition</code> always throws - Graph has no
        Content-Disposition override. <code>signedUploadUrl()</code> initiates
        an upload session via <code>createUploadSession</code> and returns the
        session URL as a one-shot PUT; <code>maxSize</code> and{" "}
        <code>minSize</code> are advisory - Graph does not enforce a server-side{" "}
        <code>content-length-range</code> policy on upload sessions. Direct{" "}
        <code>upload()</code> is capped at OneDrive's 250 MB simple-upload
        limit; larger bodies must use <code>signedUploadUrl()</code> or drop to{" "}
        <code>raw</code> for chunked sessions. Drive items have no native
        arbitrary-metadata field, so user <code>metadata</code> and{" "}
        <code>cacheControl</code> on <code>upload()</code> throw - use{" "}
        <code>raw</code> to set Open Extensions if you need them.{" "}
        <code>copy()</code> is async on Graph (202 + monitor URL); the adapter
        polls the monitor and resolves when status is <code>"completed"</code>,
        with a configurable <code>copyTimeoutMs</code> ceiling.{" "}
        <code>list()</code> returns immediate-children files only at{" "}
        <code>rootFolderPath</code> - no recursion; subfolders are filtered out.
      </p>
    </div>
  </section>
);
