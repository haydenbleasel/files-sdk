// oxlint-disable unicorn/no-await-expression-member -- asserting `.status`/JSON fields off awaited Responses is the natural shape here.
import { beforeEach, describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import type { Authorize, CreateFilesRouterOptions } from "../src/api/index.js";
import type { Adapter } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { signToken } from "../src/internal/router-core/sign-token.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const ENDPOINT = "https://app.test/api/files";
const SECRET = "test-secret";
const NOW = 1_000_000_000;

const signing = (): Adapter =>
  ({
    ...fakeAdapter({ supportsDelimiter: true, supportsRange: true }),
    signedUrl: { supported: true },
  }) as unknown as Adapter;

const router = (
  opts: Partial<CreateFilesRouterOptions> & { adapter?: Adapter } = {}
) => {
  const files = createFiles({ adapter: opts.adapter ?? memory() });
  const { adapter: _a, ...rest } = opts;
  return createFilesRouter({ files, now: () => NOW, secret: SECRET, ...rest });
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(ENDPOINT, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

const get = (query: string, headers: Record<string, string> = {}) =>
  new Request(`${ENDPOINT}?${query}`, { headers, method: "GET" });

const put = (
  query: string,
  body: string,
  headers: Record<string, string> = {}
) => new Request(`${ENDPOINT}?${query}`, { body, headers, method: "PUT" });

const allowAll: Authorize = () => {};

const readJson = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const first = <T>(items: readonly T[]): T => items[0] as T;

const seed = async (adapter: Adapter, key: string, body: string) => {
  await createFiles({ adapter }).upload(key, body);
};

describe("createFilesRouter — deny by default", () => {
  test("with no authorize/operations only capabilities answers", async () => {
    const r = router();
    const head = await r.handle(post({ key: "a", op: "head" }));
    expect(head.status).toBe(403);
    const body = (await head.json()) as {
      error: { code: string; reason?: string };
    };
    expect(body.error.code).toBe("Forbidden");
    expect(body.error.reason).toBe("forbidden");

    const caps = await r.handle(post({ op: "capabilities" }));
    expect(caps.status).toBe(200);
    expect(
      (await readJson<{ capabilities: { delimiter: boolean } }>(caps))
        .capabilities.delimiter
    ).toBe(true);
  });

  test("operations allow-list gates ops", async () => {
    const r = router({ operations: ["head", "list"] });
    const adapter = memory();
    await seed(adapter, "x", "hi");
    const r2 = router({ adapter, operations: ["head"] });
    expect((await r2.handle(post({ key: "x", op: "head" }))).status).toBe(200);
    expect((await r.handle(post({ key: "x", op: "delete" }))).status).toBe(403);
  });
});

describe("createFilesRouter — authorize", () => {
  test("throwing maps to its code", async () => {
    const r = router({
      authorize: () => {
        throw new FilesError("Unauthorized", "sign in");
      },
    });
    expect((await r.handle(post({ key: "a", op: "head" }))).status).toBe(401);

    const ro = router({
      authorize: ({ operation }) => {
        if (operation === "delete") {
          throw new FilesError("ReadOnly", "read only");
        }
      },
    });
    expect((await ro.handle(post({ key: "a", op: "delete" }))).status).toBe(
      403
    );
  });

  test("keyPrefix scopes keys and rejects escapes", async () => {
    const adapter = memory();
    const r = router({
      adapter,
      authorize: () => ({ keyPrefix: "users/1/" }),
    });
    await r.handle(put("op=upload&key=a.txt", "hello"));
    // stored under users/1/a.txt
    expect(await createFiles({ adapter }).exists("users/1/a.txt")).toBe(true);

    const head = await r.handle(post({ key: "a.txt", op: "head" }));
    expect(head.status).toBe(200);
    // unscoped on the wire
    expect((await readJson<{ file: { key: string } }>(head)).file.key).toBe(
      "a.txt"
    );

    const escape = await r.handle(post({ key: "../../etc", op: "head" }));
    expect(escape.status).toBe(422);
    expect(
      (await readJson<{ error: { reason: string } }>(escape)).error.reason
    ).toBe("key");
  });
});

describe("createFilesRouter — read verbs", () => {
  let adapter: Adapter;
  beforeEach(async () => {
    adapter = memory();
    await seed(adapter, "docs/a.txt", "alpha");
    await seed(adapter, "docs/b.txt", "bravo");
    await seed(adapter, "img/c.png", "img");
  });

  test("head / exists / url", async () => {
    const r = router({ adapter, operations: ["head", "exists", "url"] });
    const head = await r.handle(post({ key: "docs/a.txt", op: "head" }));
    expect((await readJson<{ file: { size: number } }>(head)).file.size).toBe(
      5
    );

    expect(
      (
        await readJson<{ exists: boolean }>(
          await r.handle(post({ key: "docs/a.txt", op: "exists" }))
        )
      ).exists
    ).toBe(true);
    expect(
      (
        await readJson<{ exists: boolean }>(
          await r.handle(post({ key: "nope", op: "exists" }))
        )
      ).exists
    ).toBe(false);

    const url = await r.handle(post({ key: "docs/a.txt", op: "url" }));
    expect((await readJson<{ url: string }>(url)).url).toContain("memory://");
  });

  test("list with prefix + delimiter, and search", async () => {
    const r = router({ adapter, operations: ["list", "search"] });
    const list = await r.handle(post({ delimiter: "/", op: "list" }));
    const listBody = (await list.json()) as {
      items: unknown[];
      prefixes?: string[];
    };
    expect(listBody.prefixes).toEqual(["docs/", "img/"]);

    const search = await r.handle(
      post({ op: "search", pattern: "docs/*.txt" })
    );
    const searchBody = (await search.json()) as {
      matches: { key: string }[];
      truncated: boolean;
    };
    expect(searchBody.matches.map((m) => m.key).toSorted()).toEqual([
      "docs/a.txt",
      "docs/b.txt",
    ]);
    expect(searchBody.truncated).toBe(false);
  });

  test("search truncates at maxSearchResults", async () => {
    const r = router({ adapter, maxSearchResults: 1, operations: ["search"] });
    const res = await r.handle(post({ op: "search", pattern: "docs/*" }));
    const body = (await res.json()) as {
      matches: unknown[];
      truncated: boolean;
    };
    expect(body.matches).toHaveLength(1);
    expect(body.truncated).toBe(true);
  });

  test("regex search", async () => {
    const r = router({ adapter, operations: ["search"] });
    const res = await r.handle(
      post({ flags: "u", isRegex: true, op: "search", pattern: "\\.png$" })
    );
    expect((await readJson<{ matches: unknown[] }>(res)).matches).toHaveLength(
      1
    );
  });

  test("list limit is clamped", async () => {
    const r = router({ adapter, maxListLimit: 1, operations: ["list"] });
    const res = await r.handle(post({ limit: 999, op: "list" }));
    expect((await readJson<{ items: unknown[] }>(res)).items).toHaveLength(1);
  });
});

describe("createFilesRouter — bulk verbs", () => {
  let adapter: Adapter;
  beforeEach(async () => {
    adapter = memory();
    await seed(adapter, "a", "1");
    await seed(adapter, "b", "2");
  });

  test("head-many / exists-many / delete-many", async () => {
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["head", "exists", "delete"],
    });
    const head = await r.handle(post({ keys: ["a", "b"], op: "head-many" }));
    expect((await readJson<{ files: unknown[] }>(head)).files).toHaveLength(2);

    const ex = await r.handle(post({ keys: ["a", "z"], op: "exists-many" }));
    const exBody = (await ex.json()) as {
      existing: string[];
      missing: string[];
    };
    expect(exBody.existing).toEqual(["a"]);
    expect(exBody.missing).toEqual(["z"]);

    const del = await r.handle(post({ keys: ["a"], op: "delete-many" }));
    expect((await readJson<{ deleted: string[] }>(del)).deleted).toEqual(["a"]);
  });

  test("copy and move", async () => {
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["copy", "move"],
    });
    expect(
      (await r.handle(post({ from: "a", op: "copy", to: "a-copy" }))).status
    ).toBe(200);
    expect(await createFiles({ adapter }).exists("a-copy")).toBe(true);
    await r.handle(post({ from: "b", op: "move", to: "b-moved" }));
    expect(await createFiles({ adapter }).exists("b")).toBe(false);
  });
});

