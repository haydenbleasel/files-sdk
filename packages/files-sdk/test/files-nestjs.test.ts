// oxlint-disable unicorn/no-await-expression-member -- asserting `.status` off awaited Responses is the natural shape here.
// oxlint-disable max-classes-per-file, typescript/no-extraneous-class -- Nest modules are (often empty) marker classes; this file necessarily declares a few.
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Injectable, Module } from "@nestjs/common";
import type { INestApplication, ModuleMetadata, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";

import type { FilesApi } from "../src/api/index.js";
import { createFiles } from "../src/index.js";
import type { Files } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import {
  FILES,
  FILES_API,
  FilesModule,
  InjectFiles,
} from "../src/nestjs/index.js";

// Drive the module through real Nest apps on both platform adapters, so the
// MiddlewareConsumer mount, the DI providers, and the raw-body path are all
// exercised end-to-end. The SDK (and this test) compiles without
// `experimentalDecorators`, so Nest decorators are applied imperatively —
// exactly what the decorator syntax compiles to.

/** A `@Module(metadata) class {}` without decorator syntax. */
const moduleWith = (metadata: ModuleMetadata): Type => {
  class DynamicTestModule {}
  Module(metadata)(DynamicTestModule);
  return DynamicTestModule;
};

/** A service holding an `@InjectFiles()` constructor parameter. */
class UploadsService {
  readonly files: Files;

  constructor(files: Files) {
    this.files = files;
  }
}
Injectable()(UploadsService);
InjectFiles()(UploadsService, undefined, 0);

let app: INestApplication | undefined;

const baseUrlOf = (instance: INestApplication): string => {
  const addr = (instance.getHttpServer() as Server).address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
};

const bootExpress = async (root: Type): Promise<string> => {
  // `bodyParser: false` — Nest's global body-parser would consume the raw
  // stream before the consumer middleware runs (see the binding's docs).
  app = await NestFactory.create(root, { bodyParser: false, logger: false });
  await app.listen(0, "127.0.0.1");
  return baseUrlOf(app);
};

const bootFastify = async (root: Type): Promise<string> => {
  // No content-type parser workaround here on purpose: middleware runs at
  // `onRequest`, before Fastify's body parsing, so the stream stays intact.
  app = await NestFactory.create(root, new FastifyAdapter(), { logger: false });
  await app.listen(0, "127.0.0.1");
  return baseUrlOf(app);
};

const capabilities = (url: string): Promise<Response> =>
  fetch(url, {
    body: JSON.stringify({ op: "capabilities" }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("files-sdk/nestjs", () => {
  test("forRoot mounts the gateway at the default path and exposes DI (Express adapter)", async () => {
    const files = createFiles({ adapter: memory() });
    // A sibling module with no imports: the default `global: true` must make
    // `InjectFiles()` resolve without importing `FilesModule`.
    const servicesModule = moduleWith({ providers: [UploadsService] });
    const root = moduleWith({
      imports: [
        FilesModule.forRoot({
          files,
          operations: ["capabilities"],
          secret: "test-secret",
        }),
        servicesModule,
      ],
    });
    const base = await bootExpress(root);

    const res = await capabilities(`${base}/api/files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: { delimiter: boolean } };
    expect(typeof body.capabilities.delimiter).toBe("boolean");

    expect(app?.get(UploadsService).files).toBe(files);
    expect(app?.get<Files>(FILES)).toBe(files);
    expect(typeof app?.get<FilesApi>(FILES_API).handle).toBe("function");
  });

  test("forRootAsync resolves options from injected providers and mounts at a custom path", async () => {
    const files = createFiles({ adapter: memory() });
    const CONFIG = Symbol("test-config");
    const configModule = moduleWith({
      exports: [CONFIG],
      providers: [{ provide: CONFIG, useValue: { mount: "/files" } }],
    });
    const root = moduleWith({
      imports: [
        FilesModule.forRootAsync({
          global: false,
          imports: [configModule],
          inject: [CONFIG],
          useFactory: (config: { mount: string }) => ({
            files,
            operations: ["capabilities"],
            path: config.mount,
            secret: "test-secret",
          }),
        }),
      ],
    });
    const base = await bootExpress(root);

    expect((await capabilities(`${base}/files`)).status).toBe(200);
    // Nothing answers at the default path once a custom one is configured.
    expect((await capabilities(`${base}/api/files`)).status).toBe(404);
    expect(app?.get<Files>(FILES)).toBe(files);
  });

  test("serves under the Fastify adapter with no body-parser configuration", async () => {
    const root = moduleWith({
      imports: [
        FilesModule.forRoot({
          files: createFiles({ adapter: memory() }),
          operations: ["capabilities"],
          secret: "test-secret",
        }),
      ],
    });
    const base = await bootFastify(root);

    const res = await capabilities(`${base}/api/files`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { capabilities: { delimiter: boolean } };
    expect(typeof body.capabilities.delimiter).toBe("boolean");
  });
});
