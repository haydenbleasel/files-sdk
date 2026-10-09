// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited Responses is the natural shape here.
// Phase 3 formats — B2, Tigris, Supabase, Cloudinary, Appwrite, Box, and SNS
// over HTTPS — against payloads and signature vectors captured from each
// provider's docs and SDK test suites (test/fixtures/events/*/SOURCES.md).
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { digest, toHex, utf8 } from "../src/events/crypto.js";
import { cloudinaryParser } from "../src/events/formats/cloudinary.js";
import type {
  EventsOptions,
  EventsWebhookOptions,
} from "../src/events/index.js";
import { events } from "../src/events/index.js";
import { snsVerifier, snsUrl, stringToSign } from "../src/events/sns.js";
import { pemToDer, spkiOf } from "../src/events/x509.js";
import type { Adapter, FileEvent } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";

const FIXTURES = path.join(import.meta.dir, "fixtures", "events");
const text = (name: string): string =>
  readFileSync(path.join(FIXTURES, name), "utf-8");
const json = (name: string): Record<string, unknown> =>
  JSON.parse(text(name)) as Record<string, unknown>;
const jsonAs = <T>(name: string): T => JSON.parse(text(name)) as T;

const URL_ = "https://example.com/webhook";

const filesAs = (
  adapter: Partial<Adapter> & { name: string } & Record<string, unknown>,
  opts: EventsOptions = {}
) =>
  createFiles({
    adapter: { ...memory(), ...adapter } as Adapter,
    plugins: [events(opts)],
  });

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request(URL_, { body, headers, method: "POST" });

const hookFor = (
  name: string,
  verify: EventsWebhookOptions["verify"],
  extra: Record<string, unknown> = {}
) => {
  const files = filesAs({ name, ...extra });
  const seen: FileEvent[] = [];
  files.events.on("*", (e) => {
    seen.push(e);
  });
  return { hook: files.events.webhook({ verify }), seen };
};

afterEach(() => {
  mock.restore();
});

describe("b2", () => {
  const signing = jsonAs<{ secret: string; wrongSecret: string }>(
    "b2/signed-upload.signing.json"
  );
  const body = text("b2/signed-upload.body");
  const headers = jsonAs<Record<string, string>>(
    "b2/signed-upload.headers.json"
  );

  test("a signed delivery verifies and parses", async () => {
    const { hook, seen } = hookFor("backblaze-b2", { secret: signing.secret });
    const res = await hook.handle(post(body, headers));
    expect(res.status).toBe(200);
    expect(seen).toEqual([
      expect.objectContaining({
        id: "eventId",
        key: "objectName.txt",
        provider: "backblaze-b2",
        size: 10_495_842,
        time: 1_684_793_309_123,
        type: "created",
      }),
    ]);
  });

  test("a wrong secret, a missing header, or another version is a 401", async () => {
    const { hook } = hookFor("backblaze-b2", { secret: signing.wrongSecret });
    expect((await hook.handle(post(body, headers))).status).toBe(401);
    const right = hookFor("backblaze-b2", { secret: signing.secret }).hook;
    expect((await right.handle(post(body))).status).toBe(401);
    const v2 = (headers["x-bz-event-notification-signature"] ?? "").replace(
      "v1=",
      "v2="
    );
    expect(
      (
        await right.handle(
          post(body, { "x-bz-event-notification-signature": `v0=x, ${v2}` })
        )
      ).status
    ).toBe(401);
  });

  test("a list of signatures passes when one matches", async () => {
    const { hook } = hookFor("backblaze-b2", { secret: signing.secret });
    const res = await hook.handle(
      post(body, {
        "x-bz-event-notification-signature": `v1=deadbeef, ${headers["x-bz-event-notification-signature"]}`,
      })
    );
    expect(res.status).toBe(200);
  });

  test("deletes and hide markers are deletes; tests and unknowns are skipped", async () => {
    const files = filesAs({ name: "backblaze-b2" });
    const [deleted] = await files.events.parse(json("b2/delete.derived.json"));
    expect(deleted).toMatchObject({ type: "deleted" });
    expect(deleted?.size).toBeUndefined();
    const [hidden] = await files.events.parse(
      json("b2/hide-marker.derived.json")
    );
    expect(hidden).toMatchObject({ key: "objectName.txt", type: "deleted" });
    expect(await files.events.parse(json("b2/test-event.json"))).toEqual([]);
    expect(
      (await files.events.parse(json("b2/captured-upload.json")))[0]?.key
    ).toBe("images/raw/smiley.png");
    const [one] = jsonAs<{ events: Record<string, unknown>[] }>(
      "b2/upload.json"
    ).events;
    expect(await files.events.parse(one)).toHaveLength(1);
    expect(
      await files.events.parse({
        eventType: "b2:MultipartUploadCreated:LiveRead",
        eventVersion: 1,
        objectName: "x",
      })
    ).toEqual([]);
    expect(
      (
        await files.events.parse({
          eventType: "b2:ObjectCreated:Copy",
          eventVersion: 1,
          objectName: "x",
        })
      )[0]?.id
    ).toStartWith("b2:ObjectCreated:Copy:x@");
  });

  test("malformed deliveries throw", async () => {
    const files = filesAs({ name: "backblaze-b2" });
    await expect(files.events.parse({ nope: 1 })).rejects.toThrow(
      "expected events[]"
    );
    await expect(files.events.parse({ events: [1] })).rejects.toThrow(
      "expected an event object"
    );
    await expect(files.events.parse({ events: [{}] })).rejects.toThrow(
      "event without eventType"
    );
    await expect(
      files.events.parse({ events: [{ eventType: "b2:ObjectCreated:Upload" }] })
    ).rejects.toThrow("event without objectName");
  });
});

