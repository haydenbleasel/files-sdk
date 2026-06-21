// The store-level svelte suite (use-files-svelte.test.ts) never imports the real
// Svelte runtime — it reads the hand-rolled `writable` directly. This suite
// closes that gap: it compiles a real `.svelte` component through the Svelte 5
// compiler and mounts it under happy-dom, so the binding actually runs through
// Svelte's client runtime and `$store` auto-subscription. That's the only thing
// that proves the custom `writable` is structurally compatible with `Readable`
// (the type-only contract the binding leans on) inside a component.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { plugin } from "bun";
import { compile } from "svelte/compiler";

import type { Transport } from "../src/client/transport.js";
import type { Adapter } from "../src/index.js";
import type { UseFilesReturn } from "../src/svelte/use-files.js";

// Bun's *bundler* can't compile Svelte (hence the store-based binding), but a
// runtime loader plugin can. Registered before the dynamic `import()` below so
// it intercepts the `.svelte` fixture.
plugin({
  name: "svelte-loader",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/u }, async (args) => {
      const source = await Bun.file(args.path).text();
      const { js } = compile(source, {
        filename: args.path,
        generate: "client",
      });
      return { contents: js.code, loader: "js" };
    });
  },
});

beforeAll(() => GlobalRegistrator.register());
afterAll(() => GlobalRegistrator.unregister());

// `import("svelte")` resolves to the *server* build (its `default` condition),
// where `mount` throws. Reach the client entry by absolute path instead — its
// deep internals (the scheduler, etc.) still resolve to the same files the
// compiled component's `svelte/internal/client` imports, so reactivity is shared.
const svelteClient = join(
  dirname(Bun.resolveSync("svelte/package.json", import.meta.dir)),
  "src/index-client.js"
);
const { mount, unmount, flushSync } = await import(svelteClient);
const { createFiles } = await import("../src/index.js");
const { createFilesRouter } = await import("../src/api/index.js");
const { memory } = await import("../src/memory/index.js");
const probeModule = await import("./fixtures/use-files-probe.svelte");
const Probe = probeModule.default;

const config = (adapter: Adapter) => {
  const router = createFilesRouter({
    allowedOrigins: () => true,
    files: createFiles({ adapter }),
    operations: ["head", "upload", "download"],
    secret: "svelte-component-secret",
  });
  // Route both surfaces at the in-memory router so nothing hits happy-dom's
  // real networked `fetch`.
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
    router.handle(new Request(input, init))) as typeof fetch;
  const transport: Transport = async (req) => {
    req.onProgress?.(req.body?.size ?? 0, req.body?.size ?? 0);
    const res = await router.handle(
      new Request(req.url, {
        body: req.body,
        headers: req.headers,
        method: req.method,
      })
    );
    return { status: res.status, text: await res.text() };
  };
  return { endpoint: "https://app.test/api/files", fetchImpl, transport };
};

const cell = (target: Element, id: string): string =>
  target.querySelector(`[data-testid="${id}"]`)?.textContent ?? "";

describe("svelte useFiles inside a real component", () => {
  test("mounts, auto-subscribes, and reflects store changes in the DOM", async () => {
    // A detached target is enough — Svelte renders into it and `flushSync()`
    // drives effects regardless of whether it's attached to the document.
    const target = document.createElement("div");

    let files: UseFilesReturn | undefined;
    const component = mount(Probe, {
      props: {
        config: config(memory()),
        onReady: (f: UseFilesReturn) => {
          files = f;
        },
      },
      target,
    });

    // mounting ran `useFiles` inside the component without throwing, and the
    // initial render reflects each store's default straight through `$`.
    expect(files).toBeDefined();
    expect(cell(target, "uploading")).toBe("false");
    expect(cell(target, "fraction")).toBe("0");
    expect(cell(target, "error")).toBe("none");

    // a successful upload flows store -> DOM via auto-subscription: progress
    // settles at 1 and the in-flight flag returns to false.
    await files?.upload(new File(["hello"], "h.txt", { type: "text/plain" }));
    flushSync();
    expect(cell(target, "uploading")).toBe("false");
    expect(cell(target, "fraction")).toBe("1");
    expect(cell(target, "error")).toBe("none");

    // a failing verb surfaces through the error store into the DOM...
    await expect(files?.head("missing")).rejects.toMatchObject({
      code: "NotFound",
    });
    flushSync();
    expect(cell(target, "error")).toBe("NotFound");

    // ...and reset() clears it back out.
    files?.reset();
    flushSync();
    expect(cell(target, "error")).toBe("none");

    unmount(component);
  });
});
