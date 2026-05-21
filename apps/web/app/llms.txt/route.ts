import { llms } from "fumadocs-core/source";

import { source } from "@/lib/source";

export const revalidate = false;

export const GET = () =>
  new Response(llms(source).index(), {
    headers: {
      "Content-Type": "text/markdown",
    },
  });
