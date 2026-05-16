import { readFileSync } from "node:fs";
import { join } from "node:path";

export type ChangeKind = "major" | "minor" | "patch";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "link"; href: string; label: string }
  | { type: "strong"; nodes: InlineNode[] }
  | { type: "em"; nodes: InlineNode[] };

export type ChangelogBlock =
  | { type: "paragraph"; nodes: InlineNode[] }
  | { type: "code"; lang: string; code: string }
  | { type: "list"; items: InlineNode[][] };

export interface ChangelogItem {
  id: string;
  blocks: ChangelogBlock[];
}

export interface ChangelogGroup {
  kind: ChangeKind;
  items: ChangelogItem[];
}

export interface ChangelogRelease {
  version: string;
  slug: string;
  groups: ChangelogGroup[];
}

const HEADING_KIND: Record<string, ChangeKind> = {
  "Major Changes": "major",
  "Minor Changes": "minor",
  "Patch Changes": "patch",
};

const versionToSlug = (version: string) => `v${version.replaceAll(".", "-")}`;

const parseInline = (text: string): InlineNode[] => {
  const nodes: InlineNode[] = [];
  let i = 0;

  const pushText = (value: string) => {
    if (!value) {
      return;
    }
    const last = nodes.at(-1);
    if (last?.type === "text") {
      last.value += value;
      return;
    }
    nodes.push({ type: "text", value });
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        nodes.push({ type: "code", value: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (ch === "[") {
      const close = text.indexOf("]", i + 1);
      if (close !== -1 && text[close + 1] === "(") {
        const hrefEnd = text.indexOf(")", close + 2);
        if (hrefEnd !== -1) {
          const label = text.slice(i + 1, close);
          const href = text.slice(close + 2, hrefEnd);
          nodes.push({ href, label, type: "link" });
          i = hrefEnd + 1;
          continue;
        }
      }
    }

    if (ch === "*" && text[i + 1] === "*") {
      const end = text.indexOf("**", i + 2);
      if (end !== -1) {
        nodes.push({
          nodes: parseInline(text.slice(i + 2, end)),
          type: "strong",
        });
        i = end + 2;
        continue;
      }
    }

    if (ch === "_" && text[i - 1] !== "\\") {
      const end = text.indexOf("_", i + 1);
      if (end !== -1 && end > i + 1) {
        nodes.push({
          nodes: parseInline(text.slice(i + 1, end)),
          type: "em",
        });
        i = end + 1;
        continue;
      }
    }

    pushText(ch);
    i += 1;
  }

  return nodes;
};

const flushParagraph = (buffer: string[], blocks: ChangelogBlock[]) => {
  const text = buffer.join(" ").trim();
  buffer.length = 0;
  if (!text) {
    return;
  }
  blocks.push({ nodes: parseInline(text), type: "paragraph" });
};

const flushList = (
  items: InlineNode[][],
  buffer: string[],
  blocks: ChangelogBlock[]
) => {
  if (buffer.length) {
    items.push(parseInline(buffer.join(" ").trim()));
    buffer.length = 0;
  }
  if (items.length) {
    blocks.push({ items: [...items], type: "list" });
    items.length = 0;
  }
};

const parseItemBody = (lines: string[]): ChangelogBlock[] => {
  const blocks: ChangelogBlock[] = [];
  const paraBuffer: string[] = [];
  const listItems: InlineNode[][] = [];
  const listBuffer: string[] = [];

  let mode: "para" | "list" | "code" = "para";
  let codeLang = "";
  let codeLines: string[] = [];

  const closeList = () => {
    flushList(listItems, listBuffer, blocks);
  };

  const closePara = () => {
    flushParagraph(paraBuffer, blocks);
  };

  for (const line of lines) {
    if (mode === "code") {
      if (line.trimStart().startsWith("```")) {
        blocks.push({
          code: codeLines.join("\n"),
          lang: codeLang,
          type: "code",
        });
        codeLines = [];
        codeLang = "";
        mode = "para";
        continue;
      }
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trimStart();

    if (trimmed.startsWith("```")) {
      closePara();
      closeList();
      codeLang = trimmed.slice(3).trim();
      mode = "code";
      continue;
    }

    if (!line.trim()) {
      if (mode === "list") {
        if (listBuffer.length) {
          listItems.push(parseInline(listBuffer.join(" ").trim()));
          listBuffer.length = 0;
        }
      } else {
        closePara();
      }
      continue;
    }

    if (line.startsWith("- ")) {
      closePara();
      if (mode === "list" && listBuffer.length) {
        listItems.push(parseInline(listBuffer.join(" ").trim()));
        listBuffer.length = 0;
      }
      mode = "list";
      listBuffer.push(line.slice(2).trim());
      continue;
    }

    if (mode === "list") {
      if (/^\s{2,}\S/u.test(line)) {
        listBuffer.push(line.trim());
        continue;
      }
      closeList();
      mode = "para";
    }

    paraBuffer.push(line.trim());
  }

  if (mode === "code") {
    blocks.push({
      code: codeLines.join("\n"),
      lang: codeLang,
      type: "code",
    });
  } else if (mode === "list") {
    closeList();
  } else {
    closePara();
  }

  return blocks;
};

const parseChangelog = (source: string): ChangelogRelease[] => {
  const lines = source.split("\n");
  const releases: ChangelogRelease[] = [];

  let release: ChangelogRelease | null = null;
  let group: ChangelogGroup | null = null;
  let item: { id: string; lines: string[] } | null = null;

  const flushItem = () => {
    if (!item || !group) {
      item = null;
      return;
    }
    group.items.push({ blocks: parseItemBody(item.lines), id: item.id });
    item = null;
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flushItem();
      continue;
    }

    if (line.startsWith("## ")) {
      flushItem();
      group = null;
      const version = line.slice(3).trim();
      release = { groups: [], slug: versionToSlug(version), version };
      releases.push(release);
      continue;
    }

    if (line.startsWith("### ") && release) {
      flushItem();
      const heading = line.slice(4).trim();
      const kind = HEADING_KIND[heading];
      if (!kind) {
        group = null;
        continue;
      }
      group = { items: [], kind };
      release.groups.push(group);
      continue;
    }

    if (!group) {
      continue;
    }

    const itemMatch = /^- ([0-9a-f]{7,40}): (.*)$/u.exec(line);
    if (itemMatch) {
      flushItem();
      item = { id: itemMatch[1], lines: [itemMatch[2]] };
      continue;
    }

    if (!item) {
      continue;
    }

    if (!line.trim()) {
      item.lines.push("");
      continue;
    }

    if (line.startsWith("  ")) {
      item.lines.push(line.slice(2));
      continue;
    }

    // Anything else at column 0 outside a recognized block ends the item.
    flushItem();
  }

  flushItem();
  return releases;
};

const candidatePaths = [
  join(process.cwd(), "..", "..", "packages", "files-sdk", "CHANGELOG.md"),
  join(process.cwd(), "packages", "files-sdk", "CHANGELOG.md"),
];

const readChangelog = (): string => {
  for (const path of candidatePaths) {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      // try next
    }
  }
  throw new Error("Unable to locate packages/files-sdk/CHANGELOG.md");
};

let cached: ChangelogRelease[] | null = null;

export const getChangelog = (): ChangelogRelease[] => {
  if (!cached) {
    cached = parseChangelog(readChangelog());
  }
  return cached;
};

export const getRelease = (slug: string): ChangelogRelease | undefined =>
  getChangelog().find((release) => release.slug === slug);

const inlineToText = (nodes: InlineNode[]): string =>
  nodes
    .map((node) => {
      if (node.type === "text" || node.type === "code") {
        return node.value;
      }
      if (node.type === "link") {
        return node.label;
      }
      return inlineToText(node.nodes);
    })
    .join("");

const blockToText = (block: ChangelogBlock): string => {
  if (block.type === "paragraph") {
    return inlineToText(block.nodes);
  }
  if (block.type === "list") {
    return block.items.map(inlineToText).join(" ");
  }
  return block.code;
};

export interface ReleaseSummary {
  version: string;
  slug: string;
  kinds: ChangeKind[];
  itemCount: number;
  headline: string;
  searchText: string;
}

export const getReleaseSummary = (
  release: ChangelogRelease
): ReleaseSummary => {
  const items = release.groups.flatMap((group) => group.items);
  const firstParagraph = items
    .flatMap((item) => item.blocks)
    .find((block) => block.type === "paragraph");
  const headline = firstParagraph ? blockToText(firstParagraph) : "";
  const searchText = items
    .flatMap((item) => item.blocks.map(blockToText))
    .join(" ")
    .toLowerCase();

  return {
    headline,
    itemCount: items.length,
    kinds: release.groups.map((group) => group.kind),
    searchText,
    slug: release.slug,
    version: release.version,
  };
};