describe("tigris", () => {
  test("created and deleted from one delivery, authenticated by token", async () => {
    const { hook, seen } = hookFor("tigris", {
      token: "PLACEHOLDER-webhook-token",
    });
    const res = await hook.handle(
      post(
        text("tigris/notification.json"),
        jsonAs<Record<string, string>>("tigris/notification.headers.json")
      )
    );
    expect(res.status).toBe(200);
    expect(
      seen.map(({ etag, key, size, type }) => ({ etag, key, size, type }))
    ).toEqual([
      {
        etag: "d41d8cd98f00b204e9800998ecf8427e",
        key: "path/to/myfile.txt",
        size: 1024,
        type: "created",
      },
      {
        etag: "c4ca4238a0b923820dcc509a6f75849b",
        key: "path/to/anotherfile.jpg",
        size: undefined,
        type: "deleted",
      },
    ]);
  });

  test("Tigris has no signature, so verify: { secret } is refused", () => {
    expect(() => hookFor("tigris", { secret: "s" })).toThrow(
      "carry no signature"
    );
  });

  test("renames and transitions are skipped; one bare event parses", async () => {
    const files = filesAs({ name: "tigris" });
    const event = {
      bucket: "b",
      eventName: "OBJECT_RENAME",
      eventSource: "tigris",
      object: { key: "k" },
    };
    expect(await files.events.parse(event)).toEqual([]);
    expect(
      await files.events.parse({ ...event, eventName: "OBJECT_CREATED_COPY" })
    ).toHaveLength(1);
    await expect(files.events.parse({ x: 1 })).rejects.toThrow(
      "expected events[]"
    );
    await expect(files.events.parse({ events: [1] })).rejects.toThrow(
      "expected an event object"
    );
    await expect(files.events.parse({ events: [{}] })).rejects.toThrow(
      "without eventName"
    );
  });
});