describe("createFilesRouter — download", () => {
  test("redirect path on a signing adapter", async () => {
    const adapter = signing();
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, authorize: () => ({ maxExpiresIn: 60 }) });
    const res = await r.handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("fake.local");
  });

  test("proxy path streams bytes with metadata header", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello world");
    const r = router({ adapter, operations: ["download"] });
    const res = await r.handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("11");
    expect(res.headers.get("x-files-meta")).toBeTruthy();
    expect(await res.text()).toBe("hello world");
  });

  test("range request returns 206 with content-range", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello world");
    const r = router({ adapter, operations: ["download"] });
    const res = await r.handle(
      get("op=download&key=a.txt", { range: "bytes=0-4" })
    );
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-4/11");
    expect(await res.text()).toBe("hello");
  });

  test("suffix range", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello world");
    const r = router({ adapter, operations: ["download"] });
    const res = await r.handle(
      get("op=download&key=a.txt", { range: "bytes=-5" })
    );
    expect(res.status).toBe(206);
    expect(await res.text()).toBe("world");
  });

  test("unsatisfiable range → 416", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, operations: ["download"] });
    const res = await r.handle(
      get("op=download&key=a.txt", { range: "bytes=99-200" })
    );
    expect(res.status).toBe(416);
  });

  test("range on a non-range adapter → 416 (reject), or ignored", async () => {
    const adapter = fakeAdapter() as unknown as Adapter;
    await seed(adapter, "a.txt", "hello");
    const reject = router({ adapter, operations: ["download"] });
    expect(
      (
        await reject.handle(
          get("op=download&key=a.txt", { range: "bytes=0-2" })
        )
      ).status
    ).toBe(416);

    const ignore = router({
      adapter,
      onUnsupportedRange: "ignore",
      operations: ["download"],
    });
    const res = await ignore.handle(
      get("op=download&key=a.txt", { range: "bytes=0-2" })
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("forced proxy mode + missing key", async () => {
    const adapter = signing();
    await seed(adapter, "a.txt", "hello");
    const r = router({
      adapter,
      downloadMode: "proxy",
      operations: ["download"],
    });
    expect((await r.handle(get("op=download&key=a.txt"))).status).toBe(200);
    expect((await r.handle(get("op=download"))).status).toBe(422);
  });
});

describe("createFilesRouter — upload", () => {
  test("presign + proxy + complete (non-signing adapter)", async () => {
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const presign = await r.handle(
      post({
        files: [{ name: "x.txt", size: 5, type: "text/plain" }],
        op: "presign",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: {
        id: string;
        key: string;
        target: { method: string; url: string };
      }[];
    };
    expect(first(uploads).target.url).toContain("op=proxy");

    // drive the proxy target
    const proxyUrl = new URL(first(uploads).target.url);
    const token = proxyUrl.searchParams.get("token") as string;
    const up = await r.handle(
      put(`op=proxy&token=${encodeURIComponent(token)}`, "hello")
    );
    expect(up.status).toBe(200);

    const complete = await r.handle(
      post({
        completions: [{ id: first(uploads).id, key: first(uploads).key }],
        op: "complete",
      })
    );
    const done = (await complete.json()) as { files: { size: number }[] };
    expect(first(done.files).size).toBe(5);
  });

  test("presign returns a real signed target on a signing adapter", async () => {
    const adapter = signing();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const presign = await r.handle(
      post({
        files: [{ name: "x.bin", size: 3, type: "application/octet-stream" }],
        op: "presign",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: { target: { url: string } }[];
    };
    expect(first(uploads).target.url).toContain("fake.local");
  });

  test("complete rejects an oversized object against maxUploadSize", async () => {
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 3,
      operations: ["upload"],
    });
    const presign = await r.handle(
      post({
        files: [{ name: "x", size: 10, type: "text/plain" }],
        op: "presign",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: { id: string; key: string; target: { url: string } }[];
    };
    const token = new URL(first(uploads).target.url).searchParams.get(
      "token"
    ) as string;
    await r.handle(
      put(`op=proxy&token=${encodeURIComponent(token)}`, "0123456789")
    );
    const complete = await r.handle(
      post({
        completions: [{ id: first(uploads).id, key: first(uploads).key }],
        op: "complete",
      })
    );
    const body = (await complete.json()) as {
      files: unknown[];
      errors?: { error: { message: string } }[];
    };
    expect(body.files).toHaveLength(0);
    expect(first(body.errors ?? []).error.message).toContain("exceeds maxSize");
  });

  test("explicit-key upload through the endpoint", async () => {
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const res = await r.handle(
      put("op=upload&key=hi.txt", "hello", { "content-type": "text/plain" })
    );
    expect(res.status).toBe(200);
    expect((await readJson<{ file: { key: string } }>(res)).file.key).toBe(
      "hi.txt"
    );
    expect(await createFiles({ adapter }).exists("hi.txt")).toBe(true);
  });

  test("proxy upload with a tampered token → 401", async () => {
    const r = router({ allowedOrigins: () => true, operations: ["upload"] });
    const res = await r.handle(put("op=proxy&token=not.a.token", "x"));
    expect(res.status).toBe(401);
  });

  test("signed-upload-url op", async () => {
    const adapter = signing();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["signedUploadUrl"],
    });
    const res = await r.handle(
      post({ expiresIn: 60, key: "k.bin", op: "signed-upload-url" })
    );
    expect(
      (await readJson<{ signed: { method: string } }>(res)).signed.method
    ).toBe("PUT");
  });
});

describe("createFilesRouter — protocol errors", () => {
  test("origin rejection on a state-changing op", async () => {
    const r = router({
      allowedOrigins: ["https://trusted.test"],
      authorize: allowAll,
    });
    const res = await r.handle(
      post({ key: "a", op: "delete" }, { origin: "https://evil.test" })
    );
    expect(res.status).toBe(403);
    expect(
      (await readJson<{ error: { reason: string } }>(res)).error.reason
    ).toBe("origin");
  });

  test("invalid JSON, unknown op, unsupported method", async () => {
    const r = router({ authorize: allowAll });
    const bad = new Request(ENDPOINT, {
      body: "{not json",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect((await r.handle(bad)).status).toBe(422);
    expect((await r.handle(post({ op: "frobnicate" }))).status).toBe(422);
    expect(
      (await r.handle(new Request(ENDPOINT, { method: "DELETE" }))).status
    ).toBe(422);
  });

  test("a verified token can be hand-minted and completed", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("manual", "data");
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const id = await signToken({ exp: NOW + 60_000, key: "manual" }, SECRET);
    const res = await r.handle(
      post({ completions: [{ id, key: "manual" }], op: "complete" })
    );
    expect(
      first((await readJson<{ files: { key: string }[] }>(res)).files).key
    ).toBe("manual");
  });

  test("per-request files factory", async () => {
    const adapter = memory();
    await seed(adapter, "a", "1");
    const r = createFilesRouter({
      files: () => createFiles({ adapter }),
      operations: ["head"],
      secret: SECRET,
    });
    expect((await r.handle(post({ key: "a", op: "head" }))).status).toBe(200);
  });
});
