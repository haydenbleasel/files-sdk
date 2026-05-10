import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { Heading } from "@/components/heading";
import { PropAccordionItem } from "@/components/prop-accordion-item";
import { Accordion } from "@/components/ui/accordion";

const INSTALL_TABS = [
  {
    code: "npm install ai zod",
    id: "npm",
    label: "npm",
    lang: "bash",
  },
  {
    code: "pnpm add ai zod",
    id: "pnpm",
    label: "pnpm",
    lang: "bash",
  },
  {
    code: "bun add ai zod",
    id: "bun",
    label: "bun",
    lang: "bash",
  },
  {
    code: "yarn add ai zod",
    id: "yarn",
    label: "yarn",
    lang: "bash",
  },
] as const;

const QUICK_START = `import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createFileTools } from "files-sdk/ai";
import { generateText } from "ai";

const files = new Files({
  adapter: s3({ bucket: "uploads", region: "us-east-1" }),
});

const result = await generateText({
  model: yourModel,
  tools: createFileTools({ files }),
  prompt: "Find every CSV under reports/ and summarize the latest one.",
});`;

const APPROVAL_EXAMPLE = `// All writes require approval (default).
createFileTools({ files });

// Drop the approval gate entirely.
createFileTools({ files, requireApproval: false });

// Granular: only the destructive operations need approval.
createFileTools({
  files,
  requireApproval: {
    deleteFile: true,
    signUploadUrl: true,
    uploadFile: false,
    copyFile: false,
  },
});`;

const READ_ONLY_EXAMPLE = `// Strip every write tool. The model can browse but cannot mutate
// the bucket regardless of approval configuration.
createFileTools({ files, readOnly: true });
// → { listFiles, getFileMetadata, downloadFile, getFileUrl }`;

const OVERRIDES_EXAMPLE = `createFileTools({
  files,
  overrides: {
    listFiles: { description: "List files in the current tenant's bucket" },
    deleteFile: { needsApproval: false, title: "Remove file" },
  },
});`;

const CHERRY_PICK_EXAMPLE = `import { Files } from "files-sdk";
import { listFiles, downloadFile, uploadFile } from "files-sdk/ai";

const files = new Files({ adapter });

const tools = {
  listFiles: listFiles(files),
  downloadFile: downloadFile(files),
  uploadFile: uploadFile(files),
};`;

