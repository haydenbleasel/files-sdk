// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import type {
  CompletionRecord,
  CreateFilesRouterOptions,
  InferUploadData,
  UploadCompleteContext,
} from "../src/api/index.js";
import { createFilesRouter, UploadRejectedError } from "../src/api/index.js";
import { createFilesClient } from "../src/client/index.js";
import type { SendRequest, Transport } from "../src/client/transport.js";
import type { Adapter } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";
import { uploadIdFor } from "../src/internal/files-router/upload-complete.js";
import { memory } from "../src/memory/index.js";
import { fakeAdapter, withCapabilities } from "./fake-adapter.js";

const ENDPOINT = "https://app.test/api/files";
const NOW = 1_000_000_000;

interface Presigned {
  id: string;
  key: string;
  target: { method: string; url: string };
}

interface CompleteBody {
  files: { key: string; size: number; data?: unknown }[];
  errors?: {
    key: string;
    error: {
      code: string;
      message: string;
      aborted?: boolean;
      timedOut?: boolean;
    };
  }[];
}

const signing = (): Adapter =>
  withCapabilities(fakeAdapter(), {
    signedUpload: { contentType: true, maxSize: true, supported: true },
    signedUrl: { disposition: true, supported: true },
  });

const post = (body: unknown) =>
  new Request(ENDPOINT, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const put = (query: string, body: string) =>
  new Request(`${ENDPOINT}?${query}`, {
    body,
    headers: { "content-type": "text/plain" },
    method: "PUT",
  });

const setup = <TData = undefined>(
  opts: Partial<CreateFilesRouterOptions<TData, { userId: string }>> & {
    adapter?: Adapter;
  } = {}
) => {
  const adapter = opts.adapter ?? memory();
  const files = createFiles({ adapter });
  const calls: UploadCompleteContext<{ userId: string }>[] = [];
  const { adapter: _adapter, ...rest } = opts;
  const r = createFilesRouter<TData, { userId: string }>({
    allowedOrigins: () => true,
    authorize: () => ({ context: { userId: "u1" }, keyPrefix: "users/u1/" }),
    files,
    now: () => NOW,
    secret: "lifecycle-secret",
    ...rest,
    ...(rest.onUploadComplete && {
      onUploadComplete: (ctx) => {
        calls.push(ctx);
        return rest.onUploadComplete?.(ctx) as TData;
      },
    }),
  });
  return { adapter, calls, files, r };
};

const presign = async (
  r: { handle: (req: Request) => Promise<Response> },
  name = "photo.png",
  size = 5
): Promise<Presigned> => {
  const res = await r.handle(
    post({ files: [{ name, size, type: "image/png" }], op: "presign" })
  );
  const { uploads } = (await res.json()) as { uploads: Presigned[] };
  return uploads[0] as Presigned;
};

const proxyPut = (
  r: { handle: (req: Request) => Promise<Response> },
  upload: Presigned,
  body = "hello"
) => {
  const token = new URL(upload.target.url).searchParams.get("token") ?? "";
  return r.handle(put(`op=proxy&token=${encodeURIComponent(token)}`, body));
};

const complete = async (
  r: { handle: (req: Request) => Promise<Response> },
  upload: Presigned
): Promise<CompleteBody> => {
  const res = await r.handle(
    post({ completions: [{ id: upload.id, key: upload.key }], op: "complete" })
  );
  expect(res.status).toBe(200);
  return (await res.json()) as CompleteBody;
};

describe("onUploadComplete — when it fires", () => {
  test("keyless proxy upload: once, in complete, never on the proxy PUT", async () => {
    const { calls, r } = setup({
      onUploadComplete: ({ file }) => ({ id: `row:${file.key}` }),
    });
    const upload = await presign(r);
    expect((await proxyPut(r, upload)).status).toBe(200);
    expect(calls).toHaveLength(0);

    const body = await complete(r, upload);
    expect(calls).toHaveLength(1);
    const [ctx] = calls;
    expect(ctx?.via).toBe("proxy");
    expect(ctx?.file.key).toBe(upload.key);
    expect(ctx?.file.size).toBe(5);
    expect(ctx?.file.contentType).toBe("image/png");
    expect(ctx?.storageKey).toBe(`users/u1/${upload.key}`);
    expect(ctx?.context).toEqual({ userId: "u1" });
    expect(ctx?.req).toBeInstanceOf(Request);
    expect(ctx?.uploadId).toBe(await uploadIdFor(upload.id));
    expect(body.files).toEqual([
      expect.objectContaining({
        data: { id: `row:${upload.key}` },
        key: upload.key,
      }),
    ]);
  });

  test("keyless direct-to-storage upload reports via presign", async () => {
    const adapter = signing();
    const { calls, files, r } = setup({
      adapter,
      onUploadComplete: () => "ok",
    });
    const upload = await presign(r);
    expect(upload.target.url).toContain("fake.local");
    // the browser PUTs straight to storage
    await files.upload(`users/u1/${upload.key}`, "bytes");
    const body = await complete(r, upload);
    expect(calls[0]?.via).toBe("presign");
    expect(calls[0]?.file.etag).toBeString();
    expect(body.files[0]?.data).toBe("ok");
  });

  test("keyed upload fires after the body is stored", async () => {
    const { calls, files, r } = setup({
      onUploadComplete: ({ file, storageKey }) => ({
        key: file.key,
        storageKey,
      }),
    });
    const res = await r.handle(put("op=upload&key=a.txt", "hello"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      file: { key: string; data: unknown };
    };
    expect(body.ok).toBe(true);
    expect(body.file.key).toBe("a.txt");
    expect(body.file.data).toEqual({
      key: "a.txt",
      storageKey: "users/u1/a.txt",
    });
    expect(calls[0]?.via).toBe("keyed");
    expect(calls[0]?.uploadId).toBeString();
    expect(await files.exists("users/u1/a.txt")).toBe(true);
  });

  test("a hook that resolves undefined adds no data field", async () => {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- resolving `undefined` is the case under test
    const { calls, r } = setup({ onUploadComplete: () => undefined });
    const upload = await presign(r);
    await proxyPut(r, upload);
    const body = await complete(r, upload);
    expect(calls).toHaveLength(1);
    expect("data" in (body.files[0] ?? {})).toBe(false);

    const keyed = await r.handle(put("op=upload&key=b.txt", "hi"));
    expect("data" in ((await keyed.json()) as { file: object }).file).toBe(
      false
    );
  });

  test("without a hook the flow is unchanged", async () => {
    const { r } = setup();
    const upload = await presign(r);
    await proxyPut(r, upload);
    const body = await complete(r, upload);
    expect(body.files).toHaveLength(1);
    expect("data" in (body.files[0] ?? {})).toBe(false);
  });

  test("context is undefined when authorize returns none", async () => {
    const { calls, r } = setup({
      authorize: () => {},
      onUploadComplete: () => null,
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    await complete(r, upload);
    expect(calls[0]?.context).toBeUndefined();
    expect(calls[0]?.storageKey).toBe(upload.key);
  });
});

describe("onUploadComplete — rejection", () => {
  test("UploadRejectedError deletes the object and returns a Validation error", async () => {
    const { files, r } = setup({
      onUploadComplete: () => {
        throw new UploadRejectedError("not an image");
      },
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    const body = await complete(r, upload);
    expect(body.files).toEqual([]);
    expect(body.errors).toEqual([
      {
        error: {
          aborted: false,
          code: "Validation",
          message: "not an image",
          timedOut: false,
        },
        key: upload.key,
      },
    ]);
    expect(await files.exists(`users/u1/${upload.key}`)).toBe(false);
  });

  test("a FilesError keeps its code; any other throw reports Provider", async () => {
    const thrown: unknown[] = [
      new FilesError("Conflict", "already recorded"),
      new Error("db down"),
    ];
    const { r } = setup({
      onUploadComplete: () => {
        throw thrown.shift();
      },
    });
    for (const [code, message] of [
      ["Conflict", "already recorded"],
      ["Provider", "db down"],
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one upload per case, in order
      const upload = await presign(r);
      // oxlint-disable-next-line no-await-in-loop -- one upload per case, in order
      await proxyPut(r, upload);
      // oxlint-disable-next-line no-await-in-loop -- one upload per case, in order
      const body = await complete(r, upload);
      expect(body.errors?.[0]?.error).toMatchObject({ code, message });
    }
  });

  test("keyed: rejection deletes the stored body and fails the request", async () => {
    const { files, r } = setup({
      onUploadComplete: () => {
        throw new UploadRejectedError("quota exceeded");
      },
    });
    const res = await r.handle(put("op=upload&key=big.bin", "hello"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      error: {
        code: "Validation",
        message: "quota exceeded",
        reason: "rejected",
      },
    });
    expect(await files.exists("users/u1/big.bin")).toBe(false);
  });

  test("onRejected: keep leaves the object in place", async () => {
    const { files, r } = setup({
      onRejected: "keep",
      onUploadComplete: () => {
        throw new UploadRejectedError("no");
      },
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    await complete(r, upload);
    expect(await files.exists(`users/u1/${upload.key}`)).toBe(true);
    const res = await r.handle(put("op=upload&key=k.txt", "x"));
    expect(res.status).toBe(422);
    expect(await files.exists("users/u1/k.txt")).toBe(true);
  });

  test("a failing cleanup delete doesn't mask the rejection", async () => {
    const adapter = memory();
    const flaky: Adapter = {
      ...adapter,
      delete: () => Promise.reject(new Error("delete failed")),
    };
    const { r } = setup({
      adapter: flaky,
      onUploadComplete: () => {
        throw new UploadRejectedError("nope");
      },
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    const body = await complete(r, upload);
    // The rejection stays the error; the failed cleanup is reported with it.
    expect(body.errors?.[0]?.error.message).toBe(
      "nope (removing it failed: delete failed)"
    );
  });
});

describe("complete-time maxSize check", () => {
  const oversized = async (onRejected?: "keep") => {
    const { calls, files, r } = setup({
      maxUploadSize: 3,
      onUploadComplete: () => "never",
      ...(onRejected && { onRejected }),
    });
    // A client that declares a small size, then stores more than it said
    // (bypassing the proxy's streaming limit, as a direct-to-storage PUT could).
    const upload = await presign(r, "photo.png", 1);
    await files.upload(`users/u1/${upload.key}`, "0123456789");
    const body = await complete(r, upload);
    return { body, calls, exists: files.exists(`users/u1/${upload.key}`) };
  };

  test("deletes the oversized object and skips the hook", async () => {
    const { body, calls, exists } = await oversized();
    expect(body.errors?.[0]?.error.message).toContain("exceeds maxSize");
    expect(calls).toHaveLength(0);
    expect(await exists).toBe(false);
  });

  test("keeps it under onRejected: keep", async () => {
    const { exists } = await oversized("keep");
    expect(await exists).toBe(true);
  });
});

describe("completion replay", () => {
  test("a replayed complete fires again with the same uploadId", async () => {
    let n = 0;
    const { calls, r } = setup({
      onUploadComplete: () => {
        n += 1;
        return n;
      },
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    const a = await complete(r, upload);
    const b = await complete(r, upload);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.uploadId).toBe(calls[1]?.uploadId as string);
    expect([a.files[0]?.data, b.files[0]?.data]).toEqual([1, 2]);
  });

  test("a completions store makes them single-use", async () => {
    const store = new Map<string, CompletionRecord>();
    const ttls: number[] = [];
    let n = 0;
    const { calls, r } = setup({
      completions: {
        get: (id) => store.get(id),
        set: (id, record, ttl) => {
          ttls.push(ttl);
          store.set(id, record);
        },
      },
      defaultExpiresIn: 60,
      onUploadComplete: () => {
        n += 1;
        return { row: n };
      },
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    const a = await complete(r, upload);
    const b = await complete(r, upload);
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
    expect(a.files[0]?.data).toEqual({ row: 1 });
    // remembered until the token expires (presigned at NOW for 60s)
    expect(ttls).toEqual([60_000]);
  });

  test("a rejected upload isn't recorded", async () => {
    const store = new Map<string, CompletionRecord>();
    const { r } = setup({
      completions: {
        get: (id) => store.get(id),
        set: (id, record) => {
          store.set(id, record);
        },
      },
      onUploadComplete: () => {
        throw new UploadRejectedError("no");
      },
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    await complete(r, upload);
    expect(store.size).toBe(0);
  });

  test("a store failure is reported for that completion", async () => {
    const { r } = setup({
      completions: {
        get: () => Promise.reject(new Error("kv down")),
        set: () => {},
      },
      onUploadComplete: () => "x",
    });
    const upload = await presign(r);
    await proxyPut(r, upload);
    const body = await complete(r, upload);
    expect(body.files).toEqual([]);
    expect(body.errors?.[0]?.error).toMatchObject({
      code: "Provider",
      message: "kv down",
    });
  });

  test("uploadIdFor is stable per token and distinct across tokens", async () => {
    const a = await uploadIdFor("token-a");
    expect(a).toBe(await uploadIdFor("token-a"));
    expect(a).not.toBe(await uploadIdFor("token-b"));
    expect(a).toMatch(/^[\w-]{22}$/u);
  });
});

describe("client data round-trip", () => {
  const wire = (r: { handle: (req: Request) => Promise<Response> }) => {
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      r.handle(new Request(input, init))) as typeof fetch;
    const transport: Transport = async (req: SendRequest) => {
      const res = await r.handle(
        new Request(req.url, {
          body: req.body as Blob | null,
          headers: req.headers,
          method: req.method,
        })
      );
      return { status: res.status, text: await res.text() };
    };
    return { endpoint: ENDPOINT, fetchImpl, transport };
  };

  test("keyless, keyed and bulk uploads carry data", async () => {
    const files = createFiles({ adapter: memory() });
    const router = createFilesRouter({
      allowedOrigins: () => true,
      files,
      onUploadComplete: ({ file, via }) => ({ key: file.key, via }),
      operations: ["upload"],
      secret: "s",
    });
    const client = createFilesClient<InferUploadData<typeof router>>(
      wire(router)
    );
    const states: { status: string; data?: unknown }[] = [];
    const keyless = await client.upload(new File(["hi"], "a.txt"), {
      onProgress: (_p, perFile) => {
        states.push({ ...perFile[0], status: perFile[0]?.status ?? "" });
      },
    });
    expect(keyless.data).toEqual({ key: keyless.key, via: "proxy" });
    expect(states.at(-1)?.data).toEqual(keyless.data);

    const keyed = await client.upload("b.txt", "hello");
    expect(keyed.data).toEqual({ key: "b.txt", via: "keyed" });

    const bulk = await client.upload([{ body: "c", key: "c.txt" }]);
    expect(bulk.results[0]?.data).toEqual({ key: "c.txt", via: "keyed" });
  });

  test("a rejection surfaces as the upload's error", async () => {
    const router = createFilesRouter({
      allowedOrigins: () => true,
      files: createFiles({ adapter: memory() }),
      onUploadComplete: () => {
        throw new UploadRejectedError("blocked type");
      },
      operations: ["upload"],
      secret: "s",
    });
    const client = createFilesClient(wire(router));
    const keyless = client.upload(new File(["hi"], "a.exe"));
    await expect(keyless).rejects.toThrow("blocked type");
    await expect(client.upload("k.exe", "x")).rejects.toThrow("blocked type");
  });

  test("InferUploadData reads the hook's resolved type", () => {
    const router = createFilesRouter({
      files: createFiles({ adapter: memory() }),
      onUploadComplete: () => Promise.resolve({ id: "x" }),
      operations: ["upload"],
      secret: "s",
    });
    const data: InferUploadData<typeof router> = { id: "x" };
    // @ts-expect-error — `id` is a string
    const wrong: InferUploadData<typeof router> = { id: 1 };
    expect([data, wrong]).toHaveLength(2);
  });

  test("authorize's context type flows into the hook", async () => {
    const seen: unknown[] = [];
    const router = createFilesRouter({
      allowedOrigins: () => true,
      authorize: () => ({ context: { userId: "u9" } }),
      files: createFiles({ adapter: memory() }),
      onUploadComplete: ({ context }) => {
        const userId: string | undefined = context?.userId;
        // @ts-expect-error — the context has no `tenant`
        seen.push(userId ?? "", context?.tenant);
      },
      secret: "s",
    });
    await router.handle(put("op=upload&key=a.txt", "x"));
    expect(seen).toEqual(["u9", undefined]);
  });
});
