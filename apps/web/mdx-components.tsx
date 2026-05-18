import {
  createFileSystemGeneratorCache,
  createGenerator,
} from "fumadocs-typescript";
import { AutoTypeTable } from "fumadocs-typescript/ui";
import type { AutoTypeTableProps } from "fumadocs-typescript/ui";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";

import { AdapterInstallation } from "@/components/adapter-installation";
import { AdaptersIndexServer } from "@/components/adapters-index-server";
import { CompatibilityMatrix } from "@/components/sections/compatibility-matrix";
import { Badge } from "@/components/ui/badge";

const typeGenerator = createGenerator({
  cache: createFileSystemGeneratorCache(".next/fumadocs-typescript"),
});

interface SimplifierType {
  isBoolean: () => boolean;
  isBooleanLiteral: () => boolean;
  isUnion: () => boolean;
  isUndefined: () => boolean;
  getUnionTypes: () => SimplifierType[];
}

// ts-morph decomposes `boolean` into the union `true | false`, so an optional
// `boolean` field arrives here as a union of two boolean literals. Catch both
// shapes and render them as `boolean` rather than fumadocs' default `union`.
const typeTableOptions = {
  typeSimplifier: {
    override: ({ type }: { type: SimplifierType }) => {
      if (type.isBoolean()) {
        return "boolean";
      }
      if (type.isUnion()) {
        const members = type.getUnionTypes().filter((t) => !t.isUndefined());
        if (members.length === 1 && members[0].isBoolean()) {
          return "boolean";
        }
        if (
          members.length === 2 &&
          members.every((t) => t.isBooleanLiteral())
        ) {
          return "boolean";
        }
      }
    },
  },
};

export const getMDXComponents = (
  components?: MDXComponents
): MDXComponents => ({
  ...defaultMdxComponents,
  AdapterInstallation,
  AdaptersIndexServer,
  AutoTypeTable: (props: Partial<AutoTypeTableProps>) => (
    <AutoTypeTable
      {...props}
      generator={typeGenerator}
      options={typeTableOptions}
    />
  ),
  Badge,
  CompatibilityMatrix,
  Tab,
  Tabs,
  ...components,
});

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
