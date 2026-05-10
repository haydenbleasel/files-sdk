import type { BundledLanguage } from "shiki";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { CodeBlock } from "./code-block";

export interface CodeTab {
  id: string;
  label: string;
  code: string;
  lang: BundledLanguage;
}

interface CodeTabsProps {
  tabs: readonly CodeTab[];
  defaultValue?: string;
}

export const CodeTabs = ({ tabs, defaultValue }: CodeTabsProps) => (
  <Tabs
    className="gap-0 rounded-xl bg-sidebar"
    defaultValue={defaultValue ?? tabs[0]?.id}
  >
    <div className="mx-3 mt-4 -mb-2 overflow-x-auto overflow-y-hidden scrollbar-hide">
      <TabsList className="bg-transparent">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
    {tabs.map((tab) => (
      <TabsContent key={tab.id} value={tab.id}>
        <CodeBlock
          className="rounded-none border-0 bg-transparent"
          code={tab.code}
          lang={tab.lang}
        />
      </TabsContent>
    ))}
  </Tabs>
);
