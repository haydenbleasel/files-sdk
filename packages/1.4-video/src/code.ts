export type TokenKind =
  | "kw"
  | "str"
  | "cm"
  | "fn"
  | "tg"
  | "at"
  | "br"
  | "ok"
  | "no";
export type Token = readonly [text: string, kind?: TokenKind];
export type Line = readonly Token[];

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
    case "ok": {
      return "#047857";
    }
    case "no": {
      return "#B91C1C";
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

export const renderLines = (
  lines: Line[],
  budget: number
): { rendered: RenderedLine[]; activeLine: number } => {
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
