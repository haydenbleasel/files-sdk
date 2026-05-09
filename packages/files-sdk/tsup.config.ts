import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: [
    "src/index.ts",
    "src/s3/index.ts",
    "src/r2/index.ts",
    "src/vercel-blob/index.ts",
    "src/minio/index.ts",
    "src/gcs/index.ts",
    "src/azure/index.ts",
  ],
  format: ["esm"],
  sourcemap: true,
  splitting: false,
  target: "es2022",
  treeshake: true,
});
