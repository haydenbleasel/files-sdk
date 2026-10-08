// A deliberately small TypeScript tokenizer for the landing pages' hand-set
// code samples. Shiki themes can't express the brand (highlighted lines in
// highlighter lime, ink-on-lime tokens in both modes), and these snippets are
// short and known, so keywords, strings, numbers, and comments are enough.

export type TokenKind = "comment" | "keyword" | "number" | "plain" | "string";

export interface Token {
  kind: TokenKind;
  text: string;
}

const KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "catch",
  "const",
  "else",
  "export",
  "from",
  "function",
  "if",
  "import",
  "let",
  "new",
  "return",
  "throw",
  "try",
]);

// Comments, then strings, then numbers, then identifiers; anything between
// matches is plain text.
const PATTERN =
  /(?<comment>\/\/.*$)|(?<string>"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(?<number>\d+)\b|\b(?<word>[A-Za-z_$][\w$]*)\b/gu;

const kindOf = (groups: Record<string, string | undefined>): TokenKind => {
  if (groups.comment !== undefined) {
    return "comment";
  }
  if (groups.string !== undefined) {
    return "string";
  }
  if (groups.number !== undefined) {
    return "number";
  }
  if (groups.word !== undefined && KEYWORDS.has(groups.word)) {
    return "keyword";
  }
  return "plain";
};

/** Split one line of TypeScript into colored tokens. */
export const tokenizeLine = (line: string): Token[] => {
  const tokens: Token[] = [];
  let cursor = 0;
  for (const match of line.matchAll(PATTERN)) {
    const start = match.index;
    if (start > cursor) {
      tokens.push({ kind: "plain", text: line.slice(cursor, start) });
    }
    tokens.push({ kind: kindOf(match.groups ?? {}), text: match[0] });
    cursor = start + match[0].length;
  }
  if (cursor < line.length) {
    tokens.push({ kind: "plain", text: line.slice(cursor) });
  }
  return tokens;
};

/** Split a snippet into lines of tokens. */
export const tokenize = (code: string): Token[][] =>
  code.split("\n").map(tokenizeLine);
