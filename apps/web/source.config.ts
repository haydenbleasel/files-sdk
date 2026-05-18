import { metaSchema, pageSchema } from "fumadocs-core/source/schema";
import { defineConfig, defineDocs } from "fumadocs-mdx/config";
import { z } from "zod";

export const docs = defineDocs({
  dir: "content/docs",
  docs: {
    schema: pageSchema.extend({
      peerDeps: z.array(z.string()).optional(),
    }),
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        dark: "vitesse-dark",
        light: "vitesse-light",
      },
    },
  },
});
