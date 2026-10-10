// oxlint-disable unicorn/no-await-expression-member -- asserting `.status`/JSON fields off awaited Responses is the natural shape here.
import { beforeEach, describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import type { Authorize, CreateFilesRouterOptions } from "../src/api/index.js";
import type { Adapter, SignUploadOptions } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { FilesError, dispositionUnsupported } from "../src/internal/errors.js";
import { signToken } from "../src/internal/router-core/sign-token.js";
import { memory } from "../src/memory/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import { versioning } from "../src/versioning/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";

const ENDPOINT = "https://app.test/api/files";
const SECRET = "test-secret";
const NOW = 1_000_000_000;

// The fake signs both ways and binds size and type, so the gateway takes the
// direct (redirect / presign) paths.
const signing = (): Adapter =>
  withCapabilities(
    fakeAdapter({ supportsDelimiter: true, supportsRange: true }),
    {
      signedUpload: { contentType: true, maxSize: true, supported: true },
      signedUrl: { disposition: true, supported: true },
    }
  );

// The shared fake signs; this turns that off, for the proxy paths.
const NO_SIGNING = { signedUrl: { supported: false } };

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

const REFUSAL = "fake: `responseContentDisposition` is not supported.";

// A signing adapter that, like Vercel Blob or Dropbox, can't bind any
// Content-Disposition into its URLs and refuses the option outright.
const refusing = (): Adapter => {
  const base = signing();
  return {
    ...base,
    url: (key, opts) =>
      opts?.responseContentDisposition
        ? Promise.reject(dispositionUnsupported(REFUSAL))
        : base.url(key, opts),
  };
};

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
      (await readJson<{ capabilities: { delimiter: string } }>(caps))
        .capabilities.delimiter
    ).toBe("any");
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
    const { file } = await readJson<{ file: Record<string, unknown> }>(head);
    expect(file.size).toBe(5);
    // The wire carries `FileInfo`: `contentType`, never `type` / `name`.
    expect(file.key).toBe("docs/a.txt");
    expect(file.contentType).toStartWith("text/plain");
    expect(file).not.toHaveProperty("type");
    expect(file).not.toHaveProperty("name");

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

  test("url forces safe content disposition unless authorize overrides", async () => {
    const r = router({ adapter, operations: ["url"] });

    const unsafe = await readJson<{ url: string }>(
      await r.handle(
        post({
          key: "docs/a.txt",
          op: "url",
          responseContentDisposition: "inline",
        })
      )
    );
    expect(
      new URL(unsafe.url).searchParams.get("response-content-disposition")
    ).toBe("attachment");

    const attachment = await readJson<{ url: string }>(
      await r.handle(
        post({
          key: "docs/a.txt",
          op: "url",
          responseContentDisposition: 'attachment; filename="a.txt"',
        })
      )
    );
    expect(
      new URL(attachment.url).searchParams.get("response-content-disposition")
    ).toBe('attachment; filename="a.txt"');

    const injected = await readJson<{ url: string }>(
      await r.handle(
        post({
          key: "docs/a.txt",
          op: "url",
          responseContentDisposition: "attachment\r\nx-injected: 1",
        })
      )
    );
    expect(
      new URL(injected.url).searchParams.get("response-content-disposition")
    ).toBe("attachment");

    // Browsers render these inline: the type isn't exactly `attachment`.
    for (const disguised of [
      "attachment, inline",
      "attachment inline",
      "attachment/x",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one value per case
      const res = await readJson<{ url: string }>(
        // oxlint-disable-next-line no-await-in-loop -- one value per case
        await r.handle(
          post({
            key: "docs/a.txt",
            op: "url",
            responseContentDisposition: disguised,
          })
        )
      );
      expect(
        new URL(res.url).searchParams.get("response-content-disposition")
      ).toBe("attachment");
    }

    const inline = router({
      adapter,
      authorize: () => ({ disposition: "inline" }),
      operations: ["url"],
    });
    const serverAllowed = await readJson<{ url: string }>(
      await inline.handle(post({ key: "docs/a.txt", op: "url" }))
    );
    expect(
      new URL(serverAllowed.url).searchParams.get(
        "response-content-disposition"
      )
    ).toBe("inline");
  });

  test("url on an adapter that refuses dispositions fails loud by default, and goes bare under inline policy", async () => {
    const refuser = refusing();
    await seed(refuser, "a.txt", "hello");

    // The gateway's own `attachment` default can't be guaranteed: fail with
    // guidance, whether attachment came from the default or from authorize.
    for (const authorize of [
      allowAll,
      () => ({ disposition: "attachment" }),
    ] satisfies Authorize[]) {
      // oxlint-disable-next-line no-await-in-loop -- one router per policy
      const res = await router({ adapter: refuser, authorize }).handle(
        post({ key: "a.txt", op: "url" })
      );
      expect(res.status).toBe(422);
      // oxlint-disable-next-line no-await-in-loop -- read each response in turn
      const { error } = await readJson<{
        error: { code: string; message: string };
      }>(res);
      expect(error.code).toBe("Unsupported");
      expect(error.message).toContain('"attachment"');
      expect(error.message).toContain(
        'Return { disposition: "inline" } from authorize'
      );
      expect(error.message).toContain("use download");
    }

    // Deliberate inline policy: the URL goes out without a disposition.
    const inline = await router({
      adapter: refuser,
      authorize: () => ({ disposition: "inline" }),
    }).handle(post({ key: "a.txt", op: "url" }));
    expect(inline.status).toBe(200);
    expect((await readJson<{ url: string }>(inline)).url).toBe(
      "https://fake.local/a.txt?expires=300"
    );

    // Errors that aren't a disposition refusal pass through unchanged.
    const missing = await router({
      adapter: signing(),
      operations: ["url"],
    }).handle(post({ key: "missing.txt", op: "url" }));
    expect(missing.status).toBe(404);
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

  test("regex search rejects unsafe patterns", async () => {
    const r = router({ adapter, operations: ["search"] });
    // The classic catastrophic-backtracking pattern, "(a+)+$". Assembled at
    // runtime so static scanners don't flag a regex the SDK exists to reject.
    const unsafePattern = ["(a+)", "+$"].join("");
    const res = await r.handle(
      post({ flags: "u", isRegex: true, op: "search", pattern: unsafePattern })
    );
    expect(res.status).toBe(422);
    expect(
      (await readJson<{ error: { message: string } }>(res)).error.message
    ).toContain("too complex");
  });

  test("an invalid regex under match: regex is a 422, like isRegex", async () => {
    const r = router({ adapter, operations: ["search"] });
    const responses = await Promise.all(
      [{ match: "regex" }, { isRegex: true }].map((extra) =>
        r.handle(post({ op: "search", pattern: "(", ...extra }))
      )
    );
    for (const res of responses) {
      expect(res.status).toBe(422);
    }
    expect(
      await Promise.all(responses.map((res) => readJson<unknown>(res)))
    ).toEqual(
      Array.from({ length: 2 }, () => ({
        error: { code: "Validation", message: "invalid search regex" },
      }))
    );
    // scoped too: the keyPrefix path compiles its own matcher
    const scoped = router({
      adapter,
      authorize: () => ({ keyPrefix: "docs/" }),
    });
    const res = await scoped.handle(
      post({ match: "regex", op: "search", pattern: "[" })
    );
    expect(res.status).toBe(422);
  });

  test("search refuses glob patterns with too many wildcards, fast", async () => {
    const r = router({ adapter, operations: ["search"] });
    // `*a` ×10 + `*b` backtracks polynomially per key (seconds on one 40-char
    // key); it must be refused before any key is matched.
    const started = performance.now();
    const res = await r.handle(
      post({ op: "search", pattern: `${"*a".repeat(10)}*b` })
    );
    expect(res.status).toBe(422);
    expect(
      (await readJson<{ error: { message: string } }>(res)).error.message
    ).toContain("too complex");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("search refuses flat regex quantifier chains and nested repeats", async () => {
    const r = router({ adapter, operations: ["search"] });
    // Flat `(.*a){10}` passes safe-regex2 (no nested star) but is just as slow.
    const chain = ["^(.*a)", "{10}", ".*b$"].join("");
    for (const pattern of [chain, ".*a.*a.*a.*b"]) {
      // oxlint-disable-next-line no-await-in-loop -- sequential assertions
      const res = await r.handle(
        post({ flags: "u", isRegex: true, op: "search", pattern })
      );
      expect(res.status).toBe(422);
    }
    // A regex string under `match: "regex"` is measured the same way.
    const viaMatch = await r.handle(
      post({ match: "regex", op: "search", pattern: chain })
    );
    expect(viaMatch.status).toBe(422);
    // An ordinary pattern still answers.
    const ok = await r.handle(
      post({
        flags: "u",
        isRegex: true,
        op: "search",
        pattern: "^docs/.*\\.txt$",
      })
    );
    expect(ok.status).toBe(200);
  });

  test("search pattern limits are configurable", async () => {
    const strict = router({
      adapter,
      maxSearchPatternLength: 8,
      maxSearchWildcards: 1,
      operations: ["search"],
    });
    const long = await strict.handle(
      post({ match: "substring", op: "search", pattern: "docs/a.txt" })
    );
    expect(long.status).toBe(422);
    expect(
      (await readJson<{ error: { message: string } }>(long)).error.message
    ).toContain("too long");
    expect(
      (await strict.handle(post({ op: "search", pattern: "*/*.txt" }))).status
    ).toBe(422);
    const loose = router({
      adapter,
      maxSearchWildcards: 12,
      operations: ["search"],
    });
    expect(
      (await loose.handle(post({ op: "search", pattern: "*/*/*/*/*.png" })))
        .status
    ).toBe(200);
  });

  test("search clamps the page limit to maxListLimit", async () => {
    const limits: (number | undefined)[] = [];
    const spy = memory();
    await seed(spy, "docs/a.txt", "alpha");
    const list = spy.list.bind(spy);
    spy.list = (opts) => {
      limits.push(opts?.limit);
      return list(opts);
    };
    const r = router({ adapter: spy, maxListLimit: 5, operations: ["search"] });
    const res = await r.handle(
      post({ limit: 100_000, op: "search", pattern: "docs/*" })
    );
    expect(res.status).toBe(200);
    expect(limits.every((limit) => limit !== undefined && limit <= 5)).toBe(
      true
    );
  });

  test("search under a keyPrefix scope matches the unscoped key", async () => {
    const scoped = memory();
    await seed(scoped, "users/1/a.png", "x");
    await seed(scoped, "users/1/docs/b.png", "x");
    await seed(scoped, "users/1/docs/c.txt", "x");
    await seed(scoped, "users/2/a.png", "x");
    const r = router({
      adapter: scoped,
      authorize: () => ({ keyPrefix: "users/1/" }),
    });
    const keys = async (body: Record<string, unknown>) => {
      const res = await r.handle(post({ op: "search", ...body }));
      expect(res.status).toBe(200);
      return (await readJson<{ matches: { key: string }[] }>(res)).matches
        .map((m) => m.key)
        .toSorted();
    };
    // the same shapes `list` answers with, so a client never sees the prefix
    expect(await keys({ pattern: "*.png" })).toEqual(["a.png"]);
    expect(await keys({ pattern: "**/*.png" })).toEqual([
      "a.png",
      "docs/b.png",
    ]);
    expect(await keys({ match: "exact", pattern: "a.png" })).toEqual(["a.png"]);
    expect(await keys({ isRegex: true, pattern: "^a" })).toEqual(["a.png"]);
    expect(await keys({ match: "substring", pattern: "b.p" })).toEqual([
      "docs/b.png",
    ]);
    // a glob's literal head is pushed down as the walk prefix under the scope
    expect(await keys({ limit: 1, pattern: "docs/*.png" })).toEqual([
      "docs/b.png",
    ]);
    // a client prefix bounds the walk (the pattern still matches the whole
    // unscoped key); case-insensitive globs skip the push-down
    expect(await keys({ pattern: "docs/*.PNG", prefix: "docs/" })).toEqual([]);
    expect(
      await keys({
        caseInsensitive: true,
        pattern: "docs/*.PNG",
        prefix: "docs/",
      })
    ).toEqual(["docs/b.png"]);
    expect(
      await keys({ caseInsensitive: true, pattern: "DOCS/*.png" })
    ).toEqual(["docs/b.png"]);
    // the storage prefix is not addressable from the client side
    expect(await keys({ pattern: "users/1/*.png" })).toEqual([]);
  });

  test("search validates match", async () => {
    const r = router({ adapter, operations: ["search"] });
    const ok = await r.handle(
      post({ match: "exact", op: "search", pattern: "docs/a.txt" })
    );
    expect(
      (await readJson<{ matches: { key: string }[] }>(ok)).matches.map(
        (m) => m.key
      )
    ).toEqual(["docs/a.txt"]);
    const bad = await r.handle(
      post({ match: "fuzzy", op: "search", pattern: "docs/a.txt" })
    );
    expect(bad.status).toBe(422);
    expect(
      (await readJson<{ error: { message: string } }>(bad)).error.message
    ).toContain("match");
  });

  test("list limit is clamped", async () => {
    const r = router({ adapter, maxListLimit: 1, operations: ["list"] });
    const res = await r.handle(post({ limit: 999, op: "list" }));
    expect((await readJson<{ items: unknown[] }>(res)).items).toHaveLength(1);
  });

  test("list honors authorize maxResults", async () => {
    const r = router({
      adapter,
      authorize: () => ({ maxResults: 1 }),
      maxListLimit: 10,
      operations: ["list"],
    });
    const capped = await r.handle(post({ limit: 999, op: "list" }));
    expect((await readJson<{ items: unknown[] }>(capped)).items).toHaveLength(
      1
    );

    const clientCapped = router({
      adapter,
      authorize: () => ({ maxResults: 10 }),
      maxListLimit: 10,
      operations: ["list"],
    });
    const res = await clientCapped.handle(post({ limit: 2, op: "list" }));
    expect((await readJson<{ items: unknown[] }>(res)).items).toHaveLength(2);
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
    expect((await readJson<{ results: unknown[] }>(head)).results).toHaveLength(
      2
    );

    const ex = await r.handle(post({ keys: ["a", "z"], op: "exists-many" }));
    const exBody = (await ex.json()) as {
      existing: string[];
      missing: string[];
    };
    expect(exBody.existing).toEqual(["a"]);
    expect(exBody.missing).toEqual(["z"]);

    const del = await r.handle(post({ keys: ["a"], op: "delete-many" }));
    expect((await readJson<{ results: string[] }>(del)).results).toEqual(["a"]);
  });

  test("bulk arrays are capped by maxBatchSize (413, reason count)", async () => {
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxBatchSize: 2,
      operations: ["head", "exists", "delete", "upload"],
    });
    const keys = ["a", "b", "c"];
    const responses = await Promise.all(
      ["head-many", "exists-many", "delete-many"].map((op) =>
        r.handle(post({ keys, op }))
      )
    );
    expect(responses.map((res) => res.status)).toEqual([413, 413, 413]);
    const bodies = await Promise.all(
      responses.map((res) => readJson<{ error: { reason: string } }>(res))
    );
    expect(bodies.map((body) => body.error.reason)).toEqual([
      "count",
      "count",
      "count",
    ]);
    const file = { name: "x.txt", size: 1, type: "text/plain" };
    const presign = await r.handle(
      post({ files: [file, file, file], op: "presign" })
    );
    expect(presign.status).toBe(413);
    const complete = await r.handle(
      post({
        completions: keys.map((key) => ({ id: "t", key })),
        op: "complete",
      })
    );
    expect(complete.status).toBe(413);
    // At the cap still answers.
    expect(
      (await r.handle(post({ keys: ["a", "b"], op: "head-many" }))).status
    ).toBe(200);
  });

  test("client concurrency is clamped to maxConcurrency", async () => {
    let active = 0;
    let peak = 0;
    const slow = memory();
    for (const key of ["k1", "k2", "k3", "k4", "k5", "k6"]) {
      // oxlint-disable-next-line no-await-in-loop -- seeding
      await seed(slow, key, "x");
    }
    const head = slow.head.bind(slow);
    slow.head = async (key, opts) => {
      active += 1;
      peak = Math.max(peak, active);
      await Bun.sleep(5);
      active -= 1;
      return head(key, opts);
    };
    const r = router({
      adapter: slow,
      maxConcurrency: 2,
      operations: ["head"],
    });
    const res = await r.handle(
      post({
        concurrency: 1000,
        keys: ["k1", "k2", "k3", "k4", "k5", "k6"],
        op: "head-many",
      })
    );
    expect(res.status).toBe(200);
    expect(peak).toBeLessThanOrEqual(2);
    // A zero/fractional request still runs (floored to at least 1).
    const one = await r.handle(
      post({ concurrency: 0.5, keys: ["k1"], op: "head-many" })
    );
    expect(one.status).toBe(200);
  });

  test("head-many is a read: no Origin check, like head/exists", async () => {
    const r = router({ adapter, operations: ["head"] });
    const res = await r.handle(
      post({ keys: ["a"], op: "head-many" }, { origin: "https://other.test" })
    );
    expect(res.status).toBe(200);
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

  test("a signer that can't bind the forced disposition proxies instead of failing", async () => {
    // Vercel Blob private, UploadThing private: they sign, but throw on a
    // `responseContentDisposition`, so redirecting would fail the download.
    const adapter = withCapabilities(fakeAdapter(), {
      signedUrl: { disposition: false, supported: true },
    });
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, operations: ["download"] });
    const res = await r.handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  test("a permanent public link is redirected to only when nothing must be bound", async () => {
    let seen: unknown;
    const base = withCapabilities(fakeAdapter(), {
      ...NO_SIGNING,
      publicUrl: true,
    });
    const adapter: Adapter = {
      ...base,
      url: (key, opts) => {
        seen = opts;
        return Promise.resolve(`https://cdn.test/${key}`);
      },
    };
    await seed(adapter, "a.txt", "hello");
    // No forced disposition, no lifetime cap: the CDN link, asked for plainly.
    const open = router({
      adapter,
      forceDownloadDisposition: false,
      operations: ["download"],
    });
    const res = await open.handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://cdn.test/a.txt");
    expect(seen).not.toHaveProperty("expiresIn");
    // A forced disposition, or an `authorize` lifetime cap, can't ride on a
    // permanent link, and this adapter can't sign: stream it instead.
    const forced = router({ adapter, operations: ["download"] });
    expect((await forced.handle(get("op=download&key=a.txt"))).status).toBe(
      200
    );
    const capped = router({
      adapter,
      authorize: () => ({ maxExpiresIn: 60 }),
      forceDownloadDisposition: false,
    });
    expect((await capped.handle(get("op=download&key=a.txt"))).status).toBe(
      200
    );
  });

  test("url op: a signer always signs; a permanent-link adapter only when it must", async () => {
    const calls: unknown[] = [];
    const base = withCapabilities(fakeAdapter(), {
      publicUrl: true,
      signedUrl: { disposition: true, supported: true },
    });
    const adapter: Adapter = {
      ...base,
      url: (key, opts) => {
        calls.push(opts?.expiresIn);
        return base.url(key, opts);
      },
    };
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, operations: ["url"] });
    await r.handle(post({ key: "a.txt", op: "url" }));
    await r.handle(post({ expiresIn: 30, key: "a.txt", op: "url" }));
    // Signed with the default expiry, then with the asked-for 30s.
    expect(calls).toEqual([300, 30]);
    // An adapter that can't sign hands out its permanent link — but an
    // asked-for expiry, or an `authorize` lifetime cap, is a 422, not a
    // permanent link in disguise.
    const permanent = withCapabilities(fakeAdapter(), {
      ...NO_SIGNING,
      publicUrl: true,
    });
    await seed(permanent, "a.txt", "hello");
    const plain = router({ adapter: permanent, operations: ["url"] });
    expect((await plain.handle(post({ key: "a.txt", op: "url" }))).status).toBe(
      200
    );
    expect(
      (await plain.handle(post({ expiresIn: 30, key: "a.txt", op: "url" })))
        .status
    ).toBe(422);
    const capped = router({
      adapter: permanent,
      authorize: () => ({ maxExpiresIn: 60 }),
    });
    expect(
      (await capped.handle(post({ key: "a.txt", op: "url" }))).status
    ).toBe(422);
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

  test("unsatisfiable range → 416, with an error envelope", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, operations: ["download"] });
    const res = await r.handle(
      get("op=download&key=a.txt", { range: "bytes=99-200" })
    );
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */5");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(
      (await readJson<{ error: { code: string; reason: string } }>(res)).error
    ).toMatchObject({ code: "Validation", reason: "range" });
  });

  test("range on a non-range adapter → 416 (reject), or ignored", async () => {
    const adapter = withCapabilities(fakeAdapter(), NO_SIGNING);
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

  test("proxied downloads are nosniff and advertise range support honestly", async () => {
    const ranged = memory();
    await seed(ranged, "a.txt", "hello");
    const res = await router({
      adapter: ranged,
      operations: ["download"],
    }).handle(get("op=download&key=a.txt"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("accept-ranges")).toBe("bytes");

    const plain = withCapabilities(fakeAdapter(), NO_SIGNING);
    await seed(plain, "a.txt", "hello");
    const noRange = await router({
      adapter: plain,
      operations: ["download"],
    }).handle(get("op=download&key=a.txt"));
    expect(noRange.headers.get("accept-ranges")).toBe("none");
  });

  test("If-Range: a stale validator gets the full object (200), a fresh one the slice", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello world");
    const r = router({ adapter, operations: ["download"] });
    const initial = await r.handle(get("op=download&key=a.txt"));
    const etag = initial.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    await initial.text();

    const fresh = await r.handle(
      get("op=download&key=a.txt", { "if-range": etag, range: "bytes=6-" })
    );
    expect(fresh.status).toBe(206);
    expect(await fresh.text()).toBe("world");

    // The object changes between the first slice and the resume.
    await seed(adapter, "a.txt", "HELLO WORLD!");
    const stale = await r.handle(
      get("op=download&key=a.txt", { "if-range": etag, range: "bytes=6-" })
    );
    expect(stale.status).toBe(200);
    expect(stale.headers.get("content-range")).toBeNull();
    expect(await stale.text()).toBe("HELLO WORLD!");

    // A weak validator never satisfies If-Range.
    const weak = await r.handle(
      get("op=download&key=a.txt", {
        "if-range": `W/${stale.headers.get("etag") ?? ""}`,
        range: "bytes=0-4",
      })
    );
    expect(weak.status).toBe(200);
  });

  test("If-Range with an HTTP-date compares against lastModified", async () => {
    const adapter = memory();
    await seed(adapter, "a.txt", "hello world");
    const r = router({ adapter, operations: ["download"] });
    const meta = await createFiles({ adapter }).head("a.txt");
    const when = new Date(meta.lastModified ?? 0).toUTCString();
    const same = await r.handle(
      get("op=download&key=a.txt", { "if-range": when, range: "bytes=0-4" })
    );
    expect(same.status).toBe(206);
    const older = await r.handle(
      get("op=download&key=a.txt", {
        "if-range": new Date(0).toUTCString(),
        range: "bytes=0-4",
      })
    );
    expect(older.status).toBe(200);
    // A stale validator also bypasses a non-range adapter's 416.
    const plain = withCapabilities(fakeAdapter(), NO_SIGNING);
    await seed(plain, "b.txt", "hello");
    const bypass = await router({
      adapter: plain,
      operations: ["download"],
    }).handle(
      get("op=download&key=b.txt", { "if-range": '"nope"', range: "bytes=0-2" })
    );
    expect(bypass.status).toBe(200);
  });

  test("bytes=0- on a non-range adapter is the whole object (200), other ranges stay 416", async () => {
    const adapter = withCapabilities(fakeAdapter(), NO_SIGNING);
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, operations: ["download"] });
    // Every <video>/<audio> opens with `bytes=0-`.
    const media = await r.handle(
      get("op=download&key=a.txt", { range: "bytes=0-" })
    );
    expect(media.status).toBe(200);
    expect(media.headers.get("content-range")).toBeNull();
    expect(media.headers.get("content-length")).toBe("5");
    expect(await media.text()).toBe("hello");

    for (const range of ["bytes=1-", "bytes=0-2", "bytes=-2", "bytes=-"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request per range
      const res = await r.handle(get("op=download&key=a.txt", { range }));
      expect(res.status).toBe(416);
    }
  });

  test("proxied downloads send a quoted ETag and Last-Modified, and If-Range accepts either form", async () => {
    const base = memory();
    await seed(base, "a.txt", "hello world");
    // The S3 family reports etags unquoted; the header must still be an
    // RFC 9110 entity-tag.
    let storedEtag = "abc123";
    const adapter: Adapter = {
      ...base,
      head: async (key, opts) => ({
        ...(await base.head(key, opts)),
        etag: storedEtag,
      }),
    };
    const r = router({ adapter, operations: ["download"] });
    const meta = await createFiles({ adapter: base }).head("a.txt");

    const res = await r.handle(get("op=download&key=a.txt"));
    expect(res.headers.get("etag")).toBe('"abc123"');
    expect(res.headers.get("last-modified")).toBe(
      new Date(meta.lastModified ?? 0).toUTCString()
    );
    await res.text();

    for (const validator of ['"abc123"', "abc123"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request per validator form
      const fresh = await r.handle(
        get("op=download&key=a.txt", {
          "if-range": validator,
          range: "bytes=6-",
        })
      );
      expect(fresh.status).toBe(206);
      // oxlint-disable-next-line no-await-in-loop -- drain before the next request
      expect(await fresh.text()).toBe("world");
    }
    const stale = await r.handle(
      get("op=download&key=a.txt", { "if-range": '"other"', range: "bytes=6-" })
    );
    expect(stale.status).toBe(200);
    await stale.text();

    // Already-quoted and weak etags pass through untouched.
    storedEtag = '"quoted"';
    const quoted = await r.handle(get("op=download&key=a.txt"));
    expect(quoted.headers.get("etag")).toBe('"quoted"');
    await quoted.text();
    storedEtag = 'W/"weak"';
    const weak = await r.handle(get("op=download&key=a.txt"));
    expect(weak.headers.get("etag")).toBe('W/"weak"');
    await weak.text();
  });

  test("download on an adapter that refuses dispositions proxies in auto mode", async () => {
    const adapter = refusing();
    await seed(adapter, "a.txt", "hello");
    const res = await router({ adapter, operations: ["download"] }).handle(
      get("op=download&key=a.txt")
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="a.txt"'
    );
    expect(await res.text()).toBe("hello");
  });

  test("download in redirect mode rethrows the adapter's disposition refusal", async () => {
    const adapter = refusing();
    await seed(adapter, "a.txt", "hello");
    const res = await router({
      adapter,
      authorize: () => ({ disposition: "attachment" }),
      downloadMode: "redirect",
    }).handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(422);
    expect(
      await readJson<{ error: { code: string; message: string } }>(res)
    ).toEqual({ error: { code: "Unsupported", message: REFUSAL } });
  });

  test("an inline authorize policy redirects to a URL without a disposition", async () => {
    const adapter = refusing();
    await seed(adapter, "a.txt", "hello");
    for (const downloadMode of ["auto", "redirect"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- one router per mode
      const res = await router({
        adapter,
        authorize: () => ({ disposition: 'inline; filename="a.txt"' }),
        downloadMode,
      }).handle(get("op=download&key=a.txt"));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://fake.local/a.txt?expires=300"
      );
    }
  });

  test("download redirects without a disposition when forceDownloadDisposition is off", async () => {
    const adapter = refusing();
    await seed(adapter, "a.txt", "hello");
    const res = await router({
      adapter,
      forceDownloadDisposition: false,
      operations: ["download"],
    }).handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(302);
  });

  test("download redirect errors other than a disposition refusal still surface", async () => {
    const res = await router({
      adapter: signing(),
      operations: ["download"],
    }).handle(get("op=download&key=missing.txt"));
    expect(res.status).toBe(404);
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

  test("complete rejects an oversized object against maxUploadSize and removes it", async () => {
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 3,
      operations: ["upload"],
    });
    // A client can understate the size at presign and then put more bytes
    // straight to storage; `complete` holds it to what it declared.
    const presign = await r.handle(
      post({
        files: [{ name: "x", size: 1, type: "text/plain" }],
        op: "presign",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: { id: string; key: string; target: { url: string } }[];
    };
    await createFiles({ adapter }).upload(first(uploads).key, "0123456789");
    const complete = await r.handle(
      post({
        completions: [{ id: first(uploads).id, key: first(uploads).key }],
        op: "complete",
      })
    );
    const body = (await complete.json()) as {
      files: unknown[];
      errors?: {
        key: string;
        error: { code: string; message: string; reason?: string };
      }[];
    };
    expect(body.files).toHaveLength(0);
    expect(first(body.errors ?? []).key).toBe(first(uploads).key);
    expect(first(body.errors ?? []).error).toMatchObject({
      code: "Validation",
      message: "uploaded object is 10 bytes, exceeds maxSize 1",
      reason: "size",
    });
    expect(await createFiles({ adapter }).exists(first(uploads).key)).toBe(
      false
    );
  });

  test("complete reports a failed removal of an oversized object, and ignores one already gone", async () => {
    const base = memory();
    let deleteError: FilesError | undefined;
    const adapter: Adapter = {
      ...base,
      delete: (key, opts) =>
        deleteError ? Promise.reject(deleteError) : base.delete(key, opts),
    };
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 3,
      operations: ["upload"],
    });
    const oversized = async () => {
      const presign = await r.handle(
        post({
          files: [{ name: "x", size: 1, type: "text/plain" }],
          op: "presign",
        })
      );
      const minted = first(
        (await readJson<{ uploads: { id: string; key: string }[] }>(presign))
          .uploads
      );
      await createFiles({ adapter: base }).upload(minted.key, "0123456789");
      const complete = await r.handle(
        post({
          completions: [{ id: minted.id, key: minted.key }],
          op: "complete",
        })
      );
      return first(
        (await readJson<{ errors: { error: { message: string } }[] }>(complete))
          .errors
      ).error.message;
    };

    // The removal's provider message stays on the server.
    deleteError = new FilesError("Provider", "storage unavailable");
    expect(await oversized()).toBe(
      "uploaded object is 10 bytes, exceeds maxSize 1 (removing it failed: storage provider error)"
    );
    deleteError = new FilesError("NotFound", "already gone");
    expect(await oversized()).toBe(
      "uploaded object is 10 bytes, exceeds maxSize 1"
    );
  });

  test("presign refuses a declared size over maxUploadSize before signing", async () => {
    const signed: string[] = [];
    const adapter = {
      ...signing(),
      signedUploadUrl: (key: string) => {
        signed.push(key);
        return Promise.resolve({
          headers: {},
          method: "PUT" as const,
          url: `https://fake.local/${key}`,
        });
      },
    } satisfies Adapter;
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 5,
      operations: ["upload"],
    });
    const res = await r.handle(
      post({
        files: [
          { name: "small.txt", size: 5, type: "text/plain" },
          { name: "big.txt", size: 6, type: "text/plain" },
        ],
        op: "presign",
      })
    );
    expect(res.status).toBe(422);
    const { error } = await readJson<{
      error: { code: string; message: string; reason?: string };
    }>(res);
    expect(error).toEqual({
      code: "Validation",
      message: "upload exceeds maxUploadSize",
      reason: "size",
    });
    expect(signed).toEqual([]);

    // At the limit is fine.
    const ok = await r.handle(
      post({
        files: [{ name: "small.txt", size: 5, type: "text/plain" }],
        op: "presign",
      })
    );
    expect(ok.status).toBe(200);
    expect(signed).toHaveLength(1);
  });

  test("complete refuses a token minted under another caller's keyPrefix", async () => {
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      authorize: ({ req }) => ({
        keyPrefix: `users/${req.headers.get("x-user") ?? "anon"}/`,
      }),
    });
    const as = (user: string, body: unknown) => post(body, { "x-user": user });

    const presign = await r.handle(
      as("alice", {
        files: [{ name: "secret.txt", size: 5, type: "text/plain" }],
        op: "presign",
      })
    );
    const minted = first(
      (
        await readJson<{
          uploads: { id: string; key: string; target: { url: string } }[];
        }>(presign)
      ).uploads
    );
    // The proxy PUT is a bearer-token upload: the token alone authorizes it.
    const up = await r.handle(
      new Request(minted.target.url, { body: "hello", method: "PUT" })
    );
    expect(up.status).toBe(200);
    await createFiles({ adapter }).upload(
      `users/alice/${minted.key}`,
      "hello",
      {
        metadata: { owner: "alice" },
      }
    );

    // Bob replays Alice's token: refused per completion, and the response
    // never carries Alice's storage key or metadata.
    const stolen = await r.handle(
      as("bob", {
        completions: [{ id: minted.id, key: "whatever.txt" }],
        op: "complete",
      })
    );
    expect(stolen.status).toBe(200);
    const text = await stolen.text();
    expect(text).not.toContain("users/alice");
    expect(text).not.toContain(minted.key);
    expect(text).not.toContain("owner");
    expect(JSON.parse(text)).toEqual({
      errors: [
        {
          error: {
            aborted: false,
            code: "Unauthorized",
            message: "upload token was not issued for this caller",
            timedOut: false,
          },
          key: "whatever.txt",
        },
      ],
      files: [],
    });

    // Alice herself still completes it.
    const own = await r.handle(
      as("alice", {
        completions: [{ id: minted.id, key: minted.key }],
        op: "complete",
      })
    );
    const done = await readJson<{
      files: { key: string; metadata?: Record<string, string> }[];
    }>(own);
    expect(first(done.files).key).toBe(minted.key);
    expect(first(done.files).metadata).toEqual({ owner: "alice" });
  });

  test("presign → complete under a per-request files factory stays per tenant", async () => {
    // One shared store; each tenant's `files` instance is scoped by its own
    // `prefix`, and `authorize` adds a per-user `keyPrefix` on top.
    const shared = memory();
    const r = createFilesRouter({
      allowedOrigins: () => true,
      authorize: ({ req }) => ({
        keyPrefix: `users/${req.headers.get("x-user") ?? "anon"}/`,
      }),
      files: (req) =>
        createFiles({
          adapter: shared,
          prefix: `tenants/${req.headers.get("x-tenant") ?? "none"}/`,
        }),
      now: () => NOW,
      secret: SECRET,
    });
    const as = (tenant: string, user: string, body: unknown) =>
      post(body, { "x-tenant": tenant, "x-user": user });

    const presign = await r.handle(
      as("acme", "alice", {
        files: [{ name: "a.txt", size: 5, type: "text/plain" }],
        op: "presign",
      })
    );
    const minted = first(
      (
        await readJson<{
          uploads: { id: string; key: string; target: { url: string } }[];
        }>(presign)
      ).uploads
    );
    const up = await r.handle(
      new Request(minted.target.url, {
        body: "hello",
        headers: { "x-tenant": "acme" },
        method: "PUT",
      })
    );
    expect(up.status).toBe(200);
    expect(
      await createFiles({ adapter: shared }).exists(
        `tenants/acme/users/alice/${minted.key}`
      )
    ).toBe(true);

    const completeAs = async (tenant: string, user: string) =>
      readJson<{
        files: { key: string; size: number }[];
        errors?: { key: string; error: { code: string } }[];
      }>(
        await r.handle(
          as(tenant, user, {
            completions: [{ id: minted.id, key: minted.key }],
            op: "complete",
          })
        )
      );

    // Another user in the same tenant: outside their keyPrefix.
    const sameTenant = await completeAs("acme", "mallory");
    expect(sameTenant.files).toEqual([]);
    expect(first(sameTenant.errors ?? []).error.code).toBe("Unauthorized");

    // The same user id under another tenant resolves another instance, which
    // never sees the object.
    const otherTenant = await completeAs("globex", "alice");
    expect(otherTenant.files).toEqual([]);
    expect(first(otherTenant.errors ?? []).error.code).toBe("NotFound");

    const own = await completeAs("acme", "alice");
    expect(own.errors).toBeUndefined();
    expect(first(own.files)).toMatchObject({ key: minted.key, size: 5 });
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
    const { file } = await readJson<{ file: Record<string, unknown> }>(res);
    expect(file.key).toBe("hi.txt");
    expect(file.contentType).toBe("text/plain");
    expect(file.size).toBe(5);
    expect(file).not.toHaveProperty("type");
    expect(file).not.toHaveProperty("name");
    expect(await createFiles({ adapter }).exists("hi.txt")).toBe(true);
  });

  test("per-request files factory: ?bucket= survives the proxy round-trip", async () => {
    const filesInstance = createFiles({ adapter: memory() });
    const imagesInstance = createFiles({ adapter: memory() });
    const r = createFilesRouter({
      allowedOrigins: () => true,
      files: (req) =>
        new URL(req.url).searchParams.get("bucket") === "images"
          ? imagesInstance
          : filesInstance,
      now: () => NOW,
      operations: ["upload"],
      secret: SECRET,
    });

    const presign = await r.handle(
      new Request(`${ENDPOINT}?bucket=images`, {
        body: JSON.stringify({
          files: [{ name: "a.png", size: 5, type: "image/png" }],
          op: "presign",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: { id: string; key: string; target: { url: string } }[];
    };
    // the minted proxy target keeps the caller's routing query
    const target = new URL(first(uploads).target.url);
    expect(target.searchParams.get("bucket")).toBe("images");
    expect(target.searchParams.get("op")).toBe("proxy");

    const up = await r.handle(
      new Request(target, { body: "hello", method: "PUT" })
    );
    expect(up.status).toBe(200);

    const complete = await r.handle(
      new Request(`${ENDPOINT}?bucket=images`, {
        body: JSON.stringify({
          completions: [{ id: first(uploads).id, key: first(uploads).key }],
          op: "complete",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(complete.status).toBe(200);

    // bytes landed in the images bucket only
    expect(await imagesInstance.exists(first(uploads).key)).toBe(true);
    expect(await filesInstance.exists(first(uploads).key)).toBe(false);
  });

  test("proxy upload token is bound to the query it was minted under", async () => {
    const privateInstance = createFiles({ adapter: memory() });
    const imagesInstance = createFiles({ adapter: memory() });
    const r = createFilesRouter({
      allowedOrigins: () => true,
      // uploads are allowed into images only — never into the private bucket
      authorize: ({ req, operation }) => {
        if (
          operation === "upload" &&
          new URL(req.url).searchParams.get("bucket") !== "images"
        ) {
          throw new FilesError("Unauthorized", "no uploads here");
        }
      },
      files: (req) =>
        new URL(req.url).searchParams.get("bucket") === "images"
          ? imagesInstance
          : privateInstance,
      now: () => NOW,
      secret: SECRET,
    });
    const presignAt = async (query: string) => {
      const presign = await r.handle(
        new Request(`${ENDPOINT}?${query}`, {
          body: JSON.stringify({
            files: [{ name: "a.png", size: 5, type: "image/png" }],
            op: "presign",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
      );
      expect(presign.status).toBe(200);
      const { uploads } = (await presign.json()) as {
        uploads: { id: string; key: string; target: { url: string } }[];
      };
      return first(uploads);
    };

    // replaying the token with the bucket switched is refused, and nothing lands
    const minted = await presignAt("bucket=images");
    const target = new URL(minted.target.url);
    target.searchParams.set("bucket", "private");
    const swapped = await r.handle(
      new Request(target, { body: "hello", method: "PUT" })
    );
    expect(swapped.status).toBe(401);
    expect(
      (await readJson<{ error: { message: string } }>(swapped)).error.message
    ).toContain("different endpoint query");
    expect(await privateInstance.exists(minted.key)).toBe(false);
    expect(await imagesInstance.exists(minted.key)).toBe(false);

    // `complete` refuses the same swap per completion
    const complete = await r.handle(
      new Request(`${ENDPOINT}?bucket=images&tenant=other`, {
        body: JSON.stringify({
          completions: [{ id: minted.id, key: minted.key }],
          op: "complete",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(complete.status).toBe(200);
    const completeBody = (await complete.json()) as {
      files: unknown[];
      errors?: { key: string; error: { code: string; message: string } }[];
    };
    expect(completeBody.files).toEqual([]);
    expect(first(completeBody.errors ?? []).error.code).toBe("Unauthorized");
    expect(first(completeBody.errors ?? []).error.message).toContain(
      "different endpoint query"
    );

    // the binding is canonical: pair order and the routing params don't matter
    const reordered = await presignAt("tenant=t1&bucket=images");
    const up = await r.handle(
      new Request(
        `${ENDPOINT}?bucket=images&tenant=t1&op=proxy&token=${encodeURIComponent(
          new URL(reordered.target.url).searchParams.get("token") as string
        )}`,
        { body: "hello", method: "PUT" }
      )
    );
    expect(up.status).toBe(200);
    expect(await imagesInstance.exists(reordered.key)).toBe(true);
  });

  test("a token only redeems at the endpoint path that minted it", async () => {
    // Two routers sharing one secret (the `FILES_API_SECRET` default), each
    // with its own policy: `/api/files` scopes uploads to `users/1/`,
    // `/api/images` to `public/`. A token `/api/files` minted must not land
    // bytes in the images bucket outside the scope its `authorize` enforces.
    const filesInstance = createFiles({ adapter: memory() });
    const imagesInstance = createFiles({ adapter: memory() });
    const uploads = createFilesRouter({
      authorize: () => ({ keyPrefix: "users/1/" }),
      files: filesInstance,
      now: () => NOW,
      secret: SECRET,
    });
    const images = createFilesRouter({
      authorize: () => ({ keyPrefix: "public/" }),
      files: imagesInstance,
      now: () => NOW,
      secret: SECRET,
    });
    const presign = await uploads.handle(
      post({
        files: [{ name: "x.html", size: 4, type: "text/html" }],
        op: "presign",
      })
    );
    const minted = first(
      (
        await readJson<{
          uploads: { id: string; key: string; target: { url: string } }[];
        }>(presign)
      ).uploads
    );
    const token = new URL(minted.target.url).searchParams.get(
      "token"
    ) as string;
    const imagesEndpoint = "https://app.test/api/images";

    const replayed = await images.handle(
      new Request(
        `${imagesEndpoint}?op=proxy&token=${encodeURIComponent(token)}`,
        { body: "evil", method: "PUT" }
      )
    );
    expect(replayed.status).toBe(401);
    expect(
      (await readJson<{ error: { message: string } }>(replayed)).error.message
    ).toBe("upload token was issued for a different endpoint");
    expect(await imagesInstance.exists(`users/1/${minted.key}`)).toBe(false);

    const complete = await images.handle(
      new Request(imagesEndpoint, {
        body: JSON.stringify({
          completions: [{ id: minted.id, key: minted.key }],
          op: "complete",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(
      first(
        (await readJson<{ errors: { error: { code: string } }[] }>(complete))
          .errors
      ).error.code
    ).toBe("Unauthorized");

    // the minting endpoint still accepts it
    const up = await uploads.handle(
      put(`op=proxy&token=${encodeURIComponent(token)}`, "okay")
    );
    expect(up.status).toBe(200);
    expect(await filesInstance.exists(`users/1/${minted.key}`)).toBe(true);
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

  test("signed-upload-url op clamps maxSize to maxUploadSize", async () => {
    const seen: SignUploadOptions[] = [];
    const adapter = {
      ...signing(),
      signedUploadUrl: (_key: string, opts: SignUploadOptions) => {
        seen.push(opts);
        return Promise.resolve({
          headers: {},
          method: "PUT" as const,
          url: "https://fake.local/k.bin",
        });
      },
    } satisfies Adapter;
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 5,
      operations: ["signedUploadUrl"],
    });

    await r.handle(
      post({ expiresIn: 60, key: "a.bin", op: "signed-upload-url" })
    );
    await r.handle(
      post({
        expiresIn: 60,
        key: "b.bin",
        maxSize: 999,
        op: "signed-upload-url",
      })
    );
    await r.handle(
      post({
        expiresIn: 60,
        key: "c.bin",
        maxSize: 3,
        op: "signed-upload-url",
      })
    );

    expect(seen.map((opts) => opts.maxSize)).toEqual([5, 5, 3]);
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

  test("an oversized JSON body is refused with 413", async () => {
    const r = router({ maxJsonBodySize: 64, operations: ["head"] });
    const big = JSON.stringify({ key: "x".repeat(200), op: "head" });
    // Declared too large up front (refused before the body is read).
    const declared = await r.handle(
      post(JSON.parse(big), { "content-length": String(big.length) })
    );
    expect(declared.status).toBe(413);
    expect(
      (await readJson<{ error: { reason: string } }>(declared)).error.reason
    ).toBe("size");
    // Streamed without a length: refused once the running total passes the cap.
    const streamed = await r.handle(
      new Request(ENDPOINT, {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            const bytes = new TextEncoder().encode(big);
            controller.enqueue(bytes.subarray(0, 40));
            controller.enqueue(bytes.subarray(40));
            controller.close();
          },
        }),
        // @ts-expect-error -- Bun/undici streaming request bodies need `duplex`
        duplex: "half",
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(streamed.status).toBe(413);
    // No body at all is just invalid JSON.
    const empty = await r.handle(new Request(ENDPOINT, { method: "POST" }));
    expect(empty.status).toBe(422);
    // Under the cap is fine.
    expect((await r.handle(post({ key: "a", op: "head" }))).status).not.toBe(
      413
    );
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
    const id = await signToken(
      {
        exp: NOW + 60_000,
        key: "manual",
        origin: "https://app.test",
        path: "/api/files",
      },
      SECRET
    );
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

describe("createFilesRouter — request signal", () => {
  // By the time each op reaches storage the client has gone (the request's
  // signal fired while the per-request `files` factory ran), so the storage
  // call must see the signal and stop rather than finish for nobody.
  const disconnecting = (adapter: Adapter) => {
    const controller = new AbortController();
    const files = createFiles({ adapter });
    const r = createFilesRouter({
      allowedOrigins: () => true,
      downloadMode: "redirect",
      files: () => {
        controller.abort();
        return files;
      },
      now: () => NOW,
      operations: ["download", "signedUploadUrl", "upload", "url"],
      secret: SECRET,
    });
    return { files, r, signal: controller.signal };
  };

  const abortedEnvelope = async (res: Response) => {
    expect(res.status).toBe(500);
    expect(
      (await readJson<{ error: { message: string } }>(res)).error.message
    ).toContain("aborted");
  };

  test("url, the download redirect, and signed-upload-url stop", async () => {
    const adapter = signing();
    await seed(adapter, "a.txt", "hello");
    const { r, signal } = disconnecting(adapter);
    await abortedEnvelope(
      await r.handle(
        new Request(ENDPOINT, {
          body: JSON.stringify({ key: "a.txt", op: "url" }),
          method: "POST",
          signal,
        })
      )
    );
    const second = disconnecting(adapter);
    await abortedEnvelope(
      await second.r.handle(
        new Request(`${ENDPOINT}?op=download&key=a.txt`, {
          signal: second.signal,
        })
      )
    );
    const third = disconnecting(adapter);
    await abortedEnvelope(
      await third.r.handle(
        new Request(ENDPOINT, {
          body: JSON.stringify({
            expiresIn: 60,
            key: "k.bin",
            op: "signed-upload-url",
          }),
          method: "POST",
          signal: third.signal,
        })
      )
    );
  });

  test("explicit and proxy uploads stop and store nothing", async () => {
    const explicit = disconnecting(memory());
    await abortedEnvelope(
      await explicit.r.handle(
        new Request(`${ENDPOINT}?op=upload&key=a.txt`, {
          body: "hello",
          method: "PUT",
          signal: explicit.signal,
        })
      )
    );
    expect(await explicit.files.exists("a.txt")).toBe(false);

    const proxy = disconnecting(memory());
    const token = await signToken(
      {
        exp: NOW + 60_000,
        key: "p.txt",
        origin: "https://app.test",
        path: "/api/files",
        via: "proxy",
      },
      SECRET
    );
    await abortedEnvelope(
      await proxy.r.handle(
        new Request(`${ENDPOINT}?op=proxy&token=${encodeURIComponent(token)}`, {
          body: "hello",
          method: "PUT",
          signal: proxy.signal,
        })
      )
    );
    expect(await proxy.files.exists("p.txt")).toBe(false);
  });

  test("presign and complete hand storage the signal", async () => {
    const presign = disconnecting(signing());
    const res = await presign.r.handle(
      new Request(ENDPOINT, {
        body: JSON.stringify({
          files: [{ name: "x.bin", size: 3, type: "application/octet-stream" }],
          op: "presign",
        }),
        method: "POST",
        signal: presign.signal,
      })
    );
    // the signing call sees the abort, which surfaces (the client is gone)
    // rather than being masked as a proxy fallback
    expect(res.status).toBe(500);
    const { error } = await readJson<{ error: { message: string } }>(res);
    expect(error.message).toMatch(/aborted/iu);

    const adapter = memory();
    await seed(adapter, "done.txt", "hi");
    const complete = disconnecting(adapter);
    const id = await signToken(
      {
        exp: NOW + 60_000,
        key: "done.txt",
        origin: "https://app.test",
        path: "/api/files",
      },
      SECRET
    );
    const body = await readJson<{
      files: unknown[];
      errors: { error: { aborted: boolean } }[];
    }>(
      await complete.r.handle(
        new Request(ENDPOINT, {
          body: JSON.stringify({
            completions: [{ id, key: "done.txt" }],
            op: "complete",
          }),
          method: "POST",
          signal: complete.signal,
        })
      )
    );
    expect(body.files).toEqual([]);
    expect(first(body.errors).error.aborted).toBe(true);
  });
});

// --- pre-release hardening ---

interface Uploads {
  uploads: {
    id: string;
    key: string;
    target: { method: string; url: string };
  }[];
}

interface Envelope {
  error: { code: string; message: string; reason?: string };
}

const tokenOf = (url: string): string =>
  new URL(url).searchParams.get("token") as string;

// The JSON payload of an upload token (signed, not encrypted).
const payloadOf = (token: string): { exp: number; via?: string } => {
  const [body = ""] = token.split(".");
  return JSON.parse(atob(body.replaceAll("-", "+").replaceAll("_", "/"))) as {
    exp: number;
    via?: string;
  };
};

const TEXT_FILE = { name: "a.txt", size: 5, type: "text/plain" };

const presignOne = async (
  r: { handle: (req: Request) => Promise<Response> },
  file?: { name: string; size: number; type: string }
) => {
  const res = await r.handle(
    post({ files: [file ?? TEXT_FILE], op: "presign" })
  );
  return first((await readJson<Uploads>(res)).uploads);
};

// The decoded `X-Files-Meta` header of a proxied download.
const filesMeta = (res: Response) =>
  JSON.parse(atob(res.headers.get("x-files-meta") ?? "")) as {
    key: string;
    size?: number;
  };

// A storage error whose message carries what must never reach a client.
const leaky = (code: FilesError["code"], opts = {}) =>
  new FilesError(
    code,
    `${code}: ENOENT lstat '/var/app/storage/t/a.txt' at s3.internal:9000`,
    undefined,
    opts
  );

describe("createFilesRouter — proxied download headers", () => {
  const serve = async (contentType: string, opts = {}) => {
    const adapter = memory();
    await createFiles({ adapter }).upload("f", "body", { contentType });
    const r = router({ adapter, operations: ["download"], ...opts });
    return r.handle(get("op=download&key=f"));
  };

  test("tenant-relative download URLs are never cached", async () => {
    const res = await serve("image/png");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  test("active content is sandboxed; passive media and PDF are not", async () => {
    const sandboxed = [
      "text/html",
      "text/html; charset=utf-8",
      "image/svg+xml",
      "application/xhtml+xml",
      "text/xml",
      "application/octet-stream",
    ];
    for (const type of sandboxed) {
      // oxlint-disable-next-line no-await-in-loop -- one object per case
      const res = await serve(type, {
        authorize: () => ({ disposition: "inline" }),
      });
      expect(res.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'"
      );
    }
    for (const type of [
      "image/png",
      "IMAGE/JPEG",
      "video/mp4",
      "audio/mpeg",
      "application/pdf",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one object per case
      const res = await serve(type, {
        authorize: () => ({ disposition: "inline" }),
      });
      expect(res.headers.get("content-security-policy")).toBeNull();
    }
  });

  test("a content type that isn't one media type is sandboxed", async () => {
    // A browser takes the last entry of a comma-separated list, so each of
    // these renders as HTML or SVG even though it starts with an image type.
    for (const contentType of [
      "image/png, text/html",
      "image/png;x=1,image/svg+xml",
      "video/mp4,text/html",
    ]) {
      const adapter = memory({
        initial: { f: { body: "<script>alert(1)</script>", contentType } },
      });
      const r = router({
        adapter,
        authorize: () => ({ disposition: "inline" }),
        operations: ["download"],
      });
      // oxlint-disable-next-line no-await-in-loop -- one object per case
      const res = await r.handle(get("op=download&key=f"));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toBe(
        "sandbox; default-src 'none'; style-src 'unsafe-inline'"
      );
    }
  });

  test("the default attachment names the file after the key", async () => {
    const adapter = memory({
      initial: {
        "docs/q3 report.pdf": "pdf",
        "docs/résumé.pdf": "pdf",
      },
    });
    const r = router({ adapter, operations: ["download"] });
    const ascii = await r.handle(
      get(`op=download&key=${encodeURIComponent("docs/q3 report.pdf")}`)
    );
    expect(ascii.headers.get("content-disposition")).toBe(
      'attachment; filename="q3 report.pdf"'
    );
    const unicode = await r.handle(
      get(`op=download&key=${encodeURIComponent("docs/résumé.pdf")}`)
    );
    expect(unicode.headers.get("content-disposition")).toBe(
      "attachment; filename=\"r_sum_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf"
    );
    // A disposition `authorize` chose is sent exactly as given.
    const chosen = router({
      adapter,
      authorize: () => ({ disposition: "attachment" }),
    });
    expect(
      (
        await chosen.handle(
          get(`op=download&key=${encodeURIComponent("docs/q3 report.pdf")}`)
        )
      ).headers.get("content-disposition")
    ).toBe("attachment");
  });

  test("X-Files-Meta carries the object's size on a full response only", async () => {
    const adapter = withCapabilities(fakeAdapter({ supportsRange: true }), {
      signedUrl: { supported: false },
    });
    await seed(adapter, "a.txt", "0123456789");
    const r = router({ adapter, operations: ["download"] });
    const full = await r.handle(get("op=download&key=a.txt"));
    expect(full.status).toBe(200);
    expect(filesMeta(full)).toMatchObject({ key: "a.txt", size: 10 });
    const slice = await r.handle(
      get("op=download&key=a.txt", { range: "bytes=2-4" })
    );
    expect(slice.status).toBe(206);
    expect(filesMeta(slice).size).toBeUndefined();
  });

  test("HEAD answers with the GET's headers and never opens the body", async () => {
    const base = withCapabilities(fakeAdapter({ supportsRange: true }), {
      signedUrl: { supported: false },
    });
    await seed(base, "a.txt", "0123456789");
    let downloads = 0;
    const adapter: Adapter = {
      ...base,
      download: (key, opts) => {
        downloads += 1;
        return base.download(key, opts);
      },
    };
    const r = router({ adapter, operations: ["download"] });
    const head = await r.handle(
      new Request(`${ENDPOINT}?op=download&key=a.txt`, {
        // Range applies to GET alone, so a HEAD describes the whole object.
        headers: { range: "bytes=2-4" },
        method: "HEAD",
      })
    );
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    expect(head.headers.get("content-length")).toBe("10");
    expect(head.headers.get("content-range")).toBeNull();
    expect(head.headers.get("content-disposition")).toBe(
      'attachment; filename="a.txt"'
    );
    expect(head.headers.get("etag")).not.toBeNull();
    expect(downloads).toBe(0);

    // On a signing adapter, a HEAD gets the same redirect a GET would.
    const signer = signing();
    await seed(signer, "a.txt", "hello");
    const redirected = await router({
      adapter: signer,
      operations: ["download"],
    }).handle(
      new Request(`${ENDPOINT}?op=download&key=a.txt`, { method: "HEAD" })
    );
    expect(redirected.status).toBe(302);
  });
});

describe("createFilesRouter — redirect fallbacks", () => {
  test("a public link url() refuses falls back to the proxy in auto mode", async () => {
    const base = withCapabilities(fakeAdapter(), {
      ...NO_SIGNING,
      publicUrl: true,
    });
    const adapter: Adapter = {
      ...base,
      url: () =>
        Promise.reject(
          new FilesError("Unsupported", "policy wants a disposition")
        ),
    };
    await seed(adapter, "a.txt", "hello");
    const auto = router({
      adapter,
      forceDownloadDisposition: false,
      operations: ["download"],
    });
    const res = await auto.handle(get("op=download&key=a.txt"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");

    const redirect = router({
      adapter,
      downloadMode: "redirect",
      forceDownloadDisposition: false,
      operations: ["download"],
    });
    expect((await redirect.handle(get("op=download&key=a.txt"))).status).toBe(
      422
    );

    const broken: Adapter = {
      ...base,
      url: () => Promise.reject(new FilesError("Provider", "cdn down")),
    };
    await seed(broken, "a.txt", "hello");
    const failing = router({
      adapter: broken,
      forceDownloadDisposition: false,
      operations: ["download"],
    });
    expect((await failing.handle(get("op=download&key=a.txt"))).status).toBe(
      500
    );
  });

  test("any Unsupported refusal on the signed path also falls back", async () => {
    const base = signing();
    const adapter: Adapter = {
      ...base,
      url: () => Promise.reject(new FilesError("Unsupported", "not today")),
    };
    await seed(adapter, "a.txt", "hello");
    const r = router({ adapter, operations: ["download"] });
    expect((await r.handle(get("op=download&key=a.txt"))).status).toBe(200);
  });
});

describe("createFilesRouter — error messages stay on the server", () => {
  test("a plain Error from authorize is a generic 500, handed to onError", async () => {
    const reported: [unknown, Request][] = [];
    const leak = new Error("postgres://admin:hunter2@10.0.0.5 refused");
    const r = router({
      authorize: () => {
        throw leak;
      },
      onError: (error, req) => {
        reported.push([error, req]);
      },
    });
    const res = await r.handle(post({ key: "a", op: "head" }));
    expect(res.status).toBe(500);
    const body = await readJson<Envelope>(res);
    expect(body.error).toEqual({
      code: "Provider",
      message: "internal server error",
    });
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(reported).toHaveLength(1);
    expect(reported[0]?.[0]).toBe(leak);
    expect(reported[0]?.[1]).toBeInstanceOf(Request);
  });

  test("a FilesError or RouterError is not reported, and a throwing onError is contained", async () => {
    let calls = 0;
    const quiet = router({
      authorize: () => {
        throw new FilesError("Unauthorized", "sign in");
      },
      onError: () => {
        calls += 1;
      },
    });
    expect((await quiet.handle(post({ key: "a", op: "head" }))).status).toBe(
      401
    );
    expect((await quiet.handle(post({ key: "../x", op: "nope" }))).status).toBe(
      422
    );
    expect(calls).toBe(0);

    const noisy = router({
      authorize: () => {
        throw new TypeError("boom");
      },
      onError: () => {
        throw new Error("logger down");
      },
    });
    const res = await noisy.handle(post({ key: "a", op: "head" }));
    expect(res.status).toBe(500);
    expect((await readJson<Envelope>(res)).error.message).toBe(
      "internal server error"
    );
  });

  test("onError defaults to console.error", async () => {
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };
    try {
      const r = router({
        authorize: () => {
          // oxlint-disable-next-line no-throw-literal -- a non-Error throw is part of what's covered
          throw "string thrown";
        },
      });
      expect((await r.handle(post({ key: "a", op: "head" }))).status).toBe(500);
    } finally {
      console.error = original;
    }
    expect(logged).toEqual([
      ["files-sdk/api: unexpected error", "string thrown"],
    ]);
  });

  test("a provider's NotFound names neither the key prefix nor anything else", async () => {
    const r = router({ authorize: () => ({ keyPrefix: "users/u1/" }) });
    const single = await r.handle(post({ key: "nope.txt", op: "head" }));
    expect(single.status).toBe(404);
    expect((await readJson<Envelope>(single)).error).toEqual({
      code: "NotFound",
      message: "not found",
    });

    const bulk = await readJson<{
      errors: { key: string; error: { code: string; message: string } }[];
    }>(await r.handle(post({ keys: ["gone.txt"], op: "head-many" })));
    expect(first(bulk.errors).key).toBe("gone.txt");
    expect(first(bulk.errors).error.code).toBe("NotFound");
    expect(first(bulk.errors).error.message).toBe("not found");
  });

  test("an SDK refusal naming both ends of a copy names both client keys", async () => {
    const base = memory();
    const adapter: Adapter = {
      ...base,
      copy: (from, to) =>
        Promise.reject(new FilesError("Invalid", `${from} -> ${to} refused`)),
    };
    const r = router({
      adapter,
      allowedOrigins: () => true,
      authorize: () => ({ keyPrefix: "users/u1/" }),
    });
    const res = await r.handle(post({ from: "a", op: "copy", to: "a/b" }));
    expect(res.status).toBe(422);
    expect((await readJson<Envelope>(res)).error.message).toBe(
      "a -> a/b refused"
    );
  });

  test("an Unsupported list refusal is rewritten to the client prefix", async () => {
    const base = memory();
    const adapter: Adapter = {
      ...base,
      list: (opts) =>
        Promise.reject(
          new FilesError("Unsupported", `cannot list ${String(opts?.prefix)}`)
        ),
    };
    const r = router({ adapter, authorize: () => ({ keyPrefix: "t/" }) });
    const res = await r.handle(post({ op: "list", prefix: "docs/" }));
    expect((await readJson<Envelope>(res)).error.message).toBe(
      "cannot list docs/"
    );
  });

  test("storage messages stay on the server; Provider and Unauthorized go to onError", async () => {
    const cases: [FilesError, number, string, boolean][] = [
      [leaky("Provider"), 500, "storage provider error", true],
      [leaky("NotFound"), 404, "not found", false],
      [
        leaky("Conflict"),
        409,
        "the request conflicts with the file's current state",
        false,
      ],
      [leaky("Unauthorized"), 401, "storage access denied", true],
      [
        leaky("Provider", { aborted: true, timedOut: true }),
        500,
        "storage request timed out",
        false,
      ],
      [leaky("Provider", { aborted: true }), 500, "request aborted", false],
    ];
    for (const [error, status, message, isReported] of cases) {
      const reported: unknown[] = [];
      const r = router({
        adapter: { ...memory(), head: () => Promise.reject(error) },
        authorize: () => ({ keyPrefix: "t/" }),
        onError: (e) => {
          reported.push(e);
        },
      });
      // oxlint-disable-next-line no-await-in-loop -- one router per case
      const res = await r.handle(post({ key: "a.txt", op: "head" }));
      expect(res.status).toBe(status);
      // oxlint-disable-next-line no-await-in-loop -- one router per case
      const body = await readJson<Envelope>(res);
      expect(body.error.message).toBe(message);
      expect(JSON.stringify(body)).not.toContain("/var/app");
      expect(reported).toEqual(isReported ? [error] : []);
    }

    // A bulk entry is withheld the same way, and reported the same way.
    const reported: unknown[] = [];
    const failing = leaky("Provider");
    const bulk = router({
      adapter: { ...memory(), head: () => Promise.reject(failing) },
      onError: (e) => {
        reported.push(e);
      },
      operations: ["head"],
    });
    const many = await readJson<{
      errors: { error: { message: string } }[];
    }>(await bulk.handle(post({ keys: ["a.txt"], op: "head-many" })));
    expect(first(many.errors).error.message).toBe("storage provider error");
    expect(reported).toEqual([failing]);

    // So is a `complete` entry whose `head` fails.
    reported.length = 0;
    const completing = router({
      adapter: { ...memory(), head: () => Promise.reject(failing) },
      allowedOrigins: () => true,
      onError: (e) => {
        reported.push(e);
      },
      operations: ["upload"],
    });
    const upload = await presignOne(completing);
    const completed = await readJson<{
      errors: { error: { code: string; message: string } }[];
    }>(
      await completing.handle(
        post({
          completions: [{ id: upload.id, key: upload.key }],
          op: "complete",
        })
      )
    );
    expect(first(completed.errors).error).toMatchObject({
      code: "Provider",
      message: "storage provider error",
    });
    expect(reported).toEqual([failing]);
  });

  test("an app hook's FilesError keeps its message, whatever its code", async () => {
    const fromAuthorize = router({
      authorize: () => {
        throw new FilesError("NotFound", "video not found");
      },
    });
    const denied = await fromAuthorize.handle(post({ key: "a", op: "head" }));
    expect(denied.status).toBe(404);
    expect((await readJson<Envelope>(denied)).error.message).toBe(
      "video not found"
    );

    const fromFactory = createFilesRouter({
      files: () => {
        throw new FilesError("Unauthorized", "unknown tenant");
      },
      operations: ["head"],
      secret: SECRET,
    });
    const unknown = await fromFactory.handle(post({ key: "a", op: "head" }));
    expect(unknown.status).toBe(401);
    expect((await readJson<Envelope>(unknown)).error.message).toBe(
      "unknown tenant"
    );

    const fromHook = router({
      allowedOrigins: () => true,
      onUploadComplete: () => {
        throw new FilesError("Conflict", "a.txt is locked");
      },
      operations: ["upload"],
    });
    const locked = await fromHook.handle(put("op=upload&key=a.txt", "x"));
    expect(locked.status).toBe(409);
    expect((await readJson<Envelope>(locked)).error.message).toBe(
      "a.txt is locked"
    );
  });
});

describe("createFilesRouter — key safety", () => {
  test("a backslash is a separator for the .. check", async () => {
    const r = router({
      authorize: () => ({ keyPrefix: "users/u1/" }),
    });
    for (const key of [
      "..\\u2\\secret.txt",
      "a\\..\\..\\u2\\secret.txt",
      "a\\.\\b",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one key per case
      const res = await r.handle(post({ key, op: "head" }));
      expect(res.status).toBe(422);
      // oxlint-disable-next-line no-await-in-loop -- one key per case
      const { message } = (await readJson<Envelope>(res)).error;
      // the refusal names the client's key, not the scoped one
      expect(message).toBe(`unsafe key: ${key}`);
    }
    // A leading backslash is refused like a leading slash (the resolved key
    // would be drive-rooted on Windows).
    const bare = router({ operations: ["head"] });
    expect((await bare.handle(post({ key: "\\abs", op: "head" }))).status).toBe(
      422
    );
    // A backslash inside a name is still an ordinary character.
    expect((await r.handle(post({ key: "a\\b.txt", op: "head" }))).status).toBe(
      404
    );
    expect((await r.handle(post({ op: "list", prefix: "..\\" }))).status).toBe(
      422
    );
  });
});

describe("createFilesRouter — search scan budget", () => {
  test("a pattern that matches nothing stops at maxSearchScan with truncated", async () => {
    const adapter = memory();
    const files = createFiles({ adapter });
    await Promise.all(
      ["a", "b", "c", "d", "e"].map((k) => files.upload(`${k}.txt`, k))
    );
    const r = router({ adapter, maxSearchScan: 3, operations: ["search"] });
    const none = await readJson<{ matches: unknown[]; truncated: boolean }>(
      await r.handle(post({ op: "search", pattern: "*.png" }))
    );
    expect(none).toEqual({ matches: [], truncated: true });
    const some = await readJson<{
      matches: { key: string }[];
      truncated: boolean;
    }>(await r.handle(post({ op: "search", pattern: "*.txt" })));
    expect(some.matches.map((m) => m.key)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(some.truncated).toBe(true);
    // Exactly the budget, with nothing left over, is a complete walk.
    const exact = router({ adapter, maxSearchScan: 5, operations: ["search"] });
    expect(
      (
        await readJson<{ truncated: boolean }>(
          await exact.handle(post({ op: "search", pattern: "*.png" }))
        )
      ).truncated
    ).toBe(false);
  });
});

describe("createFilesRouter — upload tokens", () => {
  test("a direct-to-storage token doesn't redeem at the proxy", async () => {
    const adapter = signing();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const upload = await presignOne(r);
    expect(upload.target.url).toContain("fake.local");
    const res = await r.handle(
      put(`op=proxy&token=${encodeURIComponent(upload.id)}`, "hello")
    );
    expect(res.status).toBe(401);
    expect((await readJson<Envelope>(res)).error.message).toContain(
      "not issued for the proxy"
    );
  });

  test("complete redeems a token within the grace period after it expires", async () => {
    let now = NOW;
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      now: () => now,
      operations: ["upload"],
    });
    const upload = await presignOne(r);
    const proxyQuery = `op=proxy&token=${encodeURIComponent(tokenOf(upload.target.url))}`;
    now += 290_000;
    expect((await r.handle(put(proxyQuery, "bytes"))).status).toBe(200);
    // The body finished streaming after the 300s window; complete still works.
    now += 110_000;
    const done = await readJson<{ files: { key: string }[] }>(
      await r.handle(
        post({
          completions: [{ id: upload.id, key: upload.key }],
          op: "complete",
        })
      )
    );
    expect(first(done.files).key).toBe(upload.key);
    // ...but the proxy PUT itself is held to the window.
    expect((await r.handle(put(proxyQuery, "more"))).status).toBe(401);
    // Past the grace period the token is spent.
    now = NOW + 300_000 + 3_600_000 + 1;
    const late = await readJson<{ errors: { error: { message: string } }[] }>(
      await r.handle(
        post({
          completions: [{ id: upload.id, key: upload.key }],
          op: "complete",
        })
      )
    );
    expect(first(late.errors).error.message).toBe("upload token expired");
  });

  test("completeGracePeriod: 0 ends complete at the token's expiry", async () => {
    let now = NOW;
    const r = router({
      allowedOrigins: () => true,
      completeGracePeriod: 0,
      now: () => now,
      operations: ["upload"],
    });
    const upload = await presignOne(r);
    await r.handle(
      put(`op=proxy&token=${encodeURIComponent(upload.id)}`, "bytes")
    );
    now += 300_001;
    const res = await readJson<{ errors?: unknown[] }>(
      await r.handle(
        post({
          completions: [{ id: upload.id, key: upload.key }],
          op: "complete",
        })
      )
    );
    expect(res.errors).toHaveLength(1);
  });

  test("a proxy token isn't clamped to the adapter's signed-upload cap", async () => {
    // Can sign uploads (for 30s at most) but not bind a content type, so a
    // typed file goes through the proxy.
    const adapter = withCapabilities(fakeAdapter(), {
      signedUpload: { maxExpiresIn: 30, supported: true },
    });
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const proxied = await presignOne(r);
    expect(proxied.target.url).toContain("op=proxy");
    expect(payloadOf(proxied.id)).toMatchObject({
      exp: NOW + 300_000,
      via: "proxy",
    });
    // An untyped file is signed, and its token follows the signing cap.
    const signed = await presignOne(r, { name: "a.bin", size: 1, type: "" });
    expect(signed.target.url).toContain("fake.local");
    expect(payloadOf(signed.id).exp).toBe(NOW + 30_000);
    // authorize's maxExpiresIn still caps the proxy token.
    const capped = router({
      adapter,
      allowedOrigins: () => true,
      authorize: () => ({ maxExpiresIn: 60 }),
    });
    expect(payloadOf((await presignOne(capped)).id).exp).toBe(NOW + 60_000);
  });

  test("presign signs at most maxConcurrency targets at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const base = signing();
    const adapter: Adapter = {
      ...base,
      signedUploadUrl: async (key, opts) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Bun.sleep(2);
        inFlight -= 1;
        return base.signedUploadUrl(key, opts);
      },
    };
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxConcurrency: 2,
      operations: ["upload"],
    });
    const file = { name: "a.txt", size: 1, type: "text/plain" };
    const res = await readJson<Uploads>(
      await r.handle(
        post({ files: Array.from({ length: 6 }, () => file), op: "presign" })
      )
    );
    expect(res.uploads).toHaveLength(6);
    expect(peak).toBe(2);
  });

  test("complete honors authorize's filterKeys", async () => {
    let hidden = false;
    const r = router({
      allowedOrigins: () => true,
      authorize: () => ({ filterKeys: () => !hidden }),
    });
    const upload = await presignOne(r);
    await r.handle(
      put(`op=proxy&token=${encodeURIComponent(upload.id)}`, "bytes")
    );
    hidden = true;
    const body = await readJson<{
      files: unknown[];
      errors: { key: string; error: { code: string; reason?: string } }[];
    }>(
      await r.handle(
        post({
          completions: [{ id: upload.id, key: upload.key }],
          op: "complete",
        })
      )
    );
    expect(body.files).toEqual([]);
    expect(first(body.errors)).toMatchObject({
      error: { code: "Forbidden", reason: "forbidden" },
      key: upload.key,
    });
  });
});

describe("createFilesRouter — authorize params", () => {
  test("presign and the keyed upload tell authorize what the client declared", async () => {
    const seen: { operation: string; params: unknown }[] = [];
    const r = router({
      allowedOrigins: () => true,
      authorize: ({ operation, params }) => {
        seen.push({ operation, params });
      },
    });
    const file = { name: "photo.png", size: 5, type: "image/png" };
    await r.handle(post({ expiresIn: 60, files: [file], op: "presign" }));
    await r.handle(post({ files: [file], op: "presign" }));
    await r.handle(
      put("op=upload&key=a.txt", "hello", {
        "content-length": "5",
        "content-type": "text/plain",
      })
    );
    await r.handle(put("op=upload&key=b.txt", "hello"));
    expect(seen.map((s) => s.params)).toEqual([
      { expiresIn: 60, files: [file] },
      { files: [file] },
      { contentType: "text/plain", size: 5 },
      expect.not.objectContaining({ size: expect.anything() }),
    ]);
  });
});

describe("createFilesRouter — bulk ops and a gone client", () => {
  test("head-many / exists-many / delete-many stop before touching storage", async () => {
    let calls = 0;
    const base = memory();
    const adapter: Adapter = {
      ...base,
      delete: (key, opts) => {
        calls += 1;
        return base.delete(key, opts);
      },
      head: (key, opts) => {
        calls += 1;
        return base.head(key, opts);
      },
    };
    const controller = new AbortController();
    const files = createFiles({ adapter });
    await files.upload("a.txt", "x");
    calls = 0;
    const r = createFilesRouter({
      allowedOrigins: () => true,
      files: () => {
        controller.abort();
        return files;
      },
      operations: ["head", "exists", "delete"],
      secret: SECRET,
    });
    for (const op of ["head-many", "exists-many", "delete-many"]) {
      // oxlint-disable-next-line no-await-in-loop -- one op per case
      const res = await r.handle(
        new Request(ENDPOINT, {
          body: JSON.stringify({ keys: ["a.txt"], op }),
          method: "POST",
          signal: controller.signal,
        })
      );
      expect(res.status).toBe(500);
      // oxlint-disable-next-line no-await-in-loop -- one op per case
      expect((await readJson<Envelope>(res)).error.message).toContain(
        "aborted"
      );
    }
    expect(calls).toBe(0);
    expect(await files.exists("a.txt")).toBe(true);
  });
});

describe("createFilesRouter — client content types", () => {
  const COMMA_TYPE = "image/png, text/html";

  test("a content type that isn't one media type is refused at every entry", async () => {
    const adapter = signing();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload", "signedUploadUrl"],
    });
    const refusals = [
      await r.handle(
        put("op=upload&key=x.png", "<script>", { "content-type": COMMA_TYPE })
      ),
      await r.handle(
        post({
          files: [{ name: "x.png", size: 8, type: COMMA_TYPE }],
          op: "presign",
        })
      ),
      await r.handle(
        post({
          contentType: "image/png;x=1,image/svg+xml",
          expiresIn: 60,
          key: "x.png",
          op: "signed-upload-url",
        })
      ),
    ];
    for (const res of refusals) {
      expect(res.status).toBe(422);
      // oxlint-disable-next-line no-await-in-loop -- one response per entry
      expect((await readJson<Envelope>(res)).error).toMatchObject({
        code: "Validation",
        reason: "type",
      });
    }
    expect(await createFiles({ adapter }).exists("x.png")).toBe(false);
  });

  test("an absent or well-formed content type is accepted", async () => {
    const r = router({ allowedOrigins: () => true, operations: ["upload"] });
    expect((await r.handle(put("op=upload&key=a.bin", "x"))).status).toBe(200);
    expect(
      (
        await r.handle(
          put("op=upload&key=a.txt", "x", {
            "content-type": "text/plain; charset=utf-8",
          })
        )
      ).status
    ).toBe(200);
    expect(
      (
        await r.handle(
          post({ files: [{ name: "a", size: 1, type: "" }], op: "presign" })
        )
      ).status
    ).toBe(200);
  });
});

describe("createFilesRouter — upload token binding", () => {
  test("a token minted on one host doesn't redeem on another", async () => {
    // A host-selected factory: each tenant's host gets its own instance.
    const a = createFiles({ adapter: memory() });
    const b = createFiles({ adapter: memory() });
    const r = createFilesRouter({
      allowedOrigins: () => true,
      files: (req) => (new URL(req.url).host === "a.app.test" ? a : b),
      now: () => NOW,
      operations: ["upload"],
      secret: SECRET,
    });
    const presigned = first(
      (
        await readJson<Uploads>(
          await r.handle(
            new Request("https://a.app.test/api/files", {
              body: JSON.stringify({ files: [TEXT_FILE], op: "presign" }),
              method: "POST",
            })
          )
        )
      ).uploads
    );
    const elsewhere = new URL(presigned.target.url);
    elsewhere.host = "b.app.test";
    const res = await r.handle(
      new Request(elsewhere, { body: "bytes", method: "PUT" })
    );
    expect(res.status).toBe(401);
    expect((await readJson<Envelope>(res)).error.message).toBe(
      "upload token was issued for a different origin"
    );
    expect(await b.exists(presigned.key)).toBe(false);

    const completed = await readJson<{
      errors: { error: { code: string; message: string } }[];
    }>(
      await r.handle(
        new Request("https://b.app.test/api/files", {
          body: JSON.stringify({
            completions: [{ id: presigned.id, key: presigned.key }],
            op: "complete",
          }),
          method: "POST",
        })
      )
    );
    expect(first(completed.errors).error).toMatchObject({
      code: "Unauthorized",
      message: "upload token was issued for a different origin",
    });

    // On the host that minted it, the same token works.
    const home = await r.handle(
      new Request(presigned.target.url, { body: "bytes", method: "PUT" })
    );
    expect(home.status).toBe(200);
    expect(await a.exists(presigned.key)).toBe(true);
  });

  test("a token holds the upload to the size authorize approved", async () => {
    const adapter = memory();
    const sizes: unknown[] = [];
    const r = router({
      adapter,
      allowedOrigins: () => true,
      authorize: ({ params }) => {
        // A per-user quota, checked against what the client declared.
        sizes.push(params.files);
      },
      maxUploadSize: 1000,
    });
    const upload = await presignOne(r, { name: "a.txt", size: 5, type: "" });
    expect(sizes).toEqual([[{ name: "a.txt", size: 5, type: "" }]]);
    expect(payloadOf(upload.id)).toMatchObject({ maxSize: 5 });
    const token = encodeURIComponent(tokenOf(upload.target.url));
    const declared = await r.handle(
      put(`op=proxy&token=${token}`, "0123456789", { "content-length": "10" })
    );
    expect(declared.status).toBe(422);
    const streamed = await r.handle(
      put(`op=proxy&token=${token}`, "0123456789")
    );
    expect(streamed.status).toBe(422);
    expect((await readJson<Envelope>(streamed)).error.reason).toBe("size");
    expect(await createFiles({ adapter }).exists(upload.key)).toBe(false);

    // Bytes that reach storage some other way are still caught at complete.
    await createFiles({ adapter }).upload(upload.key, "0123456789");
    const completed = await readJson<{
      errors: { error: { message: string; reason?: string } }[];
    }>(
      await r.handle(
        post({
          completions: [{ id: upload.id, key: upload.key }],
          op: "complete",
        })
      )
    );
    expect(first(completed.errors).error).toMatchObject({
      message: "uploaded object is 10 bytes, exceeds maxSize 5",
      reason: "size",
    });
  });

  test("a signed target binds the declared size when storage can", async () => {
    const maxSizes: (number | undefined)[] = [];
    const base = signing();
    const adapter: Adapter = {
      ...base,
      signedUploadUrl: (key, opts) => {
        maxSizes.push(opts.maxSize);
        return base.signedUploadUrl(key, opts);
      },
    };
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 1000,
      operations: ["upload"],
    });
    await presignOne(r, { name: "a.txt", size: 5, type: "text/plain" });
    expect(maxSizes).toEqual([5]);

    // An adapter that can't bind a size still signs, and `complete` enforces
    // the declared size from the token.
    const loose = withCapabilities(fakeAdapter(), {
      signedUpload: { contentType: true, supported: true },
    });
    const unbound = await presignOne(
      router({
        adapter: loose,
        allowedOrigins: () => true,
        operations: ["upload"],
      }),
      { name: "c.txt", size: 5, type: "text/plain" }
    );
    expect(unbound.target.url).toContain("fake.local");
    expect(payloadOf(unbound.id)).toMatchObject({ maxSize: 5 });
  });

  test("a size is optional, and must be a whole number of bytes", async () => {
    const r = router({
      allowedOrigins: () => true,
      maxUploadSize: 1000,
      operations: ["upload"],
    });
    const unknown = first(
      (
        await readJson<Uploads>(
          await r.handle(
            post({ files: [{ name: "a", type: "" }], op: "presign" })
          )
        )
      ).uploads
    );
    expect(payloadOf(unknown.id)).toMatchObject({ maxSize: 1000 });
    for (const size of [-1, 1.5]) {
      // oxlint-disable-next-line no-await-in-loop -- one size per case
      const res = await r.handle(
        post({ files: [{ name: "a", size, type: "" }], op: "presign" })
      );
      expect(res.status).toBe(422);
    }
  });
});

describe("createFilesRouter — zero-byte uploads", () => {
  test("a PUT with Content-Length: 0 and no body stream is an empty upload", async () => {
    // Bun.serve, Deno, and workerd hand such a request a null body.
    const adapter = memory();
    const r = router({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 10,
      operations: ["upload"],
    });
    const empty = (query: string) =>
      new Request(`${ENDPOINT}?${query}`, {
        headers: { "content-length": "0" },
        method: "PUT",
      });
    const keyed = await r.handle(empty("op=upload&key=empty.txt"));
    expect(keyed.status).toBe(200);
    expect((await createFiles({ adapter }).head("empty.txt")).size).toBe(0);

    const upload = await presignOne(r, { name: "e.txt", size: 0, type: "" });
    const proxied = await r.handle(
      empty(`op=proxy&token=${encodeURIComponent(tokenOf(upload.target.url))}`)
    );
    expect(proxied.status).toBe(200);
    expect((await createFiles({ adapter }).head(upload.key)).size).toBe(0);
  });
});

describe("createFilesRouter — reserved storage, however it's spelled", () => {
  const withPlugins = async () => {
    const adapter = memory();
    const files = createFiles({
      adapter,
      plugins: [versioning(), softDelete()],
    });
    await files.upload("a.txt", "v1");
    await files.upload("a.txt", "v2");
    await files.upload("b.txt", "x");
    await files.delete("b.txt");
    const r = createFilesRouter({
      allowedOrigins: () => true,
      files,
      now: () => NOW,
      operations: ["head", "delete", "download", "list", "restoreVersion"],
      secret: SECRET,
    });
    return { files, r };
  };

  test("case and backslash variants of a reserved prefix are refused", async () => {
    const { files, r } = await withPlugins();
    for (const key of [
      ".TRASH/b.txt",
      ".Trash/b.txt",
      ".trash\\b.txt",
      ".VERSIONS/a.txt",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one key per case
      const head = await r.handle(post({ key, op: "head" }));
      expect(head.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- one key per case
      const del = await r.handle(post({ key, op: "delete" }));
      expect(del.status).toBe(403);
    }
    expect(
      (await r.handle(post({ op: "list", prefix: ".TRASH/" }))).status
    ).toBe(403);
    expect(await files.trashed()).toHaveLength(1);
  });

  test("a versionId that could leave the key's version dir is refused", async () => {
    const { r } = await withPlugins();
    for (const versionId of [
      "",
      ".",
      "..",
      "a..b",
      "x\\y",
      "x/y",
      "x\u0000y",
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one id per case
      const res = await r.handle(
        post({ key: "a.txt", op: "restore-version", versionId })
      );
      expect(res.status).toBe(422);
    }
  });
});

describe("createFilesRouter — search page size", () => {
  test("a client's limit doesn't multiply the provider list calls", async () => {
    const base = memory();
    const files = createFiles({ adapter: base });
    await Promise.all(
      Array.from({ length: 50 }, (_, i) => files.upload(`k${i}.txt`, "x"))
    );
    const limits: (number | undefined)[] = [];
    const adapter: Adapter = {
      ...base,
      list: (opts) => {
        limits.push(opts?.limit);
        return base.list(opts);
      },
    };
    const r = router({ adapter, operations: ["search"] });
    const res = await readJson<{ matches: unknown[]; truncated: boolean }>(
      await r.handle(post({ limit: 1, op: "search", pattern: "nomatch*" }))
    );
    expect(res).toEqual({ matches: [], truncated: false });
    expect(limits).toEqual([1000]);
  });
});
