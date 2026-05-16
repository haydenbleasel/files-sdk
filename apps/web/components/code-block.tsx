import bash from "@shikijs/langs/bash";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsonc from "@shikijs/langs/jsonc";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import darkTheme from "@shikijs/themes/vitesse-dark";
import lightTheme from "@shikijs/themes/vitesse-light";
import type { BundledLanguage } from "shiki";
import { createHighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";
import shikiWasm from "shiki/wasm";

import { cn } from "@/lib/utils";

interface CodeBlockProps {
  className?: string;
  code: string;
  lang: BundledLanguage;
}

let highlighterPromise: ReturnType<typeof createHighlighterCore> | null = null;

const getHighlighter = () => {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      // `shiki/wasm` contains the wasm binary inlined as base64 string.
      engine: createOnigurumaEngine(shikiWasm),
      langs: [javascript, json, bash, typescript, jsonc, tsx, yaml],
      themes: [lightTheme, darkTheme],
    });
  }

  return highlighterPromise;
};

export const CodeBlock = async ({ code, lang, className }: CodeBlockProps) => {
  const highlighter = await getHighlighter();

  const result = highlighter.codeToTokens(code, {
    lang,
    themes: {
      dark: darkTheme,
      light: lightTheme,
    },
  });

  return (
    <pre
      className={cn(
        className,
        "overflow-x-auto p-6 text-sm bg-sidebar rounded-lg"
      )}
      data-language={lang}
      // Geist Mono ships ligatures/contextual alternates that span text-node
      // boundaries — without this, `<space>--flag` collapses visually even
      // though the whitespace exists in the DOM. Spans from Shiki put each
      // token in its own <span>, but Harfbuzz still shapes across them.
      style={{
        color: result.fg,
        fontFeatureSettings: '"liga" 0, "calt" 0',
        fontVariantLigatures: "none",
      }}
    >
      <code>
        {result.tokens.map((row, index) => (
          <span
            className="block min-h-[1lh]"
            // oxlint-disable-next-line react/no-array-index-key -- tokens have no unique ID
            key={`line-${String(index)}`}
          >
            {row.map((token, tokenIndex) => (
              <span
                // oxlint-disable-next-line react/no-array-index-key -- tokens have no unique ID
                key={`token-${String(index)}-${String(tokenIndex)}`}
                style={{
                  backgroundColor: token.bgColor,
                  color: token.color,
                  ...token.htmlStyle,
                }}
                {...token.htmlAttrs}
              >
                {token.content}
              </span>
            ))}
          </span>
        ))}
      </code>
    </pre>
  );
};