describe("supabase", () => {
  const parse = (body: unknown) =>
    filesAs({ name: "supabase" }).events.parse(body);

  test("INSERT, DELETE, and an overwrite UPDATE", async () => {
    const [inserted] = await parse(json("supabase/insert.json"));
    expect(inserted).toMatchObject({
      contentType: "image/png",
      etag: "ca390059ef9fdb91e2ad5447201d2e91",
      id: "INSERT:e281a32a-6998-4ed1-b8e0-7d3d7ae9ae3c:151d16d2-0319-4e5b-add4-53820e8a0863",
      key: "folder/avatar1.png",
      size: 343_017,
      type: "created",
    });
    const [removed] = await parse(json("supabase/delete.json"));
    expect(removed).toMatchObject({
      key: "folder/avatar1.png",
      type: "deleted",
    });
    const [overwritten] = await parse(
      json("supabase/update-overwrite.derived.json")
    );
    expect(overwritten).toMatchObject({ size: 343_017, type: "created" });
  });

  test("a move is a delete and a create; bookkeeping updates are skipped", async () => {
    const update = jsonAs<{
      record: Record<string, unknown>;
      old_record: Record<string, unknown>;
    }>("supabase/update-overwrite.derived.json");
    const moved = await parse({
      ...update,
      old_record: { ...update.record, name: "old/name.png" },
    });
    expect(moved.map(({ key, type }) => `${type}:${key}`)).toEqual([
      "deleted:old/name.png",
      "created:folder/avatar1.png",
    ]);
    expect(
      await parse({ ...update, old_record: { ...update.record } })
    ).toEqual([]);
  });

  test("other tables are skipped; broken changes throw", async () => {
    expect(
      await parse({ ...json("supabase/insert.json"), table: "profiles" })
    ).toEqual([]);
    await expect(
      parse({ ...json("supabase/insert.json"), type: "TRUNCATE" })
    ).rejects.toThrow("unknown change type");
    await expect(
      parse({ ...json("supabase/insert.json"), record: null })
    ).rejects.toThrow("without the storage.objects row");
    await expect(
      parse({ ...json("supabase/delete.json"), old_record: null })
    ).rejects.toThrow("without the storage.objects row");
    await expect(
      parse({ ...json("supabase/update-overwrite.derived.json"), record: 4 })
    ).rejects.toThrow("without the storage.objects row");
  });

  test("a row with no id, version or metadata still parses", async () => {
    const [event] = await parse({
      record: { name: "a.txt" },
      schema: "storage",
      table: "objects",
      type: "INSERT",
    });
    expect(event).toMatchObject({ id: "INSERT:a.txt:", key: "a.txt" });
  });
});

