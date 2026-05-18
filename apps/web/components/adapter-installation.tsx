import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "fumadocs-ui/components/tabs";
import { Fragment } from "react";

interface AdapterInstallationProps {
  peerDeps: readonly string[];
}

const listFormatter = new Intl.ListFormat("en", {
  style: "long",
  type: "conjunction",
});

const buildPeerDepSegments = (peerDeps: readonly string[]) => {
  const segments: { prefix: string; element: string }[] = [];
  let prefix = "";
  for (const part of listFormatter.formatToParts(peerDeps)) {
    if (part.type === "literal") {
      prefix += part.value;
    } else {
      segments.push({ element: part.value, prefix });
      prefix = "";
    }
  }
  return segments;
};

const buildTabs = (peerDeps: readonly string[]) => {
  const packages = ["files-sdk", ...peerDeps].join(" ");
  return [
    { code: `npm install ${packages}`, id: "npm", label: "npm" },
    { code: `pnpm add ${packages}`, id: "pnpm", label: "pnpm" },
    { code: `bun add ${packages}`, id: "bun", label: "bun" },
    { code: `yarn add ${packages}`, id: "yarn", label: "yarn" },
  ] as const;
};

export const AdapterInstallation = ({ peerDeps }: AdapterInstallationProps) => {
  const tabs = buildTabs(peerDeps);

  return (
    <section>
      <h2 id="installation">Installation</h2>
      {peerDeps.length === 0 ? (
        <p>
          This adapter has no extra peer dependencies - the runtime (Node or
          Bun) provides everything it needs.
        </p>
      ) : (
        <p>
          {buildPeerDepSegments(peerDeps).map(({ prefix, element }) => (
            <Fragment key={element}>
              {prefix}
              <code>{element}</code>
            </Fragment>
          ))}{" "}
          {peerDeps.length === 1 ? "is an" : "are"} optional peer{" "}
          {peerDeps.length === 1 ? "dependency" : "dependencies"} of{" "}
          <code>files-sdk</code> - install alongside the SDK so the adapter's
          imports resolve at runtime.
        </p>
      )}
      <Tabs defaultValue="npm">
        <TabsList>
          {tabs.map(({ id, label }) => (
            <TabsTrigger key={id} value={id}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map(({ id, code }) => (
          <TabsContent key={id} value={id}>
            <DynamicCodeBlock code={code} lang="bash" />
          </TabsContent>
        ))}
      </Tabs>
    </section>
  );
};
