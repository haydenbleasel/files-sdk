---
"files-sdk": minor
---

Add first-class NestJS support (#95). New `files-sdk/nestjs` subpath exports a dynamic `FilesModule` (`forRoot()` / `forRootAsync()`) that configures the gateway, mounts it at a configurable `path` (default `/api/files`) through Nest's middleware layer, and shares the `Files` instance via DI — `@InjectFiles()` / `FILES` token, with the configured router under `FILES_API`. Works on both the Express adapter (create the app with `bodyParser: false`) and the Fastify adapter (no parser configuration needed — middleware runs before body parsing). `@nestjs/common` is a new optional peer dependency.
