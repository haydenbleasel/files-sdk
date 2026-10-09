// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import type {
  Authorize,
  CreateFilesRouterOptions,
  FilesOperation,
} from "../src/api/index.js";
import type { Adapter, FileInfo, Files, FilesPlugin } from "../src/index.js";
import { createFiles } from "../src/index.js";
import {
  isReservedKey,
  reserveKeyPrefix,
  reservedKeyPrefixes,
} from "../src/internal/files-router/reserved.js";
import { memory } from "../src/memory/index.js";
import { softDelete } from "../src/soft-delete/index.js";
import { versioning } from "../src/versioning/index.js";

const ENDPOINT = "https://app.test/api/files";
const SECRET = "plugins-secret";

const router = (
  files: Files,
  operations: FilesOperation[],
  authorize?: Authorize
) =>
  createFilesRouter({
    allowedOrigins: () => true,
    authorize,
    files,
    operations,
    secret: SECRET,
  } satisfies CreateFilesRouterOptions);

const post = (body: unknown) =>
  new Request(ENDPOINT, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const readJson = <T>(res: Response): Promise<T> => res.json() as Promise<T>;

const seedVersioned = async () => {
  const files = createFiles({ adapter: memory(), plugins: [versioning()] });
  await files.upload("notes.txt", "v1");
  // The second upload snapshots "v1" first.
  await files.upload("notes.txt", "v2");
  return files;
};

const seedTrashed = async (keys: string[]) => {
  const files = createFiles({ adapter: memory(), plugins: [softDelete()] });
  await Promise.all(
    keys.map(async (key) => {
      await files.upload(key, key);
      // A soft-delete relocates the object into the trash prefix.
      await files.delete(key);
    })
  );
  return files;
};

describe("gateway — versioning ops", () => {
  test("versions lists saved snapshots, newest first", async () => {
    const files = await seedVersioned();
    const r = router(files, ["versions"]);
    const res = await r.handle(post({ key: "notes.txt", op: "versions" }));
    expect(res.status).toBe(200);
    const body = await readJson<{
      versions: { versionId: string; size: number; lastModified: number }[];
    }>(res);
    expect(body.versions.length).toBe(1);
    expect(body.versions[0]?.versionId).toBeTruthy();
    expect(body.versions[0]?.size).toBe(2);
  });

  test("restore-version rolls back, with and without an explicit id", async () => {
    const files = await seedVersioned();
    const r = router(files, ["versions", "restoreVersion"]);
    const list = await readJson<{ versions: { versionId: string }[] }>(
      await r.handle(post({ key: "notes.txt", op: "versions" }))
    );
    const { versionId } = list.versions[0] as { versionId: string };

    const byId = await r.handle(
      post({ key: "notes.txt", op: "restore-version", versionId })
    );
    expect(byId.status).toBe(200);
    expect((await readJson<{ file: { key: string } }>(byId)).file.key).toBe(
      "notes.txt"
    );
    expect(await files.download("notes.txt").then((f) => f.text())).toBe("v1");

    const newest = await r.handle(
      post({ key: "notes.txt", op: "restore-version" })
    );
    expect(newest.status).toBe(200);
  });

  test("versions 422s (Unsupported, reason capability) when versioning isn't configured", async () => {
    const r = router(createFiles({ adapter: memory() }), ["versions"]);
    const res = await r.handle(post({ key: "x", op: "versions" }));
    expect(res.status).toBe(422);
    expect(
      (await readJson<{ error: { code: string; reason: string } }>(res)).error
    ).toMatchObject({ code: "Unsupported", reason: "capability" });
  });

  test("restore-version 422s on a softDelete-only instance", async () => {
    const files = createFiles({ adapter: memory(), plugins: [softDelete()] });
    const r = router(files, ["restoreVersion"]);
    const res = await r.handle(post({ key: "x", op: "restore-version" }));
    expect(res.status).toBe(422);
  });

  test("versions is denied without an allow-list entry", async () => {
    const files = await seedVersioned();
    const r = router(files, ["head"]);
    expect(
      (await r.handle(post({ key: "notes.txt", op: "versions" }))).status
    ).toBe(403);
  });

  test("versions scopes the key under an authorize keyPrefix", async () => {
    const files = createFiles({ adapter: memory(), plugins: [versioning()] });
    await files.upload("tenant/notes.txt", "a");
    await files.upload("tenant/notes.txt", "b");
    const r = router(files, ["versions"], () => ({ keyPrefix: "tenant" }));
    const body = await readJson<{ versions: unknown[] }>(
      await r.handle(post({ key: "notes.txt", op: "versions" }))
    );
    expect(body.versions.length).toBe(1);
  });
});

describe("gateway — softDelete ops", () => {
  test("trashed lists deleted objects by original key", async () => {
    const files = await seedTrashed(["a.txt"]);
    const r = router(files, ["trashed"]);
    const res = await r.handle(post({ op: "trashed" }));
    expect(res.status).toBe(200);
    const body = await readJson<{ trashed: { key: string; size: number }[] }>(
      res
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["a.txt"]);
  });

  test("restore-trashed brings a key back", async () => {
    const files = await seedTrashed(["a.txt"]);
    const r = router(files, ["restoreTrashed", "trashed"]);
    const res = await r.handle(post({ key: "a.txt", op: "restore-trashed" }));
    expect(res.status).toBe(200);
    expect((await readJson<{ file: { key: string } }>(res)).file.key).toBe(
      "a.txt"
    );
    const after = await readJson<{ trashed: unknown[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(after.trashed.length).toBe(0);
  });

  test("purge with a key permanently removes one entry", async () => {
    const files = await seedTrashed(["a.txt", "b.txt"]);
    const r = router(files, ["purge", "trashed"]);
    expect((await r.handle(post({ key: "a.txt", op: "purge" }))).status).toBe(
      200
    );
    const after = await readJson<{ trashed: { key: string }[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(after.trashed.map((t) => t.key)).toEqual(["b.txt"]);
  });

  test("purge with no key empties the whole trash", async () => {
    const files = await seedTrashed(["a.txt", "b.txt"]);
    const r = router(files, ["purge", "trashed"]);
    expect((await r.handle(post({ op: "purge" }))).status).toBe(200);
    const after = await readJson<{ trashed: unknown[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(after.trashed.length).toBe(0);
  });

  test("trashed 422s when softDelete isn't configured", async () => {
    const r = router(createFiles({ adapter: memory() }), ["trashed"]);
    expect((await r.handle(post({ op: "trashed" }))).status).toBe(422);
  });

  test("restore-trashed 422s on a versioning-only instance", async () => {
    const files = createFiles({ adapter: memory(), plugins: [versioning()] });
    const r = router(files, ["restoreTrashed"]);
    expect(
      (await r.handle(post({ key: "x", op: "restore-trashed" }))).status
    ).toBe(422);
  });

  test("purge 422s when softDelete isn't configured", async () => {
    const r = router(createFiles({ adapter: memory() }), ["purge"]);
    expect((await r.handle(post({ op: "purge" }))).status).toBe(422);
  });

  test("trashed hides other tenants under a keyPrefix scope", async () => {
    const files = await seedTrashed(["tenant/a.txt", "other/b.txt"]);
    const r = router(files, ["trashed"], () => ({ keyPrefix: "tenant" }));
    const body = await readJson<{ trashed: { key: string }[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["a.txt"]);
  });

  test("trashed honors a bulk filterKeys", async () => {
    const files = await seedTrashed(["a.txt", "c.txt"]);
    const r = router(files, ["trashed"], () => ({
      filterKeys: (key) => key !== "a.txt",
    }));
    const body = await readJson<{ trashed: { key: string }[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["c.txt"]);
  });

  test("scoped purge-all only empties the caller's own trash", async () => {
    const files = await seedTrashed(["tenant/a.txt", "other/b.txt"]);
    const r = router(files, ["purge"], () => ({ keyPrefix: "tenant" }));
    expect((await r.handle(post({ op: "purge" }))).status).toBe(200);
    // "other/b.txt" is still trashed — listed by an unscoped router.
    const unscoped = router(files, ["trashed"]);
    const body = await readJson<{ trashed: { key: string }[] }>(
      await unscoped.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["other/b.txt"]);
  });

  test("purge with a key rejects entries hidden by filterKeys", async () => {
    const files = await seedTrashed(["a.txt", "c.txt"]);
    const r = router(files, ["purge", "trashed"], () => ({
      filterKeys: (key) => key !== "a.txt",
    }));
    expect((await r.handle(post({ key: "a.txt", op: "purge" }))).status).toBe(
      403
    );

    const unscoped = router(files, ["trashed"]);
    const body = await readJson<{ trashed: { key: string }[] }>(
      await unscoped.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key).toSorted()).toEqual([
      "a.txt",
      "c.txt",
    ]);
  });

  test("scoped purge-all honors filterKeys", async () => {
    const files = await seedTrashed(["tenant/a.txt", "tenant/c.txt"]);
    const r = router(files, ["purge", "trashed"], () => ({
      filterKeys: (key) => key !== "a.txt",
      keyPrefix: "tenant",
    }));
    expect((await r.handle(post({ op: "purge" }))).status).toBe(200);

    const unscoped = router(files, ["trashed"]);
    const body = await readJson<{ trashed: { key: string }[] }>(
      await unscoped.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["tenant/a.txt"]);
  });

  test("purge-all under filterKeys alone (no keyPrefix) keeps hidden entries", async () => {
    const files = await seedTrashed(["a.txt", "b.txt", "c.txt"]);
    const r = router(files, ["purge", "trashed"], () => ({
      filterKeys: (key) => key !== "a.txt",
    }));
    expect((await r.handle(post({ op: "purge" }))).status).toBe(200);

    const unscoped = router(files, ["trashed"]);
    const body = await readJson<{ trashed: { key: string }[] }>(
      await unscoped.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["a.txt"]);
  });
});

interface ErrorBody {
  error: { code: string; reason?: string; message: string };
}

const status = async (
  r: ReturnType<typeof router>,
  body: unknown
): Promise<number> => (await r.handle(post(body))).status;

const seedBoth = async () => {
  const files = createFiles({
    adapter: memory(),
    plugins: [versioning({ ignore: [".trash"] }), softDelete()],
  });
  await files.upload("notes.txt", "v1");
  await files.upload("notes.txt", "v2");
  await files.delete("notes.txt");
  return files;
};

describe("gateway — plugin storage is off-limits to core verbs", () => {
  const CORE: FilesOperation[] = [
    "head",
    "exists",
    "delete",
    "copy",
    "move",
    "url",
    "list",
    "search",
    "download",
    "upload",
    "signedUploadUrl",
    "trashed",
    "versions",
  ];

  test("no key or prefix inside .trash / .versions reaches storage", async () => {
    const files = await seedBoth();
    // Allows delete but not purge: a hard delete of the trashed copy must not
    // sneak past the purge gate.
    const r = router(files, CORE);
    const [version] = await files.versions("notes.txt");
    const versionKey = version?.key ?? "";
    expect(versionKey.startsWith(".versions/")).toBe(true);

    const refused = [
      { key: ".trash/notes.txt", op: "delete" },
      { key: ".trash/notes.txt", op: "head" },
      { key: versionKey, op: "exists" },
      { keys: ["ok.txt", versionKey], op: "delete-many" },
      { keys: [".trash/notes.txt"], op: "head-many" },
      { keys: [".trash"], op: "exists-many" },
      { from: "a.txt", op: "copy", to: `.versions/notes.txt/forged` },
      { from: ".trash/notes.txt", op: "move", to: "stolen.txt" },
      { key: versionKey, op: "url" },
      { op: "list", prefix: ".versions/" },
      { op: "list", prefix: ".versions" },
      { op: "list", prefix: ".trash/" },
      { op: "search", pattern: "*", prefix: ".trash/" },
      { expiresIn: 60, key: ".versions/x", op: "signed-upload-url" },
    ];
    for (const body of refused) {
      // oxlint-disable-next-line no-await-in-loop -- one request per case, in order
      const res = await r.handle(post(body));
      expect(res.status).toBe(403);
      // oxlint-disable-next-line no-await-in-loop -- one request per case, in order
      expect((await readJson<ErrorBody>(res)).error).toMatchObject({
        code: "Forbidden",
        reason: "forbidden",
      });
    }
    const download = await r.handle(
      new Request(
        `${ENDPOINT}?op=download&key=${encodeURIComponent(versionKey)}`
      )
    );
    expect(download.status).toBe(403);
    const forged = await r.handle(
      new Request(`${ENDPOINT}?op=upload&key=.versions/notes.txt/9`, {
        body: "forged",
        method: "PUT",
      })
    );
    expect(forged.status).toBe(403);

    // Nothing moved: the trashed copy and the history are intact.
    expect((await files.trashed()).map((t) => t.key)).toEqual(["notes.txt"]);
    expect(await files.versions("notes.txt")).toHaveLength(2);
  });

  test("a glob head that walks into plugin storage matches nothing there", async () => {
    const files = await seedBoth();
    const r = router(files, ["search"]);
    for (const pattern of [".versions/**", ".trash/*", "**"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request per case, in order
      const body = await readJson<{ matches: { key: string }[] }>(
        // oxlint-disable-next-line no-await-in-loop -- one request per case, in order
        await r.handle(post({ op: "search", pattern }))
      );
      expect(body.matches).toEqual([]);
    }
  });

  test("a tenant's own folders named like the plugin prefixes stay usable", async () => {
    const files = await seedBoth();
    const r = router(files, ["upload", "list", "delete"], () => ({
      keyPrefix: "users/u1/",
    }));
    const res = await r.handle(
      new Request(`${ENDPOINT}?op=upload&key=.trash/mine.txt`, {
        body: "mine",
        method: "PUT",
      })
    );
    expect(res.status).toBe(200);
    expect(await files.exists("users/u1/.trash/mine.txt")).toBe(true);
    expect(await status(r, { op: "list", prefix: ".trash/" })).toBe(200);
  });

  test("a keyPrefix inside plugin storage can't mint upload keys there", async () => {
    const files = await seedBoth();
    const r = router(files, ["upload"], () => ({ keyPrefix: ".versions" }));
    const res = await r.handle(
      post({
        files: [{ name: "a.txt", size: 1, type: "text/plain" }],
        op: "presign",
      })
    );
    expect(res.status).toBe(403);
  });

  test("the reservation follows the plugins onto a readonly() view", async () => {
    const files = await seedBoth();
    const r = router(files.readonly(), ["head", "list"]);
    expect(await status(r, { key: ".trash/notes.txt", op: "head" })).toBe(403);
    expect(reservedKeyPrefixes(files.readonly()).toSorted()).toEqual([
      ".trash",
      ".versions",
    ]);
  });

  test("custom prefixes are what get reserved", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [
        versioning({ prefix: "/_history/" }),
        softDelete({ prefix: "_bin" }),
      ],
    });
    expect(reservedKeyPrefixes(files).toSorted()).toEqual(["_bin", "_history"]);
    const r = router(files, ["head"]);
    expect(await status(r, { key: "_bin/a", op: "head" })).toBe(403);
    // `.trash` is an ordinary key on this instance.
    expect(await status(r, { key: ".trash/a", op: "head" })).toBe(404);
  });

  test("reservedKeyPrefixes ignores foreign symbols and non-string markers", () => {
    const target = createFiles({ adapter: memory() });
    for (const [symbol, value] of [
      [Symbol.for("files-sdk.reservedKeyPrefix:weird"), 42],
      [Symbol.for("something-else"), ".nope"],
      [Symbol("files-sdk.reservedKeyPrefix:local"), ".local"],
    ] as const) {
      Object.defineProperty(target, symbol, { value });
    }
    reserveKeyPrefix(target, "blank", "");
    reserveKeyPrefix(target, "kept", ".kept");
    expect(reservedKeyPrefixes(target)).toEqual([".kept"]);
    expect(isReservedKey(".kept", [".kept"])).toBe(true);
    expect(isReservedKey(".kept/a", [".kept"])).toBe(true);
    expect(isReservedKey(".kepta", [".kept"])).toBe(false);
  });
});

describe("gateway — filterKeys on the single-key plugin verbs", () => {
  test("versions, restore-version and restore-trashed refuse a hidden key", async () => {
    const files = createFiles({
      adapter: memory(),
      plugins: [versioning({ ignore: [".trash"] }), softDelete()],
    });
    await files.upload("secret.txt", "v1");
    await files.upload("secret.txt", "v2");
    await files.delete("secret.txt");
    const r = router(
      files,
      ["versions", "restoreVersion", "restoreTrashed"],
      () => ({ filterKeys: (key) => key !== "secret.txt" })
    );
    for (const op of ["versions", "restore-version", "restore-trashed"]) {
      // oxlint-disable-next-line no-await-in-loop -- one request per case, in order
      const res = await r.handle(post({ key: "secret.txt", op }));
      expect(res.status).toBe(403);
    }
    expect(await files.exists("secret.txt")).toBe(false);
    // A visible key still works.
    await files.upload("open.txt", "a");
    await files.upload("open.txt", "b");
    expect(await status(r, { key: "open.txt", op: "versions" })).toBe(200);
  });
});

describe("gateway — trash ops read only the caller's trash", () => {
  test("trashed and scoped purge list under the tenant's trash prefix", async () => {
    const prefixes: (string | undefined)[] = [];
    const base = memory();
    const adapter: Adapter = {
      ...base,
      list: (opts) => {
        prefixes.push(opts?.prefix);
        return base.list(opts);
      },
    };
    const files = createFiles({ adapter, plugins: [softDelete()] });
    for (const key of ["tenant/a.txt", "other/b.txt"]) {
      // oxlint-disable-next-line no-await-in-loop -- seed in order
      await files.upload(key, key);
      // oxlint-disable-next-line no-await-in-loop -- seed in order
      await files.delete(key);
    }
    const r = router(files, ["trashed", "purge"], () => ({
      keyPrefix: "tenant",
    }));
    prefixes.length = 0;
    const body = await readJson<{ trashed: { key: string }[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["a.txt"]);
    expect(await status(r, { op: "purge" })).toBe(200);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(prefix?.startsWith(".trash/tenant/")).toBe(true);
    }
    expect((await files.trashed()).map((t) => t.key)).toEqual(["other/b.txt"]);
  });

  test("a trash plugin that ignores the prefix is still filtered per tenant", async () => {
    const purged: (string | undefined)[] = [];
    const entries = [
      { key: "tenant/a.txt", size: 1 },
      { key: "other/b.txt", size: 1 },
    ];
    const legacyTrash: FilesPlugin<{
      trashed: () => Promise<{ key: string; size: number }[]>;
      purge: (key?: string) => Promise<void>;
      restoreTrashed: (key: string) => Promise<FileInfo>;
    }> = {
      extend: () => ({
        purge: (key) => {
          purged.push(key);
          return Promise.resolve();
        },
        restoreTrashed: () => Promise.reject(new Error("unused")),
        trashed: () => Promise.resolve(entries),
      }),
      name: "legacy-trash",
    };
    const files = createFiles({ adapter: memory(), plugins: [legacyTrash] });
    const r = router(files, ["trashed", "purge"], () => ({
      keyPrefix: "tenant",
    }));
    const body = await readJson<{ trashed: { key: string }[] }>(
      await r.handle(post({ op: "trashed" }))
    );
    expect(body.trashed.map((t) => t.key)).toEqual(["a.txt"]);
    expect(await status(r, { op: "purge" })).toBe(200);
    expect(purged).toEqual(["tenant/a.txt"]);
  });
});
