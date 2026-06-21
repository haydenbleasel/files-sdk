// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited Responses is the natural shape here.
import { describe, expect, test } from "bun:test";

import { createFilesRouter } from "../src/api/index.js";
import type {
  Authorize,
  CreateFilesRouterOptions,
  FilesOperation,
} from "../src/api/index.js";
import type { Files } from "../src/index.js";
import { createFiles } from "../src/index.js";
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
  for (const key of keys) {
    await files.upload(key, key);
    // A soft-delete relocates the object into the trash prefix.
    await files.delete(key);
  }
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

  test("versions 422s when versioning isn't configured", async () => {
    const r = router(createFiles({ adapter: memory() }), ["versions"]);
    const res = await r.handle(post({ key: "x", op: "versions" }));
    expect(res.status).toBe(422);
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
});
