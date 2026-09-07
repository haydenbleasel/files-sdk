export type TokenKind = "kw" | "str" | "cm" | "fn" | "tg" | "at" | "br";
export type Token = readonly [text: string, kind?: TokenKind];
export type Line = readonly Token[];

export type AdapterId = "s3" | "r2" | "vercelBlob" | "minio";

export const ADAPTERS: Record<
  AdapterId,
  { name: string; importPath: string; label: string }
> = {
  minio: { importPath: "files-sdk/minio", label: "MinIO", name: "minio" },
  r2: { importPath: "files-sdk/r2", label: "Cloudflare R2", name: "r2" },
  s3: { importPath: "files-sdk/s3", label: "AWS S3", name: "s3" },
  vercelBlob: {
    importPath: "files-sdk/vercel-blob",
    label: "Vercel Blob",
    name: "vercelBlob",
  },
};

export const buildLines = (adapter: AdapterId): Line[] => {
  const a = ADAPTERS[adapter];
  return [
    [
      ["import", "kw"],
      [" { Files } "],
      ["from", "kw"],
      [" "],
      ["'files-sdk'", "str"],
    ],
    [
      ["import", "kw"],
      [` { ${a.name} } `],
      ["from", "kw"],
      [" "],
      [`'${a.importPath}'`, "str"],
    ],
    [],
    [["const", "kw"], [" files = "], ["new", "kw"], [" Files({"]],
    [[`  adapter: ${a.name}({ bucket: `], ["'photos'", "str"], [" })"]],
    [["})"]],
    [],
    [["// 1. Show the user's files", "cm"]],
    [["const", "kw"], [" items = "], ["await", "kw"], [" files.list()"]],
    [
      ["items.map(f => "],
      ["<", "tg"],
      ["Row", "tg"],
      [" "],
      ["name", "at"],
      ["="],
      ["{", "br"],
      ["f.key"],
      ["}", "br"],
      [" "],
      ["size", "at"],
      ["="],
      ["{", "br"],
      ["f.size"],
      ["}", "br"],
      [" "],
      ["modified", "at"],
      ["="],
      ["{", "br"],
      ["f.modified"],
      ["}", "br"],
      [" "],
      ["/>", "tg"],
      [")"],
    ],
    [],
    [["// 2. Upload from the UI", "cm"]],
    [
      ["<", "tg"],
      ["button", "tg"],
      [" "],
      ["onClick", "at"],
      ["="],
      ["{", "br"],
      ["(e) => files.upload("],
      ["'filename'", "str"],
      [", e.file)"],
      ["}", "br"],
      [">", "tg"],
      ["↑ Upload"],
      ["</", "tg"],
      ["button", "tg"],
      [">", "tg"],
    ],
    [],
    [["// 3. Delete from the UI", "cm"]],
    [
      ["<", "tg"],
      ["button", "tg"],
      [" "],
      ["onClick", "at"],
      ["="],
      ["{", "br"],
      ["() => files.delete(key)"],
      ["}", "br"],
      [">", "tg"],
      ["×"],
      ["</", "tg"],
      ["button", "tg"],
      [">", "tg"],
    ],
    [],
    [["// 4. Download from the UI", "cm"]],
    [
      ["<", "tg"],
      ["button", "tg"],
      [" "],
      ["onClick", "at"],
      ["="],
      ["{", "br"],
      ["() => files.download(key)"],
      ["}", "br"],
      [">", "tg"],
      ["↓"],
      ["</", "tg"],
      ["button", "tg"],
      [">", "tg"],
    ],
  ];
};

export const STEP_LINES = {
  delete: 15,
  download: 18,
  list: 9,
  upload: 12,
} as const;

export const totalChars = (lines: Line[]): number => {
  let n = 0;
  for (let i = 0; i < lines.length; i += 1) {
    for (const tok of lines[i]) {
      n += tok[0].length;
    }
    if (i < lines.length - 1) {
      n += 1;
    }
  }
  return n;
};

export const flattenLines = (lines: Line[]): string => {
  let out = "";
  for (let i = 0; i < lines.length; i += 1) {
    for (const tok of lines[i]) {
      out += tok[0];
    }
    if (i < lines.length - 1) {
      out += "\n";
    }
  }
  return out;
};

export const charsAtEndOfLine = (lines: Line[], idx: number): number => {
  let n = 0;
  for (let i = 0; i <= idx; i += 1) {
    for (const tok of lines[i]) {
      n += tok[0].length;
    }
    if (i < idx) {
      n += 1;
    }
  }
  return n;
};

export const colorOf = (kind?: TokenKind): string => {
  switch (kind) {
    case "kw": {
      return "#059669";
    }
    case "str": {
      return "#B45309";
    }
    case "cm": {
      return "#9CA3AF";
    }
    case "fn": {
      return "#1F2937";
    }
    case "tg": {
      return "#7C3AED";
    }
    case "at": {
      return "#0E7490";
    }
    case "br": {
      return "#94A3B8";
    }
    default: {
      return "#374151";
    }
  }
};

export interface RenderedLine {
  tokens: Token[];
  partial: boolean;
  empty: boolean;
}

export interface RenderedCode {
  rendered: RenderedLine[];
  /** Index of the line the caret currently sits on; -1 before typing starts. */
  activeLine: number;
}

export const renderLines = (lines: Line[], budget: number): RenderedCode => {
  const out: RenderedLine[] = [];
  let consumed = 0;
  let active = -1;
  let exhausted = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (exhausted) {
      out.push({ empty: true, partial: false, tokens: [] });
      continue;
    }
    const line = lines[i];
    const lineLen = line.reduce((s, t) => s + t[0].length, 0);
    const remaining = budget - consumed;
    if (remaining <= 0 && lineLen > 0) {
      out.push({ empty: true, partial: false, tokens: [] });
      exhausted = true;
      continue;
    }
    if (remaining < lineLen) {
      let r = remaining;
      const partial: Token[] = [];
      for (const tok of line) {
        if (r <= 0) {
          break;
        }
        if (tok[0].length <= r) {
          partial.push(tok);
          r -= tok[0].length;
        } else {
          partial.push([tok[0].slice(0, r), tok[1]]);
          r = 0;
        }
      }
      out.push({ empty: false, partial: true, tokens: partial });
      active = i;
      exhausted = true;
      consumed = budget;
    } else {
      out.push({
        empty: line.length === 0,
        partial: false,
        tokens: [...line],
      });
      active = i;
      consumed += lineLen + (i < lines.length - 1 ? 1 : 0);
    }
  }
  return { activeLine: active, rendered: out };
};