describe("cloudinary", () => {
  const SECRET = "shhh";
  const NOW = 1_719_310_887_000;
  const sign = async (
    body: string,
    timestamp: string,
    hash: "SHA-1" | "SHA-256"
  ) => toHex(await digest(hash, utf8(`${body}${timestamp}${SECRET}`)));

  test("the documented SHA-1 vector and the SDK's SHA-256 vector verify", async () => {
    const signing = jsonAs<{
      docVector: {
        body: string;
        timestamp: string;
        apiSecret: string;
        sha1: string;
      };
      sdkSha256Vector: { timestamp: string; apiSecret: string; sha256: string };
    }>("cloudinary/signing.json");
    const { docVector, sdkSha256Vector } = signing;
    const verify = cloudinaryParser.verifySignature;
    await expect(
      verify?.({
        body: docVector.body,
        headers: new Headers({
          "x-cld-signature": docVector.sha1,
          "x-cld-timestamp": docVector.timestamp,
        }),
        now: Number(docVector.timestamp) * 1000,
        secret: docVector.apiSecret,
      })
    ).resolves.toBeUndefined();
    await expect(
      verify?.({
        body: text("cloudinary/sdk-sha256-vector.body"),
        headers: new Headers(
          jsonAs<Record<string, string>>(
            "cloudinary/sdk-sha256-vector.headers.json"
          )
        ),
        now: Number(sdkSha256Vector.timestamp) * 1000,
        secret: sdkSha256Vector.apiSecret,
      })
    ).resolves.toBeUndefined();
  });

  test("a signed upload notification parses through the webhook", async () => {
    const body = text("cloudinary/upload.json");
    const { hook, seen } = hookFor(
      "cloudinary",
      { now: () => NOW, secret: SECRET },
      { resourceType: "image", type: "upload" }
    );
    const res = await hook.handle(
      post(body, {
        "x-cld-signature": await sign(body, "1719310887", "SHA-256"),
        "x-cld-timestamp": "1719310887",
      })
    );
    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      contentType: "image/png",
      etag: "ac03de878dde557f29c59e83edcbd74b",
      id: "0cc3e0d9a2ce2703563b0c93c51c35ee",
      key: "jeans",
      size: 147_954,
      type: "created",
      versionId: "40c79d9223f1ca2797a55787b9c8f503",
    });
  });

  test.each([
    ["no signature", {}, "missing X-Cld-Signature"],
    [
      "only an EdDSA signature",
      { "x-cld-signature_v2": "x" },
      "X-Cld-Signature_v2",
    ],
    [
      "no timestamp",
      { "x-cld-signature": "a".repeat(40) },
      "missing X-Cld-Timestamp",
    ],
    [
      "a stale timestamp",
      { "x-cld-signature": "a".repeat(40), "x-cld-timestamp": "1" },
      "too old",
    ],
    [
      "an odd-length signature",
      { "x-cld-signature": "abc", "x-cld-timestamp": "1719310887" },
      "not a SHA-1 or SHA-256",
    ],
    [
      "a wrong signature",
      { "x-cld-signature": "a".repeat(40), "x-cld-timestamp": "1719310887" },
      "does not match",
    ],
  ])("%s → 401", async (_name, headers, message) => {
    const { hook } = hookFor("cloudinary", { now: () => NOW, secret: SECRET });
    const res = await hook.handle(
      post(text("cloudinary/upload.json"), headers)
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(message);
  });

  test("deletes fan out per resource; renames are a delete and a create", async () => {
    const files = filesAs({ name: "cloudinary" });
    const [deleted] = await files.events.parse(json("cloudinary/delete.json"));
    expect(deleted).toMatchObject({
      key: "kids_playing_with_puppy",
      time: Date.parse("2024-06-25T12:24:29.599Z"),
      type: "deleted",
    });
    const renamed = await files.events.parse(json("cloudinary/rename.json"));
    expect(renamed.map(({ key, type }) => `${type}:${key}`)).toEqual([
      "deleted:strawberry_milk_splash-qwer129-aslk-srghta",
      "created:strawberry_milk_splash",
    ]);
    expect(
      (await files.events.parse(json("cloudinary/upload-simple.json")))[0]?.type
    ).toBe("created");
  });

  test("events for another resource type are dropped", async () => {
    const raw = filesAs({
      name: "cloudinary",
      resourceType: "raw",
      type: "upload",
    });
    expect(await raw.events.parse(json("cloudinary/upload.json"))).toEqual([]);
    expect(await raw.events.parse(json("cloudinary/delete.json"))).toEqual([]);
    expect(await raw.events.parse(json("cloudinary/rename.json"))).toEqual([]);
  });

  test("other notification types are skipped; broken ones throw", async () => {
    const files = filesAs({ name: "cloudinary" });
    expect(await files.events.parse({ notification_type: "eager" })).toEqual(
      []
    );
    await expect(files.events.parse({ public_id: "x" })).rejects.toThrow(
      "no notification_type"
    );
    await expect(
      files.events.parse({ notification_type: "upload" })
    ).rejects.toThrow("without public_id");
    await expect(
      files.events.parse({ notification_type: "delete" })
    ).rejects.toThrow("without resources[]");
    await expect(
      files.events.parse({ notification_type: "delete", resources: [{}] })
    ).rejects.toThrow("deleted resource without public_id");
    await expect(
      files.events.parse({ notification_type: "rename" })
    ).rejects.toThrow("rename notification without public ids");
    const [upload] = await files.events.parse({
      asset_id: "a",
      notification_type: "upload",
      public_id: "p",
      resource_type: "raw",
    });
    expect(upload?.id).toStartWith("upload:a@");
    expect(upload?.contentType).toBeUndefined();
  });
});

