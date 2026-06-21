// Lightweight, display-only TypeScript/JSX tokenizer (ported from the batchwork
// videos package). Code is authored as plain multiline strings and tokenized
// here, so colors stay stable as the editor types a snippet out character by
// character. Not a real parser — just enough lexing for a pretty code window.

export type TokenType =
  | "plain"
  | "keyword"
  | "func"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "property"
  | "punct";

export interface Token {
  text: string;
  type: TokenType;
}

// Token colors, in the files-sdk light palette (same hues the hand-authored
// `code.ts` `colorOf` uses, spread across the nine token types) so this window
// matches the rest of the package.
export const TOKEN_COLOR: Record<TokenType, string> = {
  comment: "#9CA3AF",
  func: "#1F2937",
  keyword: "#059669",
  number: "#B45309",
  plain: "#374151",
  property: "#1F2937",
  punct: "#94A3B8",
  string: "#B45309",
  type: "#0E7490",
};

const KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "const",
  "let",
  "var",
  "function",
  "return",
  "await",
  "async",
  "for",
  "of",
  "in",
  "if",
  "else",
  "new",
  "as",
  "type",
  "interface",
  "extends",
  "implements",
  "class",
  "try",
  "catch",
  "finally",
  "throw",
  "void",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
  "this",
  "typeof",
]);

type RawKind = "comment" | "string" | "number" | "ident" | "space" | "punct";
interface Raw {
  text: string;
  kind: RawKind;
}

// Single regex scanner: comments, then strings (incl. template literals),
// numbers, identifiers, whitespace, and finally any other single character.
const SCAN =
  /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(?<string>`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(?<number>\b\d[\d_]*(?:\.\d+)?\b)|(?<ident>[A-Za-z_$][\w$]*)|(?<space>\s+)|(?<punct>[^\s])/gu;

const nextMeaningful = (raw: Raw[], i: number): Raw | undefined => {
  for (let j = i + 1; j < raw.length; j += 1) {
    const t = raw[j];
    if (t && t.kind !== "space") {
      return t;
    }
  }
  return undefined;
};

const prevMeaningful = (raw: Raw[], i: number): Raw | undefined => {
  for (let j = i - 1; j >= 0; j -= 1) {
    const t = raw[j];
    if (t && t.kind !== "space") {
      return t;
    }
  }
  return undefined;
};

// Group names on SCAN, in priority order, paired with the Raw kind they map to.
const SCAN_GROUPS: { name: string; kind: RawKind }[] = [
  { kind: "comment", name: "comment" },
  { kind: "string", name: "string" },
  { kind: "number", name: "number" },
  { kind: "ident", name: "ident" },
  { kind: "space", name: "space" },
  { kind: "punct", name: "punct" },
];

// Split a line into raw lexical chunks via the single SCAN regex.
const scanRaw = (line: string): Raw[] => {
  const raw: Raw[] = [];
  SCAN.lastIndex = 0;
  let m: RegExpExecArray | null = SCAN.exec(line);
  while (m !== null) {
    // `.groups` needs the es2018 lib type; the package targets es2015, so read
    // it through a cast (named capture groups work fine at runtime).
    const g = (m as { groups?: Record<string, string | undefined> }).groups;
    for (const { name, kind } of SCAN_GROUPS) {
      const text = g?.[name];
      if (text !== undefined) {
        raw.push({ kind, text });
        break;
      }
    }
    m = SCAN.exec(line);
  }
  return raw;
};

// Classify an identifier as keyword / func / property / type / plain by context.
const classifyIdent = (t: Raw, raw: Raw[], i: number): TokenType => {
  if (KEYWORDS.has(t.text)) {
    return "keyword";
  }
  const next = nextMeaningful(raw, i);
  if (next?.kind === "punct" && next.text === "(") {
    return "func";
  }
  const prev = prevMeaningful(raw, i);
  if (prev?.kind === "punct" && prev.text === ".") {
    return "property";
  }
  if (/^[A-Z]/u.test(t.text)) {
    return "type";
  }
  return "plain";
};

/** Tokenize a single line of TypeScript/JSX for display-only highlighting. */
export const tokenizeLine = (line: string): Token[] => {
  const raw = scanRaw(line);
  const tokens: Token[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i];
    if (!t) {
      continue;
    }
    if (t.kind === "ident") {
      tokens.push({ text: t.text, type: classifyIdent(t, raw, i) });
    } else {
      tokens.push({
        text: t.text,
        type: t.kind === "space" ? "plain" : t.kind,
      });
    }
  }

  return tokens;
};

/** Reveal a line's tokens up to `budget` characters (stable colors as it types). */
export const sliceTokens = (line: string, budget: number): Token[] => {
  const tokens = tokenizeLine(line);
  if (budget >= line.length) {
    return tokens;
  }
  const out: Token[] = [];
  let remaining = budget;
  for (const token of tokens) {
    if (remaining <= 0) {
      break;
    }
    if (token.text.length <= remaining) {
      out.push(token);
      remaining -= token.text.length;
    } else {
      out.push({ text: token.text.slice(0, remaining), type: token.type });
      remaining = 0;
    }
  }
  return out;
};
