import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const BOX_EXAMPLE = `import { Files } from "files-sdk";
import { box } from "files-sdk/box";

// Server-side: Client Credentials Grant (recommended for backend services).
// The SDK manages access-token lifetime internally - no manual refresh
// bookkeeping in the adapter.
const files = new Files({
  adapter: box({
    ccg: {
      clientId: process.env.BOX_CLIENT_ID!,
      clientSecret: process.env.BOX_CLIENT_SECRET!,
      enterpriseId: process.env.BOX_ENTERPRISE_ID!,
    },
    rootFolderId: process.env.BOX_ROOT_FOLDER_ID, // defaults to "0" (account root)
    // publicByDefault: true → upload() also calls addShareLinkToFile and
    //                       url() returns the link's download_url.
  }),
});

// Other auth shapes the adapter accepts:
//   developerToken: process.env.BOX_DEVELOPER_TOKEN  // dev-console token
//   oauth: { clientId, clientSecret, refreshToken } // user-app flow
//   jwt:   { configJsonString }                     // JWT server auth
//   client: yourBoxClient                           // pre-built escape hatch`;

export const Box = () => (
  <section>
    <p>
      Box via the official <code>box-typescript-sdk-gen</code> SDK. Box files
      live by ID, not by path, so the adapter walks <code>rootFolderId</code>{" "}
      and translates virtual keys (<code>docs/a.txt</code>) into nested Box
      subfolders, auto-creating intermediate folders on <code>upload()</code>.
      Five auth shapes (pre-built client, developer token, OAuth refresh-token,
      Client Credentials Grant, JWT server auth) cover scripts, user apps, and
      enterprise installs - token lifecycle is handled by the SDK's built-in{" "}
      <code>Authentication</code> classes.
    </p>
    <CodeBlock code={BOX_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="client" status="optional" value="box-client">
          <p>
            Pre-built <code>BoxClient</code> - escape hatch for callers that
            already wire auth themselves (custom <code>NetworkSession</code>,
            proxy config, downscoped tokens). When passed, the adapter delegates
            auth entirely to the SDK; the other auth options are ignored.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="developerToken"
          status="optional"
          value="developerToken"
        >
          <p>
            Static developer token from the Box developer console. Useful for
            scripts and trying the adapter; production apps should use OAuth,
            CCG, or JWT instead. Falls back to the{" "}
            <code>BOX_DEVELOPER_TOKEN</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="oauth" status="optional" value="box-oauth">
          <p>
            OAuth2 user-app flow. Pass <code>clientId</code>,{" "}
            <code>clientSecret</code>, and a long-lived{" "}
            <code>refreshToken</code> obtained from the authorization-code flow.
            The adapter seeds the SDK's in-memory token storage with the refresh
            token; the SDK exchanges it for a fresh access token on the first
            API call and re-refreshes when the access token expires.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="ccg" status="optional" value="box-ccg">
          <p>
            Client Credentials Grant - server-side enterprise auth. Pass{" "}
            <code>clientId</code>, <code>clientSecret</code>, and either{" "}
            <code>enterpriseId</code> (authenticate as the service account) or{" "}
            <code>userId</code> (authenticate as a managed/app user). At least
            one of the two is required.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="jwt" status="optional" value="box-jwt">
          <p>
            JWT Server Authentication, configured via Box's developer-console
            JSON blob. Pass either <code>configJsonString</code> (the JSON text)
            or <code>configFilePath</code> (path to the file on disk). The SDK
            handles RSA key decryption and assertion signing.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="rootFolderId"
          status="optional"
          value="rootFolderId"
        >
          <p>
            Logical "bucket root" - virtual keys live under this Box folder ID.
            The folder must already exist; intermediate subfolders are
            auto-created on <code>upload()</code>. Defaults to <code>"0"</code>{" "}
            (the user's root folder).
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicByDefault"
          status="optional"
          value="box-publicByDefault"
        >
          <p>
            When <code>true</code>, <code>upload()</code> also calls{" "}
            <code>addShareLinkToFile</code> with <code>access: "open"</code> and{" "}
            <code>url()</code> returns that link's <code>download_url</code> (or{" "}
            <code>url</code> if <code>download_url</code> is absent - typical
            for non-binary previews). When <code>false</code> (default),{" "}
            <code>url()</code> mints a short-lived signed download URL via{" "}
            <code>getDownloadFileUrl</code>. Public shared links may be
            restricted on Box Business or Enterprise plans; the adapter surfaces
            Box's <code>access_denied_insufficient_permissions</code> error in
            that case.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicBaseUrl"
          status="optional"
          value="box-publicBaseUrl"
        >
          <p>
            Origin used to build URLs from <code>url()</code>. When set,{" "}
            <code>url(key)</code> returns{" "}
            <code>{`\`\${publicBaseUrl}/\${key}\``}</code> and skips both
            signing and shared-link resolution. Useful when a CDN or vanity
            domain sits in front of pre-shared Box links.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="defaultUrlExpiresIn"
          status="optional"
          value="box-defaultUrlExpiresIn"
        >
          <p>
            Default expiry, in seconds, accepted by <code>url()</code> when
            minting a signed download URL. Box controls the URL's TTL
            server-side, so this value is accepted for API symmetry but the
            actual lifetime is whatever Box returns. Defaults to{" "}
            <code>3600</code>.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>signedUploadUrl()</code> throws - Box uploads require a multipart
        POST with both an <code>attributes</code> JSON part and the file bytes
        part, which fits neither the SDK's PUT-with-headers nor
        POST-with-form-fields shape. Use <code>upload()</code> server-side, or
        Box's UI Elements / Content Uploader for browser flows. Direct{" "}
        <code>upload()</code> handles up to Box's 50 MB single-call limit;
        larger bodies switch to <code>chunkedUploads.uploadBigFile</code>.
        Stream bodies are buffered up-front because the SDK's upload manager
        takes a Node <code>Readable</code> rather than a Web stream.{" "}
        <code>list()</code> returns immediate-children files only at{" "}
        <code>rootFolderId</code> - no recursion, subfolders are filtered out,
        and <code>prefix</code> is matched client-side within the page; for deep
        enumeration drop to <code>raw.folders.getFolderItems</code> and recurse
        manually. <code>responseContentDisposition</code> always throws - Box's{" "}
        <code>getDownloadFileUrl</code> and shared-link URLs have no
        Content-Disposition override. User <code>metadata</code> and{" "}
        <code>cacheControl</code> on <code>upload()</code> throw - Box exposes
        file metadata via classifications and metadata templates; drop to{" "}
        <code>raw.fileMetadata.*</code> if you need it. Box doesn't store
        user-supplied content types on file content, so <code>head()</code> and{" "}
        <code>list()</code> return a type inferred from the filename extension.
      </p>
    </section>
  </section>
);
