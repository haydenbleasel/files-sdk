import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";

interface ComponentInstallProps {
  /** Registry item name, e.g. `"dropzone"`. */
  name: string;
}

const MANAGERS: { label: string; command: (url: string) => string }[] = [
  { command: (url) => `npx shadcn@latest add ${url}`, label: "npm" },
  { command: (url) => `pnpm dlx shadcn@latest add ${url}`, label: "pnpm" },
  { command: (url) => `bunx --bun shadcn@latest add ${url}`, label: "bun" },
];

// Derive the registry origin from env, not the request `headers()`. Reading
// `headers()` is a Dynamic API that opts the whole page out of static
// prerendering — and these pages also render <AutoTypeTable>, whose build-time
// filesystem cache write throws (ENOENT) if it runs at request time on the
// read-only serverless filesystem. Staying static keeps generation at build.
const origin = process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "localhost:3000";
const protocol = origin.startsWith("localhost") ? "http" : "https";
const baseUrl = `${protocol}://${origin}`;

/** Per-package-manager `shadcn add` command pointing at this site's registry. */
export const ComponentInstall = ({ name }: ComponentInstallProps) => {
  const url = `${baseUrl}/r/${name}.json`;

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
