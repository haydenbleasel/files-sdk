import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const DROPBOX_EXAMPLE = `import { Files } from "files-sdk";
import { dropbox } from "files-sdk/dropbox";

// OAuth2 refresh-token flow (recommended for server-side apps).
// The adapter exchanges the refresh token at api.dropboxapi.com/oauth2/token
// and caches the access token until ~60s before expiry.
const files = new Files({
  adapter: dropbox({
    refreshToken: process.env.DROPBOX_REFRESH_TOKEN!,
    appKey: process.env.DROPBOX_APP_KEY!,
    appSecret: process.env.DROPBOX_APP_SECRET, // omit for PKCE public clients
    rootFolderPath: "/Uploads",
    // publicByDefault: true → upload() also creates a public shared link
    //                       and url() returns it (rewritten to ?dl=1 for
    //                       direct download).
  }),
});`;

export const Dropbox = () => (
  <section>
    <Heading as="h2" id="adapter-dropbox">
      Dropbox
    </Heading>
    <p>
      Dropbox via the official <code>dropbox</code> SDK. Path-addressable like
      OneDrive (<code>/folder/file.txt</code>), so virtual keys map directly to
      Dropbox paths - no virtual-key cache, no bookkeeping. Four auth shapes
      (pre-built client, static or dynamic access token, OAuth refresh token +
      app key, or env-var fallback) cover personal Dropbox, Dropbox Business,
      and team-space deployments.
    </p>
    <CodeBlock code={DROPBOX_EXAMPLE} lang="ts" />
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-dropbox-options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Pre-built <code>Dropbox</code> client - escape hatch for callers
            that already wire auth themselves (team-space <code>pathRoot</code>,
            custom headers, shared <code>DropboxAuth</code>). When passed, the
            adapter delegates auth entirely to the SDK; the other auth options
            are ignored.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="accessToken"
          status="optional"
          value="accessToken"
        >
          <p>
            Static or dynamic access token - a string for one-shot tokens, or an
            async function for callers minting tokens themselves. The adapter
            does not cache the result of a callable; your callable owns refresh.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="refreshToken"
          status="optional"
          value="refreshToken"
        >
          <p>
            OAuth2 refresh token. Requires <code>appKey</code> (your app's
            client_id); pass <code>appSecret</code> as well for confidential
            clients. The adapter exchanges the refresh token at{" "}
            <code>api.dropboxapi.com/oauth2/token</code> and caches the access
            token until ~60s before expiry.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="appKey" status="optional" value="appKey">
          <p>
            Dropbox app key (<code>client_id</code>). Required when{" "}
            <code>refreshToken</code> is set.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="appSecret" status="optional" value="appSecret">
          <p>
            Dropbox app secret (<code>client_secret</code>). Required for
            confidential (server-side) clients; omit for PKCE-only public
            clients.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="rootFolderPath"
          status="optional"
          value="rootFolderPath"
        >
          <p>
            Logical "bucket root" - virtual keys live under this folder path on
            the Dropbox account (which must already exist; the adapter does not
            create folders). Defaults to the account root.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicByDefault"
          status="optional"
          value="publicByDefault"
        >
          <p>
            When <code>true</code>, <code>upload()</code> also calls{" "}
            <code>sharingCreateSharedLinkWithSettings</code> with{" "}
            <code>requested_visibility: "public"</code> and <code>url()</code>{" "}
            returns that link's URL (rewritten to <code>?dl=1</code> for direct
            download). When <code>false</code> (default), <code>url()</code>{" "}
            mints a 4-hour temporary link via <code>filesGetTemporaryLink</code>
            . Public shared links may be restricted on Dropbox Business teams;
            the adapter surfaces Dropbox's <code>access_denied</code> error in
            that case.
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
            <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
            signing and shared-link creation. Useful when a CDN sits in front of
            pre-shared Dropbox links.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="defaultUrlExpiresIn"
          status="optional"
          value="defaultUrlExpiresIn"
        >
          <p>
            Default expiry, in seconds, for the temporary download links
            returned by <code>url()</code> when neither{" "}
            <code>publicByDefault</code> nor <code>publicBaseUrl</code> is set.
            Capped at <code>14_400</code> (4 hours, the Dropbox maximum).
            Defaults to <code>3600</code>.
          </p>
        </PropAccordionItem>
      </Accordion>
    </div>
    <div className="flex flex-col gap-2">
      <Heading as="h3" id="adapter-dropbox-limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> throws - Dropbox's{" "}
        <code>filesGetTemporaryUploadLink</code> returns a URL that expects POST
        with a raw body, which fits neither the SDK's PUT-with-headers nor
        POST-with-form-fields shape. Use <code>upload()</code> or drop to{" "}
        <code>raw.filesGetTemporaryUploadLink(...)</code> for client-side
        uploads. Direct <code>upload()</code> handles up to Dropbox's 150 MB
        single-call limit; larger bodies switch to{" "}
        <code>filesUploadSession*</code> (chunked, up to 350 GB).{" "}
        <code>url()</code> is capped at Dropbox's 4-hour temporary-link maximum
        - <code>expiresIn</code> above 14400 throws; use{" "}
        <code>publicByDefault: true</code> for permanent shared links.{" "}
        <code>responseContentDisposition</code> always throws - Dropbox
        temporary and shared links have no Content-Disposition override. User{" "}
        <code>metadata</code> and <code>cacheControl</code> on{" "}
        <code>upload()</code> throw - Dropbox files have no native
        arbitrary-metadata field; use <code>raw</code> with{" "}
        <code>property_groups</code> (requires a registered template) if you
        need it. Stream-mode <code>download()</code> fetches the temporary link
        rather than streaming through the SDK, since <code>filesDownload</code>{" "}
        buffers the full body.
      </p>
    </div>
  </section>
);
