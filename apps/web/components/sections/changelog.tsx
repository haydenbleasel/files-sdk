import { DynamicCodeBlock } from "fumadocs-ui/components/dynamic-codeblock";

import type {
  ChangeKind,
  ChangelogBlock,
  ChangelogRelease,
  InlineNode,
} from "@/lib/changelog";

const KIND_LABEL: Record<ChangeKind, string> = {
  major: "Major",
  minor: "Minor",
  patch: "Patch",
};

const KIND_CLASS: Record<ChangeKind, string> = {
  major: "border-foreground/30 text-foreground",
  minor: "border-foreground/20 text-foreground",
  patch: "border-dotted text-muted-foreground",
};

const SUPPORTED_LANGS: ReadonlySet<string> = new Set([
  "bash",
  "javascript",
  "js",
  "json",
  "jsonc",
  "tsx",
  "ts",
  "typescript",
  "yaml",
]);

const normalizeLang = (lang: string): string => {
  const candidate = lang.toLowerCase();
  if (SUPPORTED_LANGS.has(candidate)) {
    return candidate;
  }
  return "ts";
};

const renderInline = (nodes: InlineNode[]) =>
  nodes.map((node, index) => {
    const key = `${index}`;
    if (node.type === "text") {
      return <span key={key}>{node.value}</span>;
    }
    if (node.type === "code") {
      return <code key={key}>{node.value}</code>;
    }
    if (node.type === "strong") {
      return <strong key={key}>{renderInline(node.nodes)}</strong>;
    }
    if (node.type === "em") {
      return <em key={key}>{renderInline(node.nodes)}</em>;
    }
    return (
      <a
        key={key}
        href={node.href}
        rel="noreferrer"
        target="_blank"
        className="underline underline-offset-4 decoration-dotted decoration-muted-foreground/60 hover:decoration-foreground"
      >
        {node.label}
      </a>
    );
  });

const renderBlock = (block: ChangelogBlock, key: string) => {
  if (block.type === "paragraph") {
    return <p key={key}>{renderInline(block.nodes)}</p>;
  }
  if (block.type === "list") {
    return (
      <ul key={key}>
        {block.items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- stable order within an item
          <li key={`${key}-${index}`}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }
  return (
    <DynamicCodeBlock
      key={key}
      code={block.code}
      lang={normalizeLang(block.lang)}
    />
  );
};

export const KindBadge = ({ kind }: { kind: ChangeKind }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${KIND_CLASS[kind]}`}
  >
    {KIND_LABEL[kind]}
  </span>
);

export const Release = ({ release }: { release: ChangelogRelease }) => (
  <section>
    {release.groups.map((group) => (
      <div
        className="flex flex-col gap-4"
        key={`${release.slug}-${group.kind}`}
      >
        {release.groups.length > 1 ? (
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-semibold tracking-tight capitalize">
              {group.kind} Updates
            </h2>
          </div>
        ) : null}
        <ul className="flex list-none flex-col gap-6 pl-0">
          {group.items.map((item, itemIndex) => (
            <li
              // oxlint-disable-next-line react/no-array-index-key -- multiple items can share a commit id (changesets bundles them)
              key={`${item.id}-${itemIndex}`}
              className="flex flex-col gap-3 border-t border-dotted pt-6 first:border-t-0 first:pt-0"
            >
              <div className="flex items-center gap-2">
                {release.groups.length === 1 ? (
                  <KindBadge kind={group.kind} />
                ) : null}
                <a
                  href={`https://github.com/haydenbleasel/files-sdk/commit/${item.id}`}
                  rel="noreferrer"
                  target="_blank"
                  className="font-mono text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {item.id.slice(0, 7)}
                </a>
              </div>
              {item.blocks.map((block, index) =>
                renderBlock(block, `${item.id}-${index}`)
              )}
            </li>
          ))}
        </ul>
      </div>
    ))}
  </section>
);
