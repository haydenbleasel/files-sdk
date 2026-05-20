import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "fumadocs-ui/components/tabs";

import { CodeBlock } from "@/components/code-block";

const INSTALL = [
  { code: "npm install files-sdk", id: "npm", label: "npm" },
  { code: "pnpm add files-sdk", id: "pnpm", label: "pnpm" },
  { code: "bun add files-sdk", id: "bun", label: "bun" },
  { code: "yarn add files-sdk", id: "yarn", label: "yarn" },
] as const;

const FIRST_CALL = `import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";

const files = new Files({
  adapter: s3({ bucket: "uploads", region: "us-east-1" }),
});

await files.upload("hello.txt", "world");`;

export const GetStarted = () => (
  <section>
    <div className="mx-auto max-w-6xl px-6 py-24 sm:py-32">
      <div>
        <p className="font-mono text-xs text-muted-foreground">Two steps</p>
        <h2 className="mt-3 max-w-[30ch] text-4xl font-medium tracking-tight text-balance text-foreground sm:text-5xl">
          Your first upload in under a minute.
        </h2>
        <p className="mt-5 max-w-[48ch] text-lg leading-relaxed text-pretty text-muted-foreground">
          Install files-sdk and your provider's native client, then construct
          one Files instance and start calling it.
        </p>
      </div>
      <div className="mt-14 grid gap-12 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <h3 className="font-mono text-xs text-muted-foreground">
            1. Install
          </h3>
          <Tabs defaultValue="npm">
            <TabsList>
              {INSTALL.map(({ id, label }) => (
                <TabsTrigger key={id} value={id}>
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
            {INSTALL.map(({ code, id }) => (
              <TabsContent key={id} value={id}>
                <CodeBlock code={code} lang="bash" />
              </TabsContent>
            ))}
          </Tabs>
          <p className="text-base leading-relaxed text-pretty text-muted-foreground sm:text-sm">
            Each adapter's native SDK is an optional peer dependency — install
            only the ones you actually use.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <h3 className="font-mono text-xs text-muted-foreground">
            2. Make your first call
          </h3>
          <CodeBlock code={FIRST_CALL} lang="tsx" />
          <p className="text-base leading-relaxed text-pretty text-muted-foreground sm:text-sm">
            Construct a Files instance with your provider's adapter, then call
            upload, download, list, delete on it.
          </p>
        </div>
      </div>
    </div>
  </section>
);
