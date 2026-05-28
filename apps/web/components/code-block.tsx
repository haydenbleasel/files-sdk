import { highlight } from "fumadocs-core/highlight";
import { CodeBlock as Container, Pre } from "fumadocs-ui/components/codeblock";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  lang: string;
  // Forwarded to the figure. Lets callers strip the default chrome (border,
  // rounding, background) so the block can sit inside another container.
  className?: string;
}

// Highlights server-side with the same shiki path and vitesse themes as the
// docs (see source.config.ts), so there's no client-side flash and the theme
// matches. Replaces fumadocs' DynamicCodeBlock, which highlights in the browser
// and defaults to the github themes.
export const CodeBlock = ({ code, lang, className }: CodeBlockProps) =>
  highlight(code, {
    components: {
      pre: (props: ComponentProps<"pre">) => (
        <Container {...props} className={cn(props.className, className)}>
          <Pre>{props.children}</Pre>
        </Container>
      ),
    },
    // Emit only --shiki-light / --shiki-dark CSS vars (no inline color), so
    // fumadocs-ui's CSS can swap to the dark theme under `.dark`.
    defaultColor: false,
    lang,
    themes: {
      dark: "vitesse-dark",
      light: "vitesse-light",
    },
  });
