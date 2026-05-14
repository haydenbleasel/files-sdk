import { Claude } from "./claude";
import { Openai } from "./openai";
import { VercelAiSdk } from "./vercel";

export const AiTools = () => (
  <section>
    <Openai />
    <VercelAiSdk />
    <Claude />
  </section>
);
