import { CodeBlock } from "@/components/code-block";
import { CodeTabs } from "@/components/code-tabs";
import { Heading } from "@/components/heading";

const RESPONSES_INSTALL_TABS = [
  {
    code: "npm install openai zod",
    id: "npm",
    label: "npm",
    lang: "bash",
  },
  {
    code: "pnpm add openai zod",
    id: "pnpm",
    label: "pnpm",
    lang: "bash",
  },
  {
    code: "bun add openai zod",
    id: "bun",
    label: "bun",
    lang: "bash",
  },
  {
    code: "yarn add openai zod",
    id: "yarn",
    label: "yarn",
    lang: "bash",
  },
] as const;

const AGENTS_INSTALL_TABS = [
  {
    code: "npm install @openai/agents zod",
    id: "npm",
    label: "npm",
    lang: "bash",
  },
  {
    code: "pnpm add @openai/agents zod",
    id: "pnpm",
    label: "pnpm",
    lang: "bash",
  },
  {
    code: "bun add @openai/agents zod",
    id: "bun",
    label: "bun",
    lang: "bash",
  },
  {
    code: "yarn add @openai/agents zod",
    id: "yarn",
    label: "yarn",
    lang: "bash",
  },
] as const;

const RESPONSES_EXAMPLE = `import OpenAI from "openai";
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createResponsesFileTools } from "files-sdk/openai";

const client = new OpenAI();
const files = new Files({ adapter: s3({ bucket: "uploads" }) });
const ft = createResponsesFileTools({ files });

const input: any[] = [{ role: "user", content: "List my files." }];
while (true) {
  const res = await client.responses.create({
    model: "gpt-4.1",
    input,
    tools: ft.definitions,
  });

  const calls = res.output.filter((o) => o.type === "function_call");
  if (calls.length === 0) {
    console.log(res.output_text);
    break;
  }

  for (const call of calls) {
    if (ft.needsApproval(call.name)) {
      // surface approval UX, then continue or break
    }
    input.push(call, await ft.execute(call));
  }
}`;

const AGENTS_EXAMPLE = `import { Agent, run } from "@openai/agents";
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
import { createAgentsFileTools } from "files-sdk/openai";

const files = new Files({ adapter: s3({ bucket: "uploads" }) });
const tools = createAgentsFileTools({ files });

const agent = new Agent({
  instructions: "Help the user manage their files.",
  name: "Files agent",
  tools: Object.values(tools),
});

const result = await run(agent, "List my files.");`;

const APPROVAL_EXAMPLE = `// Same shape across both factories.

createResponsesFileTools({ files });                       // all writes gated (default)
createResponsesFileTools({ files, requireApproval: false }); // disabled
createResponsesFileTools({
  files,
  requireApproval: { deleteFile: true, uploadFile: false },
});

createAgentsFileTools({ files, readOnly: true });
// → only listFiles, getFileMetadata, downloadFile, getFileUrl`;

export const Openai = () => (
  <section>
    <Heading as="h2" id="openai-tools">
      OpenAI
    </Heading>
    <p>
      The <code>files-sdk/openai</code> subpath ships two factories targeting
      OpenAI directly - one for the native{" "}
      <a
        className="underline decoration-dotted underline-offset-4 hover:text-foreground"
        href="https://developers.openai.com/api/reference/responses/overview"
        rel="noreferrer"
        target="_blank"
      >
        Responses API
      </a>{" "}
      and one for the{" "}
      <a
        className="underline decoration-dotted underline-offset-4 hover:text-foreground"
        href="https://openai.github.io/openai-agents-js/"
        rel="noreferrer"
        target="_blank"
      >
        OpenAI Agents SDK
      </a>{" "}
      (<code>@openai/agents</code>). Both wrap the same eight file operations as
      the Vercel subpath, with the same approval-gating defaults.
    </p>
    <p>
      <code>openai</code> and <code>@openai/agents</code> are optional peer
      dependencies - install only the one(s) you use. The subpath requires{" "}
      <strong>Zod 4</strong>: <code>@openai/agents</code> peer-requires it, and
      Zod 4's built-in <code>toJSONSchema</code> powers the Responses tool
      definitions.
    </p>

    <section>
      <Heading as="h3" id="openai-tools-responses">
        Responses API
      </Heading>
      <p>
        <code>createResponsesFileTools</code> returns{" "}
        <code>{"{ definitions, execute, needsApproval }"}</code>. Pass{" "}
        <code>definitions</code> straight to{" "}
        <code>openai.responses.create({"{ tools }"})</code>, then call{" "}
        <code>execute(call)</code> on each <code>function_call</code> item in
        the response output to get a <code>function_call_output</code> ready to
        push into the next turn's input.
      </p>
      <CodeTabs tabs={RESPONSES_INSTALL_TABS} />
      <CodeBlock code={RESPONSES_EXAMPLE} lang="tsx" />
      <p>
        <code>execute</code> returns JSON parse failures and Zod validation
        errors <em>as the tool's output</em>, so the model can self-correct on
        the next turn. <code>FilesError</code> from the underlying SDK is
        rethrown - you decide how to surface it.{" "}
        <code>needsApproval(name)</code> is informational; checking it is the
        caller's responsibility.
      </p>
    </section>

    <section>
      <Heading as="h3" id="openai-tools-agents">
        Agents SDK
      </Heading>
      <p>
        <code>createAgentsFileTools</code> returns a record of{" "}
        <code>tool()</code> outputs keyed by tool name - spread{" "}
        <code>Object.values()</code> into <code>new Agent({"{ tools }"})</code>.
        Write tools default to <code>needsApproval: true</code>; the Agents SDK
        runner surfaces an <code>interruption</code> that your program resolves
        by approving or rejecting the call.
      </p>
      <CodeTabs tabs={AGENTS_INSTALL_TABS} />
      <CodeBlock code={AGENTS_EXAMPLE} lang="tsx" />
      <p>
        Errors thrown from <code>execute()</code> are wrapped by the Agents
        SDK's default <code>errorFunction</code> into a model-visible string -
        the model sees the message and can self-correct on the next turn. This
        is the standard Agents-SDK pattern, and differs from the Responses flow
        where <code>FilesError</code> rethrows.
      </p>
    </section>

    <section>
      <Heading as="h3" id="openai-tools-options">
        Approval, read-only, overrides
      </Heading>
      <p>
        Both factories accept the same options shape as the Vercel{" "}
        <code>createFileTools</code>: <code>requireApproval</code> (boolean or
        per-tool record), <code>readOnly</code> (strips writes entirely), and{" "}
        <code>overrides</code> (description, plus <code>strict</code> for
        Responses or <code>needsApproval</code> for Agents).
      </p>
      <CodeBlock code={APPROVAL_EXAMPLE} lang="ts" />
    </section>
  </section>
);
