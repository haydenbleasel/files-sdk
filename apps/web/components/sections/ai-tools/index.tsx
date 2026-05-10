import { Heading } from "@/components/heading";

import { Openai } from "./openai";
import { VercelAiSdk } from "./vercel";

export const AiTools = () => (
  <section>
    <Heading as="h2" id="ai-tools">
      AI tools
    </Heading>
    <p>
      Files SDK ships first-class tool factories for the most common LLM
      integrations. Each one wraps a configured <code>Files</code> instance into
      the shape that provider expects — same eight operations, same
      Zod-validated input contracts, same approval-gating defaults — so the
      model can browse, read, and (optionally) mutate your bucket through the
      same unified surface as your application code.
    </p>
    <p>
      Pick the subpath that matches your stack. Each is independently
      tree-shakeable and pulls in only the peer dependencies it needs.
    </p>
    <Openai />
    <VercelAiSdk />
  </section>
);
