import { CodeBlock } from "@/components/code-block";
import { Heading } from "@/components/heading";

const USAGE_EXAMPLE = `import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({ bucket: "uploads", region: "us-east-1" }),
});

await files.upload("hello.txt", "world");
const file = await files.download("hello.txt");
const { items } = await files.list({ prefix: "hello" });
await files.delete("hello.txt");`;

export const QuickStart = () => (
  <section>
    <Heading as="h2">Quick start</Heading>
    <p>
      Construct a <code>Files</code> instance with the adapter for your
      provider, then call methods on it. The adapter is fixed at construction -
      there is no functional <code>put({"{ provider, ... }"})</code> form to
      keep call sites flat.
    </p>
    <CodeBlock code={USAGE_EXAMPLE} lang="tsx" />
  </section>
);