export const AiTools = () => (
  <section>
    <Heading as="h2" id="ai-tools">
      AI SDK tools
    </Heading>
    <p>
      The <code>files-sdk/ai</code> subpath exposes a configured{" "}
      <code>Files</code> instance to the{" "}
      <a
        className="underline decoration-dotted underline-offset-4 hover:text-foreground"
        href="https://ai-sdk.dev"
        rel="noreferrer"
        target="_blank"
      >
        Vercel AI SDK
      </a>{" "}
      as a set of ready-to-use tools — drop them into <code>generateText</code>,{" "}
      <code>streamText</code>, or any agent and the model can browse, read, and
      mutate your bucket through the same unified surface as your application
      code.
    </p>
    <p>
      Write tools (<code>uploadFile</code>, <code>deleteFile</code>,{" "}
      <code>copyFile</code>, <code>signUploadUrl</code>) require user approval
      by default — designed for human-in-the-loop agents. Read tools (
      <code>listFiles</code>, <code>getFileMetadata</code>,{" "}
      <code>downloadFile</code>, <code>getFileUrl</code>) never require
      approval.
    </p>

    <section>
      <Heading as="h3" id="ai-tools-installation">
        Installation
      </Heading>
      <p>
        <code>ai</code> and <code>zod</code> are optional peer dependencies —
        only install them if you're consuming the <code>files-sdk/ai</code>{" "}
        subpath.
      </p>
      <CodeTabs tabs={INSTALL_TABS} />
    </section>

    <section>
      <Heading as="h3" id="ai-tools-quick-start">
        Quick start
      </Heading>
      <p>
        Construct a <code>Files</code> instance the same way you would anywhere
        else, then pass it to <code>createFileTools</code>. The returned object
        plugs straight into the AI SDK's <code>tools</code> field.
      </p>
      <CodeBlock code={QUICK_START} lang="tsx" />
    </section>

    <section>
      <Heading as="h3" id="ai-tools-approval">
        Approval control
      </Heading>
      <p>
        <code>requireApproval</code> accepts a boolean for the all-or-nothing
        case, or an object keyed by write tool name for fine-grained control.
        Unspecified entries in the object form default to <code>true</code>, so
        it's safe to opt-in only the cases you trust.
      </p>
      <CodeBlock code={APPROVAL_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="ai-tools-read-only">
        Read-only mode
      </Heading>
      <p>
        Pass <code>readOnly: true</code> to drop every write tool. The model
        cannot mutate the bucket regardless of how <code>requireApproval</code>{" "}
        is configured — useful for retrieval-style agents that only need to
        browse, summarize, or hand the user a download URL.
      </p>
      <CodeBlock code={READ_ONLY_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="ai-tools-surface">
        Tool surface
      </Heading>
      <p>
        Eight tools are returned by default — four read, four write. Each one is
        a thin wrapper around a <code>Files</code> method, so they share the
        SDK's key validation, normalized errors, and adapter portability.
      </p>
      <Accordion className="rounded-md border-dotted" type="multiple">
        <PropAccordionItem name="listFiles" value="ai-list-files">
          <p>
            Paginated list of objects with optional <code>prefix</code>,{" "}
            <code>cursor</code>, and <code>limit</code>. Returns metadata-only
            entries (<code>key</code>, <code>size</code>, <code>type</code>,{" "}
            <code>lastModified</code>, <code>etag</code>) plus a continuation
            cursor.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="getFileMetadata" value="ai-get-file-metadata">
          <p>
            Fetch metadata for a single key without transferring the body. Wraps{" "}
            <code>files.head(key)</code>; returns size, content type, etag, and
            any custom metadata.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="downloadFile" value="ai-download-file">
          <p>
            Download an object and return its contents. Accepts a{" "}
            <code>maxBytes</code> guard (default 1 MiB) checked via{" "}
            <code>head()</code> <em>before</em> any transfer — JSON tool
            boundaries don't love multi-megabyte payloads. Returns UTF-8 text by
            default; pass <code>binary: true</code> to receive base64-encoded
            bytes for non-text files.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="getFileUrl" value="ai-get-file-url">
          <p>
            Build a URL for the object. Forwards <code>expiresIn</code> and{" "}
            <code>responseContentDisposition</code> straight to{" "}
            <code>files.url()</code> — handy for letting the model hand the user
            a download link instead of streaming bytes back through the tool
            boundary.
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="uploadFile" value="ai-upload-file">
          <p>
            Upload a file. Accepts <code>content: string</code> plus an optional{" "}
            <code>encoding: "text" | "base64"</code> — base64 is decoded before
            upload so binary payloads stay JSON-safe at the tool boundary.
            Forwards <code>contentType</code>, <code>cacheControl</code>, and{" "}
            <code>metadata</code>.{" "}
            <span className="text-foreground">Approval-gated.</span>
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="deleteFile" value="ai-delete-file">
          <p>
            Permanently delete an object.{" "}
            <span className="text-foreground">Approval-gated.</span>
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="copyFile" value="ai-copy-file">
          <p>
            Copy an object to a new key within the same bucket. The source
            remains intact.{" "}
            <span className="text-foreground">Approval-gated.</span>
          </p>
        </PropAccordionItem>
        <PropAccordionItem name="signUploadUrl" value="ai-sign-upload-url">
          <p>
            Issue a presigned URL the model can hand back to the client for a
            direct upload. Approval-gated by default — even though no bytes move
            during the tool call itself, issuing the URL grants upload
            permission until <code>expiresIn</code> elapses.
          </p>
        </PropAccordionItem>
      </Accordion>
    </section>

    <section>
      <Heading as="h3" id="ai-tools-overrides">
        Overrides
      </Heading>
      <p>
        Patch any safe <code>tool()</code> field on a per-tool basis without
        touching the underlying implementation. Useful for tightening
        descriptions to your domain, flipping an individual{" "}
        <code>needsApproval</code>, or adding provider-specific{" "}
        <code>providerOptions</code>. <code>execute</code>,{" "}
        <code>inputSchema</code>, and <code>outputSchema</code> are
        intentionally not overridable.
      </p>
      <CodeBlock code={OVERRIDES_EXAMPLE} lang="ts" />
    </section>

    <section>
      <Heading as="h3" id="ai-tools-cherry-pick">
        Cherry-picking tools
      </Heading>
      <p>
        Each tool factory is also exported individually for fully custom setups
        — useful when you want to mix AI SDK tools across multiple domains and
        need full control over the returned object's shape.
      </p>
      <CodeBlock code={CHERRY_PICK_EXAMPLE} lang="ts" />
    </section>
  </section>
);
