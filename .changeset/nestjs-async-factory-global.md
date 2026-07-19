---
"files-sdk": patch
---

`FilesModule.forRootAsync()`: the `useFactory` return type now excludes `global` (new `FilesModuleFactoryResult` type). A `global` returned from the factory was silently ignored — the `DynamicModule` needs it before the factory runs, so it only takes effect on `FilesModuleAsyncOptions` itself. Returning it from the factory is now a type error instead of a no-op.