describe("appwrite", () => {
  const signing = jsonAs<{ url: string; secret: string }>(
    "appwrite/signing.json"
  );
  const body = text("appwrite/file-create.body");

  test("a signed create and delete verify and parse", async () => {
    const { hook, seen } = hookFor("appwrite", {
      secret: signing.secret,
      url: signing.url,
    });
    for (const name of ["file-create", "file-delete"]) {
      // oxlint-disable-next-line no-await-in-loop -- two deliveries in order
      const res = await hook.handle(
        post(
          body,
          jsonAs<Record<string, string>>(`appwrite/${name}.headers.json`)
        )
      );
      expect(res.status).toBe(200);
    }
    expect(seen.map(({ key, type }) => `${type}:${key}`)).toEqual([
      "created:5e5ea5c16897e",
      "deleted:5e5ea5c16897e",
    ]);
    expect(seen[0]).toMatchObject({
      contentType: "image/png",
      etag: "5d529fd02b544198ae075bd57c1762bb",
      id: "PLACEHOLDER-delivery-id",
      size: 17_890,
    });
  });

  test("a wrong key or URL is a 401; a missing URL is refused up front", async () => {
    const wrong = hookFor("appwrite", { secret: "x", url: signing.url }).hook;
    expect(
      (
        await wrong.handle(
          post(
            body,
            jsonAs<Record<string, string>>("appwrite/file-create.headers.json")
          )
        )
      ).status
    ).toBe(401);
    const missing = hookFor("appwrite", {
      secret: signing.secret,
      url: signing.url,
    }).hook;
    expect((await missing.handle(post(body))).status).toBe(401);
    expect(() => hookFor("appwrite", { secret: signing.secret })).toThrow(
      "pass verify.url"
    );
  });

  test("the body alone can't be parsed; updates and other resources are skipped", async () => {
    const files = filesAs({ name: "appwrite" });
    await expect(files.events.parse(body)).rejects.toThrow(
      "X-Appwrite-Webhook-Events"
    );
    const update = new Request(URL_, {
      body,
      headers: {
        "x-appwrite-webhook-events":
          "buckets.5e5ea5c16897e.files.5e5ea5c16897e.update",
      },
      method: "POST",
    });
    expect(await files.events.parse(update)).toEqual([]);
    const user = new Request(URL_, {
      body: JSON.stringify({ $id: "u1", email: "a@b.c" }),
      headers: { "x-appwrite-webhook-events": "users.u1.create" },
      method: "POST",
    });
    expect(await files.events.parse(user)).toEqual([]);
    const noDelivery = new Request(URL_, {
      body,
      headers: {
        "x-appwrite-webhook-events":
          "buckets.5e5ea5c16897e.files.5e5ea5c16897e.create",
      },
      method: "POST",
    });
    expect((await files.events.parse(noDelivery))[0]?.id).toStartWith(
      "create:5e5ea5c16897e:"
    );
  });
});

