import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const GOOGLE_DRIVE_EXAMPLE = `import { Files } from "files-sdk";
import { googleDrive } from "files-sdk/google-drive";

// Service account into a Shared Drive (recommended - the default
// service-account quota is 15 GB and not really intended for storage).
// Add the service account as a member of the Shared Drive in the
// Google Workspace admin console first.
const files = new Files({
  adapter: googleDrive({
    credentials: {
      client_email: process.env.GOOGLE_DRIVE_CLIENT_EMAIL!,
      private_key: process.env.GOOGLE_DRIVE_PRIVATE_KEY!,
    },
    driveId: process.env.GOOGLE_DRIVE_ID!,
    // Shared Drive root id, or a sub-folder id to scope the "bucket".
    rootFolderId: process.env.GOOGLE_DRIVE_ID!,
    // publicByDefault: true → grants anyone-with-link reader on upload
    //                       and url() returns the Drive download URL.
  }),
});`;

export const GoogleDrive = () => (
  <section>
    <p>
      Google Drive via the official <code>@googleapis/drive</code> v3 client.
      Drive is a document manager rather than object storage - files have opaque{" "}
      <code>fileId</code>s and names can collide, so the adapter maps a unified
      string key onto Drive's <code>appProperties</code> (<code>fsdkKey</code>),
      with a per-instance LRU so reads after the first don't re-issue a lookup.
      Four auth modes: service-account credentials (inline or via key file), an
      OAuth refresh token, a pre-built Drive client (the escape hatch), or
      env-var fallback.
    </p>
    <CodeBlock code={GOOGLE_DRIVE_EXAMPLE} lang="ts" />
    <section>
      <Heading as="h2" id="options">
        Options
      </Heading>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem
          name="credentials"
          status="optional"
          value="credentials"
        >
          <p>
            Inline service-account credentials -{" "}
            <code>{"{ client_email, private_key }"}</code>. Mutually exclusive
            with the other auth shapes. Service accounts have a 15 GB personal
            quota - production usage should target a Shared Drive (
            <code>driveId</code>) with the service account added as a member.
            Falls back to the <code>GOOGLE_DRIVE_CLIENT_EMAIL</code> +{" "}
            <code>GOOGLE_DRIVE_PRIVATE_KEY</code> environment variables.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="keyFilename"
          status="optional"
          value="keyFilename"
        >
          <p>
            Path to a service-account JSON file. Mutually exclusive with{" "}
            <code>credentials</code>, <code>oauth</code>, and{" "}
            <code>client</code>. Falls back to the{" "}
            <code>GOOGLE_DRIVE_KEY_FILE</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="oauth" status="optional" value="oauth">
          <p>
            OAuth refresh token -{" "}
            <code>{"{ clientId, clientSecret, refreshToken }"}</code>. Use this
            to write into an end-user's Drive (3-legged OAuth). The adapter
            mints fresh access tokens on demand.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="client" status="optional" value="client">
          <p>
            Pre-built <code>@googleapis/drive</code> v3 client - escape hatch
            when you've already wired auth (workload identity, ADC, custom auth
            flows). When passed, the adapter uses it directly. Note that{" "}
            <code>signedUploadUrl()</code> requires an auth handle to mint
            access tokens for the resumable session POST, so it throws when
            constructed via this path - there's no stable public surface to
            recover the auth back from a wrapped client. Pass{" "}
            <code>credentials</code> / <code>keyFilename</code> /{" "}
            <code>oauth</code> instead if you need direct uploads.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="subject" status="optional" value="subject">
          <p>
            Domain-wide delegation subject - the user the service account should
            impersonate. Only honored with <code>credentials</code> or{" "}
            <code>keyFilename</code>. Falls back to the{" "}
            <code>GOOGLE_DRIVE_SUBJECT</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="driveId" status="optional" value="driveId">
          <p>
            Shared Drive id. Strongly recommended for service-account auth -
            without one the adapter writes against the service account's
            personal 15 GB quota. When set, all queries scope to the Shared
            Drive (<code>corpora=drive</code>,{" "}
            <code>supportsAllDrives=true</code>). Falls back to the{" "}
            <code>GOOGLE_DRIVE_ID</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="rootFolderId"
          status="optional"
          value="rootFolderId"
        >
          <p>
            Logical "bucket root" - virtual keys live under this folder.
            Defaults to <code>"root"</code> (My Drive root), or to{" "}
            <code>driveId</code> when set so Shared Drives work without extra
            config. When you've passed a <code>driveId</code> but want to scope
            uploads to a sub-folder, set <code>rootFolderId</code> to that
            folder's id. Falls back to the{" "}
            <code>GOOGLE_DRIVE_ROOT_FOLDER_ID</code> environment variable.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="publicByDefault"
          status="optional"
          value="publicByDefault"
        >
          <p>
            When <code>true</code>, <code>upload()</code> also creates an
            "anyone with link, reader" permission and <code>url()</code> returns
            the public Drive download URL. When <code>false</code> (default),{" "}
            <code>url()</code> throws - Drive has no signed URL primitive. Fixed
            at construction; need a mix? Use two adapters or grant permissions
            explicitly via <code>raw</code>.
          </p>
        </PropAccordionItem>
        <PropAccordionItem
          name="fileIdCacheSize"
          status="optional"
          value="fileIdCacheSize"
        >
          <p>
            LRU capacity for the in-memory virtual-key → fileId cache. Drive has
            no native key field; every read after the first would otherwise
            round-trip a <code>files.list</code> to resolve the id, which the
            cache amortizes within a single adapter instance. Defaults to 1024.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>
    <section>
      <Heading as="h2" id="limitations">
        Limitations
      </Heading>
      <p>
        <code>url()</code> throws unless the adapter is constructed with{" "}
        <code>publicByDefault: true</code> - Drive has no signed URL primitive.
        With <code>publicByDefault</code>, the returned URL is permanent (
        <code>expiresIn</code> is silently ignored) and{" "}
        <code>responseContentDisposition</code> always throws - Drive's download
        URL has no Content-Disposition override. <code>signedUploadUrl()</code>{" "}
        initiates a Drive resumable session and returns the session URL as a
        one-shot PUT; <code>maxSize</code> is forwarded as{" "}
        <code>X-Upload-Content-Length</code> (advisory, not server-side
        enforced) and <code>minSize</code> is ignored. <code>list()</code>{" "}
        scopes by parent folder and filters client-side to files that carry the
        adapter's <code>fsdkKey</code> - files written into the same folder
        out-of-band are excluded; <code>prefix</code> filtering is page-local
        and can under-return when the prefix isn't satisfied within a single
        page. Two files with the same virtual key (created out-of-band) make
        resolution throw <code>Conflict</code> rather than picking one silently.
        User <code>metadata</code> keys starting with <code>fsdk</code> are
        reserved (the adapter uses that prefix on <code>appProperties</code> for
        bookkeeping).
      </p>
    </section>
  </section>
);
