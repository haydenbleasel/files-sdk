import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

interface ComponentPreviewProps {
  /**
   * `<component>/<example>` under `registry/files-sdk`, e.g.
   * `"dropzone/dropzone-basic"`.
   */
  name: string;
  className?: string;
}

/**
 * Live preview + source for a registry example. The example renders against the
 * docs' in-memory `/api/files` gateway, so uploads actually work. The Code tab
 * rewrites the local registry import to the path the component installs to.
 */
export const ComponentPreview = async ({
  name,
  className,
}: ComponentPreviewProps) => {
  const [component, example] = name.split("/");

  // Relative (not aliased) specifier so the bundler builds the dynamic-import
  // context for registry/files-sdk/*/examples/*.tsx.
  const mod = await import(
    `../registry/files-sdk/${component}/examples/${example}.tsx`
  );
  const Example = mod.default as ComponentType;

  const raw = await readFile(
    join(
      process.cwd(),
      "registry/files-sdk",
      component,
      "examples",
      `${example}.tsx`
    ),
    "utf-8"
  );
  const code = raw.replaceAll(
    `@/registry/files-sdk/${component}/${component}`,
    `@/components/files-sdk/${component}`
  );

  return (
    <Tabs className="not-prose" items={["Preview", "Code"]}>
      <Tab value="Preview">
        <div
          className={cn(
            "flex min-h-64 items-center justify-center rounded-lg border bg-background p-6",
            className
          )}
        >
          <div className="w-full max-w-md">
            <Example />
          </div>
        </div>
      </Tab>
      <Tab value="Code">
        <DynamicCodeBlock code={code} lang="tsx" />
      </Tab>
    </Tabs>
  );
};