describe("box", () => {
  const signing = jsonAs<{
    primaryKey: string;
    secondaryKey: string;
    incorrectKey: string;
  }>("box/sdk-vector.signing.json");
  const NOW = Date.parse("2020-01-01T00:05:00-07:00");

  const verifyBox = async (
    name: string,
    verify: { secret: string; secondarySecret?: string }
  ): Promise<number> => {
    const { hook } = hookFor("box", { now: () => NOW, ...verify });
    const res = await hook.handle(
      post(
        text(`box/${name}.body`),
        jsonAs<Record<string, string>>(`box/${name}.headers.json`)
      )
    );
    return res.status;
  };

  test("the SDK vector verifies with either key", async () => {
    expect(await verifyBox("sdk-vector", { secret: signing.primaryKey })).toBe(
      200
    );
    expect(
      await verifyBox("sdk-vector", {
        secondarySecret: signing.secondaryKey,
        secret: signing.incorrectKey,
      })
    ).toBe(200);
  });

  test("the escaped-unicode vector verifies over the raw bytes", async () => {
    expect(
      await verifyBox("sdk-vector-unicode", { secret: signing.primaryKey })
    ).toBe(200);
    // It carries no secondary signature to fall back on.
    expect(
      await verifyBox("sdk-vector-unicode", {
        secondarySecret: signing.secondaryKey,
        secret: signing.incorrectKey,
      })
    ).toBe(401);
  });

  test.each([
    ["wrong keys", { secret: "nope" }, {}, "does not match"],
    ["a stale delivery", { now: () => NOW + 3_600_000 }, {}, "too old"],
    [
      "another signature version",
      {},
      { "box-signature-version": "2" },
      "not a Box v1",
    ],
  ])("%s → 401", async (_name, verify, headerPatch, message) => {
    const body = text("box/sdk-vector.body");
    const headers = {
      ...jsonAs<Record<string, string>>("box/sdk-vector.headers.json"),
      ...headerPatch,
    };
    const { hook } = hookFor("box", {
      now: () => NOW,
      secret: signing.primaryKey,
      ...verify,
    });
    const res = await hook.handle(post(body, headers));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(message);
  });

  test("keys are paths under the adapter's root folder", async () => {
    const payload = json("box/file-uploaded.json");
    const atRoot = filesAs({ name: "box" });
    expect((await atRoot.events.parse(payload))[0]).toMatchObject({
      etag: "0",
      id: "eb0c4e06-751f-442c-86f8-fd5bb404dbec",
      key: "Testing/Webhooks Base/Webhooks/Test-Image-3.png",
      size: 26_458,
      type: "created",
      versionId: "78096737033",
    });
    const scoped = filesAs({ name: "box", rootFolderId: "2614853901" });
    expect((await scoped.events.parse(payload))[0]?.key).toBe(
      "Webhooks Base/Webhooks/Test-Image-3.png"
    );
    const elsewhere = filesAs({ name: "box", rootFolderId: "999" });
    expect(await elsewhere.events.parse(payload)).toEqual([]);
  });

  test("trashed and deleted files are deletes; other triggers are skipped", async () => {
    const files = filesAs({ name: "box" });
    expect(
      (await files.events.parse(json("box/file-trashed.derived.json")))[0]?.type
    ).toBe("deleted");
    expect(
      (await files.events.parse(json("box/file-deleted.derived.json")))[0]?.type
    ).toBe("deleted");
    const payload = jsonAs<Record<string, unknown>>("box/file-uploaded.json");
    expect(
      await files.events.parse({ ...payload, trigger: "FILE.PREVIEWED" })
    ).toEqual([]);
    expect(
      await files.events.parse({
        ...payload,
        source: { type: "folder" },
        trigger: "FILE.UPLOADED",
      })
    ).toEqual([]);
    await expect(files.events.parse({ trigger: 1 })).rejects.toThrow(
      "without trigger or source"
    );
    const [noId] = await files.events.parse({
      source: {
        id: "f1",
        name: "a.txt",
        path_collection: { entries: [{ id: "0" }, "junk"] },
        type: "file",
      },
      trigger: "FILE.RESTORED",
    });
    expect(noId?.key).toBe("/a.txt");
    expect(noId?.id).toStartWith("FILE.RESTORED:f1@");
  });
});

