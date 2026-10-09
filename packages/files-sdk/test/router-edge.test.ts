// oxlint-disable unicorn/no-await-expression-member -- asserting `.status`/JSON fields off awaited Responses is the natural shape here.
import { describe, expect, spyOn, test } from "bun:test";

import type { CreateFilesRouterOptions } from "../src/api/index.js";
import { createFilesRouter } from "../src/api/index.js";
import type { Adapter } from "../src/index.js";
import { createFiles, FilesError } from "../src/index.js";
import {
  signToken,
  verifyToken,
} from "../src/internal/router-core/sign-token.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";

const ENDPOINT = "https://app.test/api/files";
const SECRET = "edge-secret";
const NOW = 2_000_000_000;

const signing = (maxExpiresIn?: number): Adapter =>
  withCapabilities(fakeAdapter({ supportsRange: true }), {
    signedUrl: {
      supported: true,
      ...(maxExpiresIn !== undefined && { maxExpiresIn }),
    },
  });

const throwingSign = (refusal: Error): Adapter => ({
  ...withCapabilities(fakeAdapter(), {
    signedUpload: { contentType: true, maxSize: true, supported: true },
  }),
  signedUploadUrl: () => Promise.reject(refusal),
});

const mk = (
  opts: Partial<CreateFilesRouterOptions> & { adapter?: Adapter } = {}
) => {
  const { adapter, ...rest } = opts;
  return createFilesRouter({
    files: createFiles({ adapter: adapter ?? memory() }),
    now: () => NOW,
    secret: SECRET,
    ...rest,
  });
};

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(ENDPOINT, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
const readJson = <T>(res: Response): Promise<T> => res.json() as Promise<T>;
const first = <T>(items: readonly T[]): T => items[0] as T;
const put = (
  query: string,
  body: string | null,
  headers: Record<string, string> = {}
) =>
  new Request(`${ENDPOINT}?${query}`, {
    ...(body !== null && { body }),
    headers,
    method: "PUT",
  });

describe("sign-token", () => {
  test("valid round-trip", async () => {
    const token = await signToken({ exp: NOW + 1000, key: "k" }, SECRET);
    const result = await verifyToken(token, SECRET, NOW);
    expect(result.ok && result.payload.key).toBe("k");
  });

  test("malformed (no dot)", async () => {
    expect(await verifyToken("nodot", SECRET, NOW)).toMatchObject({
      failure: "malformed",
    });
  });

  test("bad base64 signature → malformed", async () => {
    expect(await verifyToken("body.@@@invalid", SECRET, NOW)).toMatchObject({
      failure: "malformed",
    });
  });

  test("wrong signature", async () => {
    const token = await signToken({ exp: NOW + 1000, key: "k" }, SECRET);
    const other = await signToken({ exp: NOW + 1000, key: "k" }, "different");
    const tampered = `${token.split(".")[0]}.${other.split(".")[1]}`;
    expect(await verifyToken(tampered, SECRET, NOW)).toMatchObject({
      failure: "signature",
    });
  });

  test("expired", async () => {
    const token = await signToken({ exp: NOW - 1000, key: "k" }, SECRET);
    expect(await verifyToken(token, SECRET, NOW)).toMatchObject({
      failure: "expired",
    });
  });
});

describe("createFilesRouter — secret resolution", () => {
  test("uses FILES_API_SECRET when no secret is given", () => {
    process.env.FILES_API_SECRET = "env-secret";
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: ["head"],
    });
    delete process.env.FILES_API_SECRET;
    expect(router.handle).toBeInstanceOf(Function);
  });

  test("warns and falls back to a random secret", () => {
    delete process.env.FILES_API_SECRET;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    createFilesRouter({
      files: createFiles({ adapter: memory() }),
      operations: ["head"],
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("handler — request validation", () => {
  const r = () => mk({ authorize: () => {} });

  test("non-object body, bad key/keys, bad limit", async () => {
    expect((await r().handle(post([1, 2]))).status).toBe(422);
    expect((await r().handle(post({ key: 5, op: "head" }))).status).toBe(422);
    expect(
      (await r().handle(post({ keys: "x", op: "head-many" }, { origin: "" })))
        .status
    ).toBe(422);
    expect((await r().handle(post({ limit: "big", op: "list" }))).status).toBe(
      422
    );
  });

  test("unsafe list prefix → 422 key", async () => {
    const res = await r().handle(post({ op: "list", prefix: "../escape" }));
    expect(res.status).toBe(422);
    expect(
      (await readJson<{ error: { reason: string } }>(res)).error.reason
    ).toBe("key");
  });

  test("presign requires well-formed file infos", async () => {
    const router = mk({ allowedOrigins: () => true, operations: ["upload"] });
    expect(
      (await router.handle(post({ files: "x", op: "presign" }))).status
    ).toBe(422);
    expect(
      (
        await router.handle(
          post({ files: [{ name: "a", type: "t" }], op: "presign" })
        )
      ).status
    ).toBe(422);
    expect(
      (await router.handle(post({ completions: "x", op: "complete" }))).status
    ).toBe(422);
  });
});

describe("handler — expiry clamping", () => {
  test("url clamps to authorize.maxExpiresIn and capability cap", async () => {
    const adapter = signing(30);
    await createFiles({ adapter }).upload("a", "x");
    const router = mk({
      adapter,
      authorize: () => ({ maxExpiresIn: 100 }),
      operations: ["url"],
    });
    const res = await router.handle(
      post({ expiresIn: 999, key: "a", op: "url" })
    );
    // fakeAdapter.url echoes the (clamped) expiry; capability cap 30 wins.
    expect((await readJson<{ url: string }>(res)).url).toContain("expires=30");
  });

  test("signedUploadUrl clamps to the upload cap, not the download one", async () => {
    let expiresIn: number | undefined;
    const base = withCapabilities(fakeAdapter(), {
      signedUpload: { maxExpiresIn: 20, supported: true },
      signedUrl: { maxExpiresIn: 500, supported: true },
    });
    const adapter: Adapter = {
      ...base,
      signedUploadUrl: (key, opts) => {
        ({ expiresIn } = opts);
        return base.signedUploadUrl(key, opts);
      },
    };
    const router = mk({
      adapter,
      allowedOrigins: () => true,
      authorize: () => ({ maxExpiresIn: 100 }),
      operations: ["signedUploadUrl"],
    });
    const res = await router.handle(
      post({ expiresIn: 999, key: "a", op: "signed-upload-url" })
    );
    expect(res.status).toBe(200);
    expect(expiresIn).toBe(20);
  });
});

describe("origin checks", () => {
  test("same-origin is allowed by default; cross-origin is rejected", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("same.txt", "1");
    const router = mk({ adapter, authorize: () => {} });
    expect(
      (
        await router.handle(
          post(
            { key: "same.txt", op: "delete" },
            { origin: "https://app.test" }
          )
        )
      ).status
    ).toBe(200);

    await createFiles({ adapter }).upload("cross.txt", "1");
    expect(
      (
        await router.handle(
          post(
            { key: "cross.txt", op: "delete" },
            { origin: "https://evil.test" }
          )
        )
      ).status
    ).toBe(403);
  });

  test("absent Origin is allowed; listed Origin is allowed", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a", "1");
    const router = mk({
      adapter,
      allowedOrigins: ["https://trusted.test"],
      authorize: () => {},
    });
    expect((await router.handle(post({ key: "a", op: "delete" }))).status).toBe(
      200
    );
    await createFiles({ adapter }).upload("b", "1");
    expect(
      (
        await router.handle(
          post({ key: "b", op: "delete" }, { origin: "https://trusted.test" })
        )
      ).status
    ).toBe(200);
  });
});

describe("upload edges", () => {
  test("presign falls back to proxy when signing refuses, and surfaces a failure", async () => {
    const presign = (error: Error) =>
      mk({
        adapter: throwingSign(error),
        allowedOrigins: () => true,
        authorize: () => ({ maxExpiresIn: 60 }),
        operations: ["upload"],
      }).handle(
        post({
          files: [{ name: "noext", size: 3, type: "text/plain" }],
          op: "presign",
        })
      );
    // A deterministic refusal the capabilities didn't predict has a working
    // path: the proxy.
    const targets = await Promise.all(
      (["Unsupported", "Invalid"] as const).map(async (code) => {
        const res = await presign(new FilesError(code, "can't bind that"));
        const { uploads } = (await res.json()) as {
          uploads: { target: { url: string } }[];
        };
        return first(uploads).target.url;
      })
    );
    for (const url of targets) {
      expect(url).toContain("op=proxy");
    }
    // A backend failure is a real error, not a reason to proxy.
    const failed = await presign(new Error("storage is down"));
    expect(failed.status).toBe(500);
  });

  test("presign follows signedUpload: what it can't bind goes through the proxy", async () => {
    let signs = 0;
    const counting = (caps: Adapter["capabilities"]): Adapter => {
      const base = withCapabilities(fakeAdapter(), caps ?? {});
      return {
        ...base,
        signedUploadUrl: (key, opts) => {
          signs += 1;
          return base.signedUploadUrl(key, opts);
        },
      };
    };
    const targetFor = async (
      adapter: Adapter,
      file: { name: string; size: number; type: string },
      maxUploadSize?: number
    ): Promise<string> => {
      const router = mk({
        adapter,
        allowedOrigins: () => true,
        operations: ["upload"],
        ...(maxUploadSize !== undefined && { maxUploadSize }),
      });
      const res = await router.handle(post({ files: [file], op: "presign" }));
      const { uploads } = await readJson<{
        uploads: { target: { url: string } }[];
      }>(res);
      return first(uploads).target.url;
    };
    const typed = { name: "a.txt", size: 3, type: "text/plain" };
    const untyped = { name: "a.bin", size: 3, type: "" };

    // A download signer alone doesn't presign uploads any more.
    const downloadOnly = counting({ signedUrl: { supported: true } });
    expect(await targetFor(downloadOnly, typed)).toContain("op=proxy");
    expect(signs).toBe(0);

    // Can't bind a content type: typed files proxy, untyped ones presign.
    const noType = counting({ signedUpload: { supported: true } });
    expect(await targetFor(noType, typed)).toContain("op=proxy");
    expect(await targetFor(noType, untyped)).toContain("fake.local");
    expect(signs).toBe(1);

    // Can't enforce maxSize: proxied whenever the gateway has a size cap.
    const noSize = counting({
      signedUpload: { contentType: true, supported: true },
    });
    expect(await targetFor(noSize, typed, 1024)).toContain("op=proxy");
    expect(await targetFor(noSize, typed)).toContain("fake.local");
    expect(signs).toBe(2);
  });

  test("presign clamps expiry to signedUpload.maxExpiresIn", async () => {
    let expiresIn: number | undefined;
    const base = withCapabilities(fakeAdapter(), {
      signedUpload: {
        contentType: true,
        maxExpiresIn: 30,
        maxSize: true,
        supported: true,
      },
    });
    const adapter: Adapter = {
      ...base,
      signedUploadUrl: (key, opts) => {
        ({ expiresIn } = opts);
        return base.signedUploadUrl(key, opts);
      },
    };
    const router = mk({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    await router.handle(
      post({
        expiresIn: 600,
        files: [{ name: "a.txt", size: 1, type: "text/plain" }],
        op: "presign",
      })
    );
    expect(expiresIn).toBe(30);
  });

  test("complete rejects a tampered token and a missing object", async () => {
    const adapter = memory();
    const router = mk({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const bad = await router.handle(
      post({ completions: [{ id: "no.dot.here", key: "k" }], op: "complete" })
    );
    expect(
      first(
        (await readJson<{ errors: { error: { code: string } }[] }>(bad)).errors
      ).error.code
    ).toBe("Unauthorized");

    const id = await signToken(
      { exp: NOW + 60_000, key: "ghost", path: "/api/files" },
      SECRET
    );
    const missing = await router.handle(
      post({ completions: [{ id, key: "ghost" }], op: "complete" })
    );
    expect(
      first(
        (await readJson<{ errors: { error: { code: string } }[] }>(missing))
          .errors
      ).error.code
    ).toBe("NotFound");
  });

  test("proxy upload: missing token, missing body, oversize", async () => {
    const adapter = memory();
    const files = createFiles({ adapter });
    const router = mk({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 4,
      operations: ["upload"],
    });
    expect((await router.handle(put("op=proxy", "x"))).status).toBe(401);

    const presign = await router.handle(
      post({
        files: [{ name: "x", size: 2, type: "text/plain" }],
        op: "presign",
      })
    );
    const { uploads } = (await presign.json()) as {
      uploads: { key: string; target: { url: string } }[];
    };
    const token = new URL(first(uploads).target.url).searchParams.get(
      "token"
    ) as string;
    const q = `op=proxy&token=${encodeURIComponent(token)}`;
    expect((await router.handle(put(q, null))).status).toBe(422);
    expect(
      (await router.handle(put(q, "0123456789", { "content-length": "10" })))
        .status
    ).toBe(422);
    const streamed = await router.handle(put(q, "0123456789"));
    expect(streamed.status).toBe(422);
    expect(
      (await readJson<{ error: { reason: string } }>(streamed)).error.reason
    ).toBe("size");
    expect(await files.exists(first(uploads).key)).toBe(false);
  });

  test("explicit upload: missing body and oversize", async () => {
    const adapter = memory();
    const files = createFiles({ adapter });
    const router = mk({
      adapter,
      allowedOrigins: () => true,
      maxUploadSize: 3,
      operations: ["upload"],
    });
    expect((await router.handle(put("op=upload&key=k", null))).status).toBe(
      422
    );
    expect(
      (
        await router.handle(
          put("op=upload&key=k", "toolong", { "content-length": "7" })
        )
      ).status
    ).toBe(422);
    const streamed = await router.handle(put("op=upload&key=k", "toolong"));
    expect(streamed.status).toBe(422);
    expect(
      (await readJson<{ error: { reason: string } }>(streamed)).error.reason
    ).toBe("size");
    expect(await files.exists("k")).toBe(false);
  });

  test("explicit upload without a size cap surfaces the provider error", async () => {
    const adapter: Adapter = {
      ...fakeAdapter(),
      upload: () => Promise.reject(new Error("provider write failed")),
    };
    const router = mk({
      adapter,
      allowedOrigins: () => true,
      operations: ["upload"],
    });
    const res = await router.handle(put("op=upload&key=k", "hello"));
    expect(res.status).toBe(500);
    expect(
      (await readJson<{ error: { message: string } }>(res)).error.message
    ).toContain("provider write failed");
  });
});

describe("origin predicate path", () => {
  test("a function predicate sees a present Origin", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a", "1");
    const router = mk({
      adapter,
      allowedOrigins: (origin) => origin === "https://ok.test",
      authorize: () => {},
    });
    expect(
      (
        await router.handle(
          post({ key: "a", op: "delete" }, { origin: "https://ok.test" })
        )
      ).status
    ).toBe(200);
    await createFiles({ adapter }).upload("b", "1");
    expect(
      (
        await router.handle(
          post({ key: "b", op: "delete" }, { origin: "https://no.test" })
        )
      ).status
    ).toBe(403);
  });
});

describe("download range parsing", () => {
  const ranged = async (range: string) => {
    const adapter = memory();
    await createFiles({ adapter }).upload("a.txt", "hello world");
    const router = mk({ adapter, operations: ["download"] });
    return router.handle(
      new Request(`${ENDPOINT}?op=download&key=a.txt`, {
        headers: { range },
        method: "GET",
      })
    );
  };

  test("malformed and empty ranges fall back to the whole object", async () => {
    expect((await ranged("bytes=abc")).status).toBe(200);
    expect((await ranged("bytes=-")).status).toBe(200);
  });

  test("zero suffix and inverted range are unsatisfiable", async () => {
    expect((await ranged("bytes=-0")).status).toBe(416);
    expect((await ranged("bytes=5-3")).status).toBe(416);
  });

  test("any range on an empty object is unsatisfiable, not a 500", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("empty.txt", "");
    const router = mk({ adapter, operations: ["download"] });
    const get = (range: string) =>
      router.handle(
        new Request(`${ENDPOINT}?op=download&key=empty.txt`, {
          headers: { range },
          method: "GET",
        })
      );
    // A suffix range used to resolve to `end = -1`, which the SDK rejected as
    // an inverted range — surfacing as a 500 instead of a 416.
    const suffix = await get("bytes=-5");
    expect(suffix.status).toBe(416);
    expect(suffix.headers.get("content-range")).toBe("bytes */0");
    expect((await get("bytes=0-")).status).toBe(416);
  });
});

describe("metadata round-trips on the wire", () => {
  test("head exposes stored metadata", async () => {
    const adapter = memory();
    await createFiles({ adapter }).upload("m", "x", { metadata: { a: "1" } });
    const router = mk({ adapter, operations: ["head"] });
    const res = await router.handle(post({ key: "m", op: "head" }));
    expect(
      (await readJson<{ file: { metadata: Record<string, string> } }>(res)).file
        .metadata
    ).toEqual({ a: "1" });
  });
});
