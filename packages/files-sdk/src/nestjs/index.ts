// `files-sdk/nestjs` — first-class NestJS integration (issue #95). A dynamic
// `FilesModule` configures the gateway (`createFilesRouter`), exposes the
// `Files` instance through Nest's DI (`FILES` token / `InjectFiles()`), and
// mounts the endpoint itself via `MiddlewareConsumer` at a configurable path.
// Mounting as *middleware* (not a controller) matters: under the Fastify
// adapter, middleware runs before Fastify's content-type parsers, so the raw
// request stream reaches the gateway untouched with no parser configuration.
//
//   @Module({
//     imports: [
//       FilesModule.forRoot({
//         files: createFiles({ adapter: s3({ bucket: "uploads" }) }),
//         operations: ["upload", "download", "list", "delete", "url"],
//         path: "/api/files",
//       }),
//     ],
//   })
//   export class AppModule {}
//
//   // main.ts — Express adapter only: Nest registers `body-parser` globally
//   // BEFORE consumer middleware, and a parsed body never reaches the gateway.
//   const app = await NestFactory.create(AppModule, { bodyParser: false });
//
// IMPORTANT (Express adapter): create the app with `bodyParser: false` and
// re-register parsers scoped to your own routes, or the gateway's JSON verbs
// and raw uploads read an already-consumed stream. The Fastify adapter needs
// no such flag — middleware runs at `onRequest`, ahead of body parsing.

import type { ServerResponse } from "node:http";

import type {
  DynamicModule,
  FactoryProvider,
  MiddlewareConsumer,
  ModuleMetadata,
  NestModule,
  Provider,
} from "@nestjs/common";
import { Inject, Module, RequestMethod } from "@nestjs/common";

import type { CreateFilesRouterOptions, FilesApi } from "../api/index.js";
import { createFilesRouter } from "../api/index.js";
import type { Files } from "../index.js";
import { handleNodeRequest } from "../internal/node-http.js";
import type { NodeLikeRequest } from "../internal/node-http.js";

/** Injection token for the configured `Files` instance — see `InjectFiles()`. */
export const FILES = Symbol("files-sdk/nestjs:FILES");

/** Injection token for the mounted gateway router — for manual wiring or tests. */
export const FILES_API = Symbol("files-sdk/nestjs:FILES_API");

/** Internal token carrying the resolved options into providers + `configure`. */
const FILES_MODULE_OPTIONS = Symbol("files-sdk/nestjs:FILES_MODULE_OPTIONS");

const DEFAULT_PATH = "/api/files";

export interface FilesModuleOptions extends Omit<
  CreateFilesRouterOptions,
  "files"
> {
  /**
   * The `Files` instance shared through DI and served by the gateway. The
   * per-request factory form of `CreateFilesRouterOptions.files` is not
   * supported here (there is no single instance to provide) — mount
   * `files-sdk/express` manually for multi-tenant routing.
   */
  files: Files;
  /** Register as a global module so `InjectFiles()` works everywhere without importing `FilesModule`. Default true. */
  global?: boolean;
  /** Mount path for the gateway endpoint. Default `"/api/files"`. */
  path?: string;
}

export interface FilesModuleAsyncOptions extends Pick<
  ModuleMetadata,
  "imports"
> {
  /** Same as `FilesModuleOptions.global`; lives here because a `DynamicModule` needs it before the factory runs. Default true. */
  global?: boolean;
  inject?: FactoryProvider["inject"];
  useFactory: (
    ...args: never[]
  ) => FilesModuleOptions | Promise<FilesModuleOptions>;
}

/** Constructor-parameter decorator injecting the configured `Files` instance. */
export const InjectFiles = (): ReturnType<typeof Inject> => Inject(FILES);

const sharedProviders: Provider[] = [
  {
    inject: [FILES_MODULE_OPTIONS],
    provide: FILES,
    useFactory: (options: FilesModuleOptions): Files => options.files,
  },
  {
    inject: [FILES_MODULE_OPTIONS],
    provide: FILES_API,
    useFactory: (options: FilesModuleOptions): FilesApi =>
      createFilesRouter(options),
  },
];

export class FilesModule implements NestModule {
  static forRoot(options: FilesModuleOptions): DynamicModule {
    return {
      exports: [FILES, FILES_API],
      global: options.global ?? true,
      module: FilesModule,
      providers: [
        { provide: FILES_MODULE_OPTIONS, useValue: options },
        ...sharedProviders,
      ],
    };
  }

  static forRootAsync(options: FilesModuleAsyncOptions): DynamicModule {
    return {
      exports: [FILES, FILES_API],
      global: options.global ?? true,
      imports: options.imports,
      module: FilesModule,
      providers: [
        {
          inject: options.inject ?? [],
          provide: FILES_MODULE_OPTIONS,
          useFactory: options.useFactory,
        },
        ...sharedProviders,
      ],
    };
  }

  private readonly options: FilesModuleOptions;

  private readonly api: FilesApi;

  constructor(options: FilesModuleOptions, api: FilesApi) {
    this.options = options;
    this.api = api;
  }

  configure(consumer: MiddlewareConsumer): void {
    // `next` is deliberately never called — the gateway owns this route
    // entirely. `handleNodeRequest` never rejects (transport failures answer
    // 500 internally), so the floated promise cannot surface an unhandled
    // rejection. Three params keep it a normal middleware for Express/middie
    // (a 4-arity function would register as an error handler).
    const middleware = (
      req: NodeLikeRequest,
      res: ServerResponse,
      _next: () => void
    ): void => {
      void handleNodeRequest(this.api, req, res);
    };
    consumer.apply(middleware).forRoutes({
      method: RequestMethod.ALL,
      path: this.options.path ?? DEFAULT_PATH,
    });
  }
}

// The SDK builds without `experimentalDecorators`, so the Nest decorators are
// applied imperatively — exactly what the decorator syntax compiles to. The
// explicit `Inject` param metadata also removes the `emitDecoratorMetadata`
// requirement consumers' compilers would otherwise need to satisfy.
Module({})(FilesModule);
Inject(FILES_MODULE_OPTIONS)(FilesModule, undefined, 0);
Inject(FILES_API)(FilesModule, undefined, 1);