describe("SNS over HTTPS", () => {
  // Serves the captured certificates by file name; anything else is a 404.
  const certFetch = mock((url: string) => {
    const base = new URL(url).pathname.slice(1);
    try {
      return Promise.resolve(new Response(text(`sns-http/certs/${base}`)));
    } catch {
      return Promise.resolve(new Response("", { status: 404 }));
    }
  });
  const fetchImpl = certFetch as unknown as typeof fetch;

  test.each([
    "subscription-confirmation",
    "unsubscribe-confirmation",
    "notification-v1",
    "notification-v1-subject",
    "notification-v2",
    "legacy-notification-v1",
    "legacy-notification-v2",
    "legacy-notification-v2-subject",
  ])("%s verifies against its certificate", async (name) => {
    const verify = snsVerifier({ fetch: fetchImpl });
    const body = text(`sns-http/${name}.json`);
    await expect(verify(post(body), body)).resolves.toMatchObject({
      Type: expect.any(String),
    });
  });

  test("a tampered message, another topic, or a foreign cert host is a 401", async () => {
    const verify = snsVerifier({ fetch: fetchImpl });
    const message = jsonAs<Record<string, string>>(
      "sns-http/notification-v2.json"
    );
    const tampered = JSON.stringify({ ...message, Message: "evil" });
    await expect(verify(post(tampered), tampered)).rejects.toThrow(
      "SNS signature does not match"
    );
    const pinned = snsVerifier({ fetch: fetchImpl, topicArn: "arn:other" });
    const body = JSON.stringify(message);
    await expect(pinned(post(body), body)).rejects.toThrow("another topic");
    const foreign = JSON.stringify({
      ...message,
      SigningCertURL: "https://evil.example.com/cert.pem",
    });
    await expect(verify(post(foreign), foreign)).rejects.toThrow(
      "not a signed SNS message"
    );
    const badBase64 = JSON.stringify({ ...message, Signature: "%%%" });
    await expect(verify(post(badBase64), badBase64)).rejects.toThrow(
      "not base64"
    );
    await expect(verify(post("nope"), "nope")).rejects.toThrow(
      "not a signed SNS message"
    );
    await expect(verify(post("[]"), "[]")).rejects.toThrow(
      "not a signed SNS message"
    );
  });

  test("raw message delivery is unsigned and fails closed", async () => {
    const verify = snsVerifier({ fetch: fetchImpl });
    const body = text("sns-http/raw-delivery-s3-put.derived.json");
    await expect(
      verify(
        new Request(URL_, {
          body,
          headers: jsonAs<Record<string, string>>(
            "sns-http/raw-delivery-s3-put.derived.headers.json"
          ),
          method: "POST",
        }),
        body
      )
    ).rejects.toThrow("raw message delivery is unsigned");
  });

  test("a failed certificate fetch is retried on the next delivery", async () => {
    let fail = true;
    const flaky = mock((url: string) =>
      fail ? Promise.resolve(new Response("", { status: 503 })) : certFetch(url)
    );
    const verify = snsVerifier({ fetch: flaky as unknown as typeof fetch });
    const body = text("sns-http/notification-v2.json");
    await expect(verify(post(body), body)).rejects.toThrow("(503)");
    fail = false;
    await expect(verify(post(body), body)).resolves.toBeDefined();
    await verify(post(body), body);
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  test("the webhook confirms a subscription when asked to", async () => {
    const calls: string[] = [];
    const fetchBoth = ((url: string) => {
      calls.push(url);
      return url.endsWith(".pem")
        ? certFetch(url)
        : Promise.resolve(new Response("<ConfirmSubscriptionResponse/>"));
    }) as unknown as typeof fetch;
    const { hook, seen } = hookFor("s3", {
      sns: { confirm: true, fetch: fetchBoth },
    });
    const res = await hook.handle(
      post(text("sns-http/subscription-confirmation.json"))
    );
    expect(await res.json()).toEqual({ confirmed: true });
    expect(calls.at(-1)).toStartWith(
      "https://sns.us-west-2.amazonaws.com/?Action=ConfirmSubscription"
    );
    expect(seen).toEqual([]);
  });

  test("without confirm, the SubscribeURL is logged; unsubscribe is acknowledged", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const { hook } = hookFor("s3", { sns: { fetch: fetchImpl } });
    const res = await hook.handle(
      post(text("sns-http/subscription-confirmation.json"))
    );
    expect(await res.json()).toEqual({ confirmed: false });
    expect(String(warn.mock.calls[0]?.[0])).toContain("ConfirmSubscription");
    const bye = await hook.handle(
      post(text("sns-http/unsubscribe-confirmation.json"))
    );
    expect(await bye.json()).toEqual({ received: 0 });
  });

  test("a failed confirmation is a 502", async () => {
    const fetchBoth = ((url: string) =>
      url.endsWith(".pem")
        ? certFetch(url)
        : Promise.resolve(
            new Response("", { status: 403 })
          )) as unknown as typeof fetch;
    const { hook } = hookFor("s3", {
      sns: { confirm: true, fetch: fetchBoth },
    });
    const res = await hook.handle(
      post(text("sns-http/subscription-confirmation.json"))
    );
    expect(res.status).toBe(502);
  });

  test("a verified notification goes on to the s3 parser", async () => {
    const { hook } = hookFor("s3", { sns: { fetch: fetchImpl } });
    // Signed, but its Message isn't an S3 event: verified, then a 400.
    const res = await hook.handle(post(text("sns-http/notification-v2.json")));
    expect(res.status).toBe(400);
    const unsigned = await hook.handle(
      post(text("sns-http/s3-put.derived.json"))
    );
    expect(unsigned.status).toBe(401);
  });

  test("the derived S3-over-SNS payloads parse (without verification)", async () => {
    const files = filesAs({ name: "s3" });
    expect(
      (await files.events.parse(json("sns-http/s3-put.derived.json")))[0]?.key
    ).toBe("HappyFace.jpg");
    expect(
      await files.events.parse(json("sns-http/s3-test-event.derived.json"))
    ).toEqual([]);
  });

  test("verify.sns is only for the s3 format", () => {
    expect(() => hookFor("gcs", { sns: {} })).toThrow(
      "verify.sns is for S3 notifications"
    );
  });

  test("a SubscribeURL off SNS is refused", async () => {
    const message = jsonAs<Record<string, string>>(
      "sns-http/subscription-confirmation.json"
    );
    const { snsHandshake } = await import("../src/events/sns.js");
    await expect(
      snsHandshake(
        { ...message, SubscribeURL: "https://evil.example.com/" },
        {}
      )
    ).rejects.toThrow("SubscribeURL is not an SNS endpoint");
  });

  test("helpers", () => {
    expect(
      snsUrl("https://sns.us-east-1.amazonaws.com/x.pem", true)
    ).toBeDefined();
    expect(
      snsUrl("https://sns.cn-north-1.amazonaws.com.cn/x.pem", true)
    ).toBeDefined();
    expect(
      snsUrl("http://sns.us-east-1.amazonaws.com/x.pem", true)
    ).toBeUndefined();
    expect(
      snsUrl("https://sns.us-east-1.amazonaws.com/x.txt", true)
    ).toBeUndefined();
    expect(snsUrl("not a url")).toBeUndefined();
    expect(snsUrl(4)).toBeUndefined();
    expect(stringToSign({ Message: "m", Type: "Notification" })).toBe(
      "Message\nm\nType\nNotification\n"
    );
  });
});

describe("x509", () => {
  test("pulls the SPKI out of a certificate", () => {
    const der = pemToDer(
      text(
        "sns-http/certs/SimpleNotificationService-7506a1e35b36ef5a444dd1a8e7cc3ed8.pem"
      )
    );
    const spki = spkiOf(der);
    expect(spki[0]).toBe(0x30);
    expect(spki.length).toBeGreaterThan(200);
  });

  test("rejects what isn't a DER certificate", () => {
    expect(() => pemToDer("-----BEGIN CERTIFICATE-----\n%%%\n")).toThrow(
      "not a DER X.509"
    );
    for (const bytes of [
      [],
      [0x30],
      [0x30, 0x85, 0, 0, 0, 0, 0],
      [0x30, 0x81],
      [0x30, 0x05, 0x02],
      [0x02, 0x00],
      [0x30, 0x02, 0x02, 0x00],
    ]) {
      expect(() => spkiOf(new Uint8Array(bytes))).toThrow("not a DER X.509");
    }
    // A certificate whose seventh tbs field isn't a SEQUENCE.
    const fields = Array.from({ length: 6 }, () => [0x02, 0x00]).flat();
    const tbs = [0x30, fields.length, ...fields];
    expect(() => spkiOf(new Uint8Array([0x30, tbs.length, ...tbs]))).toThrow(
      "not a DER X.509"
    );
  });
});
