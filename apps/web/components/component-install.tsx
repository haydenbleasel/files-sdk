import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import { headers } from "next/headers";

interface ComponentInstallProps {
  /** Registry item name, e.g. `"dropzone"`. */
  name: string;
}

const MANAGERS: { label: string; command: (url: string) => string }[] = [
  { command: (url) => `npx shadcn@latest add ${url}`, label: "npm" },
  { command: (url) => `pnpm dlx shadcn@latest add ${url}`, label: "pnpm" },
  { command: (url) => `bunx --bun shadcn@latest add ${url}`, label: "bun" },
];

/** Per-package-manager `shadcn add` command pointing at this site's registry. */
export const ComponentInstall = async ({ name }: ComponentInstallProps) => {
  const head = await headers();
  const host = head.get("host") ?? "localhost:3000";
  const protocol = host.startsWith("localhost") ? "http" : "https";
  const url = `${protocol}://${host}/r/${name}.json`;

  return (
    <Tabs items={MANAGERS.map((manager) => manager.label)}>
      {MANAGERS.map((manager) => (
        <Tab key={manager.label} value={manager.label}>
          <DynamicCodeBlock code={manager.command(url)} lang="bash" />
        </Tab>
      ))}
    </Tabs>
  );
};
