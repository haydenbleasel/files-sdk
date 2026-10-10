// Each format's parser, driven by payloads captured from the provider's docs
// (see test/fixtures/events/*/SOURCES.md for where each one came from).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { backblazeB2 } from "../src/backblaze-b2/index.js";
import { events } from "../src/events/index.js";
import { hetzner } from "../src/hetzner/index.js";
import type { Adapter, FileEvent } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { minio } from "../src/minio/index.js";
import { r2 } from "../src/r2/index.js";
import { rustfs } from "../src/rustfs/index.js";
import { s3Fetch } from "../src/s3-fetch/index.js";
import { s3 } from "../src/s3/index.js";
import { storj } from "../src/storj/index.js";
import { tigris } from "../src/tigris/index.js";
import { wasabi } from "../src/wasabi/index.js";
import { providerAdapter } from "./events-helper.js";
import { fakeAdapter } from "./fake-adapter.js";

const FIXTURES = path.join(import.meta.dir, "fixtures", "events");

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), "utf-8"));

const headersOf = (name: string): Headers => {
  // SAFETY: the `.headers.json` fixtures are flat string maps.
  const raw = fixture(name) as Record<string, string>;
  return new Headers(raw);
};

/** A store whose adapter reports `name`, so `events()` picks that format. */
const filesAs = (name: string, opts: { prefix?: string } = {}) =>
  createFiles({
    adapter: providerAdapter(name),
    plugins: [events()],
    ...opts,
  });

const parse = (name: string, input: unknown): Promise<FileEvent[]> =>
  filesAs(name).events.parse(input);

const s3RecordOf = (key: string) => ({
  eventName: "ObjectCreated:Put",
  eventSource: "aws:s3",
  s3: { object: { key } },
});

const pick = (list: FileEvent[]) =>
  list.map(({ contentType, etag, key, size, type, versionId }) => ({
    contentType,
    etag,
    key,
    size,
    type,
    versionId,
  }));

const typesOf = (list: FileEvent[]) => list.map((e) => e.type);

/** `s3/lambda-put.json` as `eventName`, versioned as `versionId` (none when omitted). */
const lambdaRecord = (eventName: string, versionId?: string | null) => {
  const { Records } = fixture("s3/lambda-put.json") as {
    Records: { s3: { object: Record<string, unknown> } }[];
  };
  const record = Records[0] as { s3: { object: Record<string, unknown> } };
  const { versionId: _v, ...object } = record.s3.object;
  return {
    Records: [
      {
        ...record,
        eventName,
        s3: {
          ...record.s3,
          object: { ...object, ...(versionId !== undefined && { versionId }) },
        },
      },
    ],
  };
};

const declaredFormat = (adapter: Adapter) =>
  createFiles({ adapter }).capabilities.events;

describe("adapters declare their notification format", () => {
  const creds = { accessKeyId: "k", secretAccessKey: "s" };

  test("AWS S3 reads s3; an S3-compatible endpoint claims nothing", () => {
    expect(
      declaredFormat(
        s3({ bucket: "b", credentials: creds, region: "us-east-1" })
      )
    ).toEqual({ format: "s3" });
    expect(
      declaredFormat(
        s3({
          bucket: "b",
          credentials: creds,
          endpoint: "https://storage.example.com",
          region: "us-east-1",
        })
      )
    ).toBe(false);
    expect(
      declaredFormat(
        s3Fetch({
          bucket: "b",
          endpoint: "https://s3.us-east-1.amazonaws.com",
          ...creds,
        })
      )
    ).toEqual({ format: "s3" });
    expect(
      declaredFormat(
        s3Fetch({
          bucket: "b",
          endpoint: "https://storage.example.com",
          ...creds,
        })
      )
    ).toBe(false);
  });

  test("verified S3-compatible wrappers read s3; unverified ones don't", () => {
    for (const client of ["aws-sdk", "fetch"] as const) {
      expect(
        declaredFormat(
          minio({
            bucket: "b",
            client,
            endpoint: "http://minio.local",
            ...creds,
          })
        )
      ).toEqual({ format: "s3" });
      expect(
        declaredFormat(
          rustfs({
            bucket: "b",
            client,
            endpoint: "http://rustfs.local",
            ...creds,
          })
        )
      ).toEqual({ format: "s3" });
    }
    expect(
      declaredFormat(wasabi({ bucket: "b", region: "us-east-1", ...creds }))
    ).toEqual({ format: "s3" });
    expect(
      declaredFormat(hetzner({ bucket: "b", region: "fsn1", ...creds }))
    ).toBe(false);
    expect(declaredFormat(storj({ bucket: "b", ...creds }))).toEqual({
      format: "s3",
    });
  });

  test("B2, Tigris and every R2 engine read their own formats", () => {
    expect(
      declaredFormat(
        backblazeB2({ bucket: "b", region: "us-west-004", ...creds })
      )
    ).toEqual({ format: "b2" });
    expect(declaredFormat(tigris({ bucket: "b", ...creds }))).toEqual({
      format: "tigris",
    });
    for (const client of ["aws-sdk", "fetch"] as const) {
      expect(
        declaredFormat(r2({ accountId: "a", bucket: "b", client, ...creds }))
      ).toEqual({ format: "r2" });
    }
    expect(declaredFormat(r2({ binding: {} as never }))).toEqual({
      format: "r2",
    });
  });

  test("an adapter without notifications has no format", () => {
    expect(declaredFormat(fakeAdapter())).toBe(false);
  });
});

describe("s3", () => {
  test("a Lambda S3 event", async () => {
    const [event] = await parse("s3", fixture("s3/lambda-put.json"));
    expect(event).toMatchObject({
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      id: "created:amzn-s3-demo-bucket/HappyFace.jpg@0055AED6DCD90281E5",
      key: "HappyFace.jpg",
      provider: "s3",
      size: 1024,
      source: "provider",
      time: 0,
      type: "created",
      versionId: "096fKKXTRTtl3on89fVO.nfljtsv6qko",
    });
    expect(event?.raw).toMatchObject({ eventName: "ObjectCreated:Put" });
  });

  test("Records[] keys are URL-decoded, + as a space", async () => {
    const [plus] = await parse(
      "s3",
      fixture("s3/lambda-put-encoded-key-plus.json")
    );
    expect(plus?.key).toBe("photos/my summer(2024).jpg");
    const [encoded] = await parse(
      "s3",
      fixture("s3/lambda-put-encoded-key.json")
    );
    expect(encoded?.key).toBe("test/key");
  });

  test("a delete carries no size or etag", async () => {
    expect(pick(await parse("s3", fixture("s3/lambda-delete.json")))).toEqual([
      {
        contentType: undefined,
        etag: undefined,
        key: "b21b84d653bb07b05b1e6b33684dc11b",
        size: undefined,
        type: "deleted",
        versionId: undefined,
      },
    ]);
  });

  test("an SQS consumer batch, and one SQS record", async () => {
    const batch = fixture("s3/sqs-body.json");
    const fromBatch = await parse("s3", batch);
    expect(pick(fromBatch)).toEqual([
      {
        contentType: undefined,
        etag: "2e3ad1e983318bbd8e73b080e2997980",
        key: "test.pdf",
        size: 104_681,
        type: "created",
        versionId: "yd3d4HaWOT2zguDLvIQLU6ptDTwKBnQV",
      },
    ]);
    // SAFETY: the fixture is an SQS Lambda event.
    const [record] = (batch as { Records: unknown[] }).Records;
    expect(await parse("s3", record)).toEqual(fromBatch);
  });

  test("SNS inside SQS unwraps the Message", async () => {
    expect(pick(await parse("s3", fixture("s3/sns-in-sqs.json")))).toEqual(
      pick(await parse("s3", fixture("s3/lambda-put.json")))
    );
  });

  test("the s3:TestEvent parses to nothing, bare or in SQS", async () => {
    expect(await parse("s3", fixture("s3/test-event.json"))).toEqual([]);
    expect(
      await parse("s3", {
        Records: [
          {
            body: JSON.stringify(fixture("s3/test-event.json")),
            eventSource: "aws:sqs",
          },
        ],
      })
    ).toEqual([]);
  });

  test("EventBridge created / deleted / lifecycle, keys not decoded", async () => {
    const [created] = await parse("s3", fixture("s3/eventbridge-created.json"));
    expect(created).toMatchObject({
      etag: "b1946ac92492d2347c6235b4d2611184",
      id: "17793124-05d4-b198-2fde-7ededc63b103",
      key: "example-key",
      size: 5,
      time: Date.parse("2021-11-12T00:00:00Z"),
      type: "created",
      versionId: "IYV3p45BT0ac8hjHg1houSdS1a.Mro8e",
    });
    const [deleted] = await parse("s3", fixture("s3/eventbridge-deleted.json"));
    expect(deleted).toMatchObject({ key: "example-key", type: "deleted" });
    expect(deleted?.size).toBeUndefined();
    const [expired] = await parse(
      "s3",
      fixture("s3/eventbridge-deleted-lifecycle.json")
    );
    expect(expired?.type).toBe("deleted");

    const plus = {
      ...(fixture("s3/eventbridge-created.json") as object),
      detail: { object: { key: "plus+test (2).jpg" } },
    };
    const [unencoded] = await parse("s3", plus);
    expect(unencoded?.key).toBe("plus+test (2).jpg");
  });

  test("EventBridge detail-types other than created/deleted parse to nothing", async () => {
    const restore = {
      ...(fixture("s3/eventbridge-created.json") as object),
      "detail-type": "Object Restore Completed",
    };
    expect(await parse("s3", restore)).toEqual([]);
  });

  test("MinIO webhook payloads, s3:-prefixed names and QueryEscape'd keys", async () => {
    expect(
      pick(await parse("minio", fixture("s3/minio-webhook-put.json")))
    ).toEqual([
      {
        contentType: "image/jpeg",
        etag: "eb52f8e46f60a27a8a1a704e25757f30",
        key: "image.jpg",
        size: 84_452,
        type: "created",
        versionId: undefined,
      },
    ]);
    const [encoded] = await parse(
      "minio",
      fixture("s3/minio-webhook-put-encoded-key.json")
    );
    expect(encoded?.key).toBe("photos/my summer(2024).jpg");
    const [deleted] = await parse(
      "minio",
      fixture("s3/minio-webhook-delete.json")
    );
    expect(deleted?.type).toBe("deleted");
  });

  test("RustFS (no eventSource, %2F keys) and Wasabi (wasabi:s3) records", async () => {
    const [fromRustfs] = await parse(
      "rustfs",
      fixture("s3-compatible/rustfs-webhook.json")
    );
    expect(fromRustfs).toMatchObject({
      key: "uploads/hello.dat",
      type: "created",
    });
    const wasabiMessage = fixture("s3-compatible/wasabi-sns-message.json");
    const [direct] = await parse("wasabi", wasabiMessage);
    expect(direct).toMatchObject({
      key: "heart.jpg",
      size: 9061,
      type: "created",
    });
    const viaSns = await parse("wasabi", {
      Message: JSON.stringify(wasabiMessage),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:wasabi",
      Type: "Notification",
    });
    expect(viaSns.map((e) => e.key)).toEqual(["heart.jpg"]);
  });

  describe("Storj, through Google Pub/Sub", () => {
    const storjEvent = fixture("s3-compatible/storj-event.json");
    const data = btoa(JSON.stringify(storjEvent));
    const message = {
      data,
      messageId: "2070443601311540",
      publishTime: "2025-01-17T10:30:01.000Z",
    };
    const expected = {
      contentType: undefined,
      etag: undefined,
      key: "uploads/video.mp4",
      size: 1_048_576,
      type: "created" as const,
      versionId: "000000000000000190f2277f35af0b76",
    };

    test("a push delivery, a pulled message, and a pulled batch", async () => {
      expect(
        pick(
          await parse("storj", {
            message,
            subscription: "projects/p/subscriptions/storj-push",
          })
        )
      ).toEqual([expected]);
      expect(pick(await parse("storj", message))).toEqual([expected]);
      expect(
        pick(
          await parse("storj", {
            receivedMessages: [{ ackId: "a", message }],
          })
        )
      ).toEqual([expected]);
      const [event] = await parse("storj", message);
      expect(event?.id).toBe(
        "created:my-bucket/uploads/video.mp4@1892E0DE46FBAE18"
      );
    });

    test("the Node client's message, whose data is a Buffer", async () => {
      const files = filesAs("storj");
      const nodeMessage = {
        ...message,
        data: new TextEncoder().encode(JSON.stringify(storjEvent)),
      };
      expect(pick(await files.events.parse(nodeMessage))).toEqual([expected]);
    });

    test("keys are decoded the way Storj encodes them", async () => {
      // EncodeForS3Event: `my file+test (1).txt` → `my+file%2Btest+%281%29.txt`
      const encoded = structuredClone(storjEvent) as {
        Records: { s3: { object: { key: string } } }[];
      };
      const [record] = encoded.Records;
      if (record) {
        record.s3.object.key = "dir/my+file%2Btest+%281%29.txt";
      }
      const [event] = await parse("storj", {
        ...message,
        data: btoa(JSON.stringify(encoded)),
      });
      expect(event?.key).toBe("dir/my file+test (1).txt");
    });

    test("the test event and an empty message parse to nothing", async () => {
      expect(
        await parse("storj", {
          ...message,
          data: btoa(
            JSON.stringify(fixture("s3-compatible/storj-test-event.json"))
          ),
        })
      ).toEqual([]);
      expect(await parse("storj", { ...message, data: "" })).toEqual([]);
    });

    test("bad message data throws", async () => {
      await expect(parse("storj", { ...message, data: "!!!" })).rejects.toThrow(
        "message data is not base64"
      );
      await expect(
        parse("storj", { ...message, data: btoa("not json") })
      ).rejects.toThrow("message body is not JSON");
    });
  });

  test.each([
    ["ObjectCreated:CompleteMultipartUpload", "created"],
    ["ObjectCreated:Copy", "created"],
    ["ObjectCreated:Post", "created"],
    ["ObjectRemoved:DeleteMarkerCreated", "deleted"],
    ["LifecycleExpiration:Delete", "deleted"],
    ["LifecycleExpiration:DeleteMarkerCreated", "deleted"],
    ["s3:ObjectRemoved:DeleteAllVersions", "deleted"],
    ["s3:ObjectCreated:PutTagging", undefined],
    ["s3:ObjectRemoved:NoOP", undefined],
    ["s3:LifecycleDelMarkerExpiration:Delete", undefined],
    ["ObjectRestore:Completed", undefined],
    ["ObjectTagging:Put", undefined],
  ])("eventName %s → %s", async (eventName, type) => {
    // An unversioned bucket's record: no version id.
    const list = await parse("s3", lambdaRecord(eventName));
    expect(list[0]?.type).toBe(type as FileEvent["type"]);
  });

  test("a permanent delete of one version is skipped; a delete marker is a delete", async () => {
    const types = async (eventName: string, versionId?: string | null) =>
      typesOf(await parse("s3", lambdaRecord(eventName, versionId)));
    // `DELETE ?versionId=`, NoncurrentVersionExpiration, an expired delete
    // marker's cleanup: the key may still have a live version.
    expect(await types("ObjectRemoved:Delete", "3HL4kqtJlcpXroDTDmJ")).toEqual(
      []
    );
    expect(await types("s3:ObjectRemoved:Delete", "v2")).toEqual([]);
    expect(await types("LifecycleExpiration:Delete", "v1")).toEqual([]);
    // Unversioned: no version, or S3's "null".
    expect(await types("ObjectRemoved:Delete")).toEqual(["deleted"]);
    expect(await types("ObjectRemoved:Delete", "null")).toEqual(["deleted"]);
    expect(await types("ObjectRemoved:Delete", null)).toEqual(["deleted"]);
    expect(await types("ObjectRemoved:Delete", "")).toEqual(["deleted"]);
    expect(await types("LifecycleExpiration:Delete")).toEqual(["deleted"]);
    // A delete marker carries its own version id, and is the logical delete.
    expect(await types("ObjectRemoved:DeleteMarkerCreated", "m1")).toEqual([
      "deleted",
    ]);
    expect(
      await types("LifecycleExpiration:DeleteMarkerCreated", "m1")
    ).toEqual(["deleted"]);
    // The fixtures without a version id still report.
    const fromFixture = await parse("s3", fixture("s3/lambda-delete.json"));
    expect(typesOf(fromFixture)).toEqual(["deleted"]);
  });

  test("EventBridge: a version permanently deleted is skipped", async () => {
    const deleted = fixture("s3/eventbridge-deleted.json") as {
      detail: { object: Record<string, unknown> } & Record<string, unknown>;
    };
    const withDetail = (extra: Record<string, unknown>, versionId?: string) => {
      const { "version-id": _v, ...object } = deleted.detail.object;
      return {
        ...deleted,
        detail: {
          ...deleted.detail,
          ...extra,
          object: {
            ...object,
            ...(versionId !== undefined && { "version-id": versionId }),
          },
        },
      };
    };
    const permanently = { "deletion-type": "Permanently Deleted" };
    expect(await parse("s3", withDetail(permanently, "v1"))).toEqual([]);
    const unversioned = await parse("s3", withDetail(permanently));
    expect(typesOf(unversioned)).toEqual(["deleted"]);
    const nullVersion = await parse("s3", withDetail(permanently, "null"));
    expect(typesOf(nullVersion)).toEqual(["deleted"]);
    // The fixture: a delete marker, with its version id.
    const marker = await parse("s3", deleted);
    expect(marker.map((e) => [e.type, e.versionId])).toEqual([
      ["deleted", "1QW9g1Z99LUNbvaaYVpW9xDlOLU.qxgF"],
    ]);
  });

  test("without a sequencer, the id comes from the version, time and ETag, never the clock", async () => {
    const base = fixture("s3/lambda-put.json") as {
      Records: { s3: { object: Record<string, unknown> } }[];
    };
    const record = base.Records[0] as { s3: { object: object } };
    const { sequencer: _s, ...noSequencer } = record.s3.object as {
      sequencer: string;
    };
    const parsed = await parse("s3", {
      Records: [{ ...record, s3: { ...record.s3, object: noSequencer } }],
    });
    expect(parsed[0]?.id).toBe(
      "created:amzn-s3-demo-bucket/HappyFace.jpg@096fKKXTRTtl3on89fVO.nfljtsv6qko#1970-01-01T00:00:00.000Z#d41d8cd98f00b204e9800998ecf8427e"
    );
    // RustFS's documented record has no sequencer, time, version or ETag: the
    // id is a hash of the record, the same on every redelivery.
    const rustfsEvent = fixture("s3-compatible/rustfs-webhook.json");
    const [first] = await parse("rustfs", rustfsEvent);
    await Bun.sleep(2);
    const [again] = await parse("rustfs", structuredClone(rustfsEvent));
    expect(first?.id).toMatch(
      /^created:my-bucket\/uploads\/hello\.dat@h:[0-9a-f]{16}$/u
    );
    expect(again?.id).toBe(first?.id as string);
    // Key order doesn't change the hash (a string, so it stays reversed).
    const reordered =
      '{"Records":[{"s3":{"object":{"key":"uploads%2Fhello.dat"},"bucket":{"name":"my-bucket"}},"eventName":"s3:ObjectCreated:Put"}]}';
    const [fromReordered] = await parse("rustfs", reordered);
    expect(fromReordered?.id).toBe(first?.id as string);
    const other = await parse("rustfs", {
      Records: [
        {
          eventName: "s3:ObjectCreated:Put",
          s3: {
            bucket: { name: "my-bucket" },
            object: { key: "uploads%2Fhello.dat" },
          },
          userIdentity: { principalId: "x" },
        },
      ],
    });
    expect(other[0]?.id).not.toBe(first?.id as string);
  });

  test("a Lambda subscribed to the SNS topic", async () => {
    const message = JSON.stringify(fixture("s3/lambda-put.json"));
    const lambdaSns = {
      Records: [
        {
          EventSource: "aws:sns",
          EventSubscriptionArn: "arn:aws:sns:us-east-1:1:uploads:sub",
          EventVersion: "1.0",
          Sns: {
            Message: message,
            MessageId: "m1",
            Signature: "x",
            SignatureVersion: "1",
            SigningCertUrl: "https://sns.us-east-1.amazonaws.com/x.pem",
            Subject: "Amazon S3 Notification",
            Timestamp: "2026-01-01T00:00:00.000Z",
            TopicArn: "arn:aws:sns:us-east-1:1:uploads",
            Type: "Notification",
          },
        },
      ],
    };
    const viaSns = await parse("s3", lambdaSns);
    expect(viaSns.map((e) => e.key)).toEqual(["HappyFace.jpg"]);
    await expect(
      parse("s3", { Records: [{ EventSource: "aws:sns", Sns: "nope" }] })
    ).rejects.toThrow("SNS record without an Sns notification");
  });

  test("malformed deliveries throw", async () => {
    await expect(parse("s3", { hello: "world" })).rejects.toThrow(
      "not a s3 notification"
    );
    await expect(parse("s3", { hello: "world" })).rejects.toMatchObject({
      code: "Invalid",
      permanent: true,
    });
    await expect(parse("s3", [1])).rejects.toThrow("expected a Request");
    await expect(
      parse("s3", { Records: [{ body: 4, eventSource: "aws:sqs" }] })
    ).rejects.toThrow("SQS record without a string body");
    await expect(
      parse("s3", { body: "{not json", eventSource: "aws:sqs" })
    ).rejects.toThrow("message body is not JSON");
    await expect(
      parse("s3", { Records: [{ eventSource: "aws:s3" }] })
    ).rejects.toThrow("record without eventName");
    await expect(
      parse("s3", {
        Records: [
          {
            eventName: "ObjectCreated:Put",
            eventSource: "aws:s3",
            s3: { object: { key: "%E0%A4%A" } },
          },
        ],
      })
    ).rejects.toThrow("not URL-encoded");
    await expect(
      parse("s3", {
        detail: {},
        "detail-type": "Object Created",
        source: "aws.s3",
      })
    ).rejects.toThrow("EventBridge event without detail.object.key");
    await expect(parse("s3", "nope")).rejects.toThrow("delivery is not JSON");
  });

  test("a non-object record, and an unparseable time falls back to now", async () => {
    await expect(parse("s3", { Records: [1] })).rejects.toThrow(
      "expected an object"
    );
    const before = Date.now();
    const [event] = await parse("s3", {
      Records: [{ ...s3RecordOf("a"), eventTime: "yesterday" }],
    });
    expect(event?.time).toBeGreaterThanOrEqual(before);
  });

  test("an SNS envelope that isn't a Notification parses to nothing", async () => {
    expect(
      await parse("s3", {
        TopicArn: "arn:aws:sns:us-east-1:1:t",
        Type: "SubscriptionConfirmation",
      })
    ).toEqual([]);
  });
});

describe("r2", () => {
  test.each([
    ["r2/queue-put.json", "created", 65_536],
    ["r2/queue-copy.json", "created", 65_536],
    ["r2/queue-delete.json", "deleted", undefined],
    ["r2/queue-lifecycle-delete.json", "deleted", undefined],
  ])("%s", async (name, type, size) => {
    const [event] = await parse("r2-binding", fixture(name));
    expect(event).toMatchObject({
      key: "my-new-object",
      provider: "r2-binding",
      time: Date.parse("2024-05-24T19:36:44.379Z"),
      type: type as FileEvent["type"],
    });
    expect(event?.size).toBe(size);
  });

  test("a Worker Message, a JSON string, a batch, and base64 pull bodies", async () => {
    const body = fixture("r2/queue-put.json");
    const expected = pick(await parse("r2", body));
    expect(pick(await parse("r2", { attempts: 1, body, id: "m1" }))).toEqual(
      expected
    );
    expect(pick(await parse("r2", JSON.stringify(body)))).toEqual(expected);
    expect(await parse("r2", [body, body])).toHaveLength(2);
    const encoded = btoa(JSON.stringify(body));
    expect(
      pick(await parse("r2", { result: { messages: [{ body: encoded }] } }))
    ).toEqual(expected);
    expect(
      pick(await parse("r2", { messages: [{ body: JSON.stringify(body) }] }))
    ).toEqual(expected);
  });

  test("the pull API doc example (non-notification bodies) is malformed", async () => {
    await expect(parse("r2", fixture("r2/pull-response.json"))).rejects.toThrow(
      "neither JSON nor base64 JSON"
    );
  });

  test("an unknown action parses to nothing; a broken body throws", async () => {
    expect(
      await parse("r2", { action: "Unknown", object: { key: "k" } })
    ).toEqual([]);
    await expect(
      parse("r2", { action: "PutObject", object: {} })
    ).rejects.toThrow("expected action and object.key");
    await expect(parse("r2", { nothing: true })).rejects.toThrow(
      "no action/object"
    );
    await expect(parse("r2", [[1]])).rejects.toThrow("expected a Request");
    await expect(parse("r2", { messages: [1] })).rejects.toThrow(
      "expected an object"
    );
  });
});

describe("gcs", () => {
  test("a pulled OBJECT_FINALIZE message", async () => {
    const [event] = await parse(
      "gcs",
      fixture("gcs/pubsub-pull-finalize.json")
    );
    expect(event).toMatchObject({
      contentType: "text/plain",
      etag: "CNHZkbuF/ugCEAE=",
      id: "OBJECT_FINALIZE:sample-bucket/folder/Test.cs#1587627537231057",
      key: "folder/Test.cs",
      size: 352,
      time: Date.parse("2020-04-23T07:38:57.230Z"),
      type: "created",
      versionId: "1587627537231057",
    });
  });

  test("delete, archive, overwrite and metadata updates", async () => {
    const [deleted] = await parse(
      "gcs",
      fixture("gcs/pubsub-pull-delete.json")
    );
    expect(deleted?.type).toBe("deleted");
    const [archived] = await parse(
      "gcs",
      fixture("gcs/pubsub-pull-archive.json")
    );
    expect(archived?.type).toBe("deleted");
    expect(
      await parse("gcs", fixture("gcs/pubsub-pull-delete-overwritten.json"))
    ).toEqual([]);
    expect(
      await parse("gcs", fixture("gcs/pubsub-pull-metadata-update.json"))
    ).toEqual([]);
  });

  test("an OBJECT_DELETE of a generation that was already noncurrent is skipped", async () => {
    const message = fixture("gcs/pubsub-pull-delete.json") as {
      attributes: Record<string, string>;
      data: string;
    };
    const resource = JSON.parse(atob(message.data)) as Record<string, unknown>;
    const deletedAt = Date.parse(resource.timeDeleted as string);
    const at = async (eventTime: number, eventType = "OBJECT_DELETE") =>
      typesOf(
        await parse("gcs", {
          ...message,
          attributes: {
            ...message.attributes,
            eventTime: new Date(eventTime).toISOString(),
            eventType,
          },
        })
      );
    // A lifecycle `numNewerVersions` cleanup, days after the generation
    // stopped being live: the key's live generation is untouched.
    expect(await at(deletedAt + 3 * 86_400_000)).toEqual([]);
    // A live object's delete stamps both with the same moment (give or take).
    expect(await at(deletedAt)).toEqual(["deleted"]);
    expect(await at(deletedAt + 5000)).toEqual(["deleted"]);
    // Archive is when it stops being live, whatever its payload says.
    expect(await at(deletedAt + 86_400_000, "OBJECT_ARCHIVE")).toEqual([
      "deleted",
    ]);
    // Without a payload, there's no telling: reported.
    const { data: _d, ...noData } = message;
    const bare = await parse("gcs", {
      ...noData,
      attributes: { ...message.attributes, eventTime: "2030-01-01T00:00:00Z" },
    });
    expect(typesOf(bare)).toEqual(["deleted"]);
    // Eventarc: the same check against the CloudEvent's time.
    const ce = {
      ...(fixture("gcs/eventarc-cloudevent-finalize-structured.json") as {
        data: object;
      }),
      type: "google.cloud.storage.object.v1.deleted",
    };
    const ceAt = async (time: string) =>
      typesOf(
        await parse("gcs", {
          ...ce,
          data: { ...ce.data, timeDeleted: "2020-09-29T11:32:00.000Z" },
          time,
        })
      );
    expect(await ceAt("2020-10-29T11:32:00.000Z")).toEqual([]);
    expect(await ceAt("2020-09-29T11:32:00.000Z")).toEqual(["deleted"]);
  });

  test("push wrappers, pulled batches and Buffer data", async () => {
    const expected = pick(
      await parse("gcs", fixture("gcs/pubsub-pull-finalize.json"))
    );
    expect(
      pick(await parse("gcs", fixture("gcs/pubsub-push-finalize.json")))
    ).toEqual(expected);
    expect(
      pick(
        await parse("gcs", {
          receivedMessages: [
            { ackId: "a", message: fixture("gcs/pubsub-pull-finalize.json") },
          ],
        })
      )
    ).toEqual(expected);
    const message = fixture("gcs/pubsub-pull-finalize.json") as {
      data: string;
    };
    const buffer = Uint8Array.from(
      atob(message.data),
      (c) => c.codePointAt(0) ?? 0
    );
    const files = filesAs("gcs");
    // The Node client library hands `data` over as a Buffer.
    expect(
      pick(await files.events.parse({ ...message, data: buffer }))
    ).toEqual(expected);
  });

  test("payloadFormat NONE: attributes alone", async () => {
    const { data: _data, ...noData } = fixture(
      "gcs/pubsub-pull-finalize.json"
    ) as { data: string };
    const [event] = await parse("gcs", noData);
    expect(event).toMatchObject({ key: "folder/Test.cs", type: "created" });
    expect(event?.size).toBeUndefined();
  });

  test("Eventarc binary mode over a Request, and structured mode", async () => {
    const req = new Request("https://app.test/hook", {
      body: JSON.stringify(fixture("gcs/eventarc-cloudevent-finalize.json")),
      headers: headersOf("gcs/eventarc-cloudevent-finalize.headers.json"),
      method: "POST",
    });
    const [binary] = await parse("gcs", req);
    expect(binary).toMatchObject({
      contentType: "text/plain",
      key: "folder/Test.cs",
      size: 352,
      type: "created",
    });
    const [structured] = await parse(
      "gcs",
      fixture("gcs/eventarc-cloudevent-finalize-structured.json")
    );
    expect(structured).toMatchObject({
      key: "folder/Test.cs",
      type: "created",
    });

    const deleted = new Request("https://app.test/hook", {
      body: JSON.stringify(fixture("gcs/eventarc-cloudevent-deleted.json")),
      headers: headersOf("gcs/eventarc-cloudevent-deleted.headers.json"),
      method: "POST",
    });
    const [fromHeaders] = await parse("gcs", deleted);
    expect(fromHeaders?.type).toBe("deleted");
  });

  test("a CloudEvent with no resource falls back to subject and source", async () => {
    const [event] = await parse("gcs", {
      id: "1",
      source: "//storage.googleapis.com/projects/_/buckets/b1",
      specversion: "1.0",
      subject: "objects/a/b.txt",
      time: "2020-09-29T11:32:00.123Z",
      type: "google.cloud.storage.object.v1.deleted",
    });
    expect(event).toMatchObject({ key: "a/b.txt", type: "deleted" });
  });

  test("archived and metadataUpdated CloudEvents parse to nothing", async () => {
    for (const suffix of ["archived", "metadataUpdated"]) {
      // oxlint-disable-next-line no-await-in-loop -- two cases
      const list = await parse("gcs", {
        ...(fixture(
          "gcs/eventarc-cloudevent-finalize-structured.json"
        ) as object),
        type: `google.cloud.storage.object.v1.${suffix}`,
      });
      expect(list).toEqual([]);
    }
  });

  test("malformed deliveries throw", async () => {
    await expect(parse("gcs", { foo: 1 })).rejects.toThrow(
      "no Pub/Sub attributes"
    );
    await expect(parse("gcs", { receivedMessages: [1] })).rejects.toThrow(
      "expected an object"
    );
    await expect(parse("gcs", { attributes: {} })).rejects.toThrow(
      "attributes without eventType"
    );
    await expect(
      parse("gcs", {
        attributes: { eventType: "OBJECT_FINALIZE", objectId: "k" },
        data: "!!!",
      })
    ).rejects.toThrow("not base64");
    await expect(
      parse("gcs", {
        attributes: { eventType: "OBJECT_FINALIZE", objectId: "k" },
        data: btoa("not json"),
      })
    ).rejects.toThrow("not a JSON object resource");
    await expect(
      parse("gcs", {
        specversion: "1.0",
        type: "google.cloud.storage.object.v1.finalized",
      })
    ).rejects.toThrow("without an object name");
  });
});

describe("azure", () => {
  test("Event Grid schema created / deleted", async () => {
    const [created] = await parse(
      "azure",
      fixture("azure/eventgrid-created.json")
    );
    expect(created).toMatchObject({
      contentType: "text/plain",
      etag: "0x8D4BCC2E4835CD0",
      id: "831e1650-001e-001b-66ab-eeb76e069631",
      key: "new-file.txt",
      size: 524_288,
      time: Date.parse("2017-06-26T18:41:00.958Z"),
      type: "created",
    });
    const [deleted] = await parse(
      "azure",
      fixture("azure/eventgrid-deleted.json")
    );
    expect(deleted?.type).toBe("deleted");
  });

  test("CloudEvents schema", async () => {
    expect(
      pick(await parse("azure", fixture("azure/cloudevents-created.json")))
    ).toEqual(
      pick(await parse("azure", fixture("azure/eventgrid-created.json")))
    );
    const [deleted] = await parse(
      "azure",
      fixture("azure/cloudevents-deleted.json")
    );
    expect(deleted).toMatchObject({
      key: "file-to-delete.txt",
      type: "deleted",
    });
  });

  test("an ADLS CreateFile (empty blob) parses to nothing", async () => {
    expect(
      await parse("azure", fixture("azure/eventgrid-created-adls.json"))
    ).toEqual([]);
  });

  test("a rename is a delete of the source and a create of the destination", async () => {
    const list = await parse("azure", fixture("azure/eventgrid-renamed.json"));
    expect(list.map(({ id, key, type }) => ({ id, key, type }))).toEqual([
      {
        id: "831e1650-001e-001b-66ab-eeb76e069631:source",
        key: "my-original-file.txt",
        type: "deleted",
      },
      {
        id: "831e1650-001e-001b-66ab-eeb76e069631:destination",
        key: "my-renamed-file.txt",
        type: "created",
      },
    ]);
  });

  test("other event types parse to nothing; validation events too", async () => {
    expect(
      await parse("azure", {
        data: {},
        eventType: "Microsoft.Storage.BlobTierChanged",
        subject: "/blobServices/default/containers/c/blobs/x",
      })
    ).toEqual([]);
    expect(
      await parse("azure", fixture("azure/subscription-validation.json"))
    ).toEqual([]);
  });

  test("an event with no id gets one from the sequencer", async () => {
    const [event] = (await parse("azure", {
      data: { api: "DeleteBlob", sequencer: "0001" },
      eventType: "Microsoft.Storage.BlobDeleted",
      subject: "blobServices/default/containers/c/blobs/a/b.txt",
    })) as FileEvent[];
    expect(event?.id).toBe("deleted:c/a/b.txt@0001");
    expect(event?.key).toBe("a/b.txt");
  });

  test("malformed deliveries throw", async () => {
    await expect(parse("azure", { data: {} })).rejects.toThrow(
      "without eventType"
    );
    await expect(
      parse("azure", {
        eventType: "Microsoft.Storage.BlobDeleted",
        subject: "/nope",
      })
    ).rejects.toThrow("not a blob path");
    await expect(
      parse("azure", {
        data: { api: "PutBlob" },
        eventType: "Microsoft.Storage.BlobCreated",
        subject: "/nope",
      })
    ).rejects.toThrow("not a blob path");
    await expect(
      parse("azure", {
        data: { sourceUrl: "not a url" },
        eventType: "Microsoft.Storage.BlobRenamed",
        subject: "/blobServices/default/containers/c/blobs/x",
      })
    ).rejects.toThrow("not a blob path");
    await expect(
      parse("azure", {
        data: { sourceUrl: 4 },
        eventType: "Microsoft.Storage.BlobRenamed",
        subject: "/blobServices/default/containers/c/blobs/x",
      })
    ).rejects.toThrow("not a blob path");
  });
});

describe("memory", () => {
  test("a replayed notification", async () => {
    const [event] = await parse("memory", {
      key: "a.txt",
      sequence: 7,
      size: 3,
      time: 5,
      type: "created",
    });
    expect(event).toMatchObject({
      id: "created:a.txt#7",
      key: "a.txt",
      size: 3,
    });
  });

  test("malformed notifications throw", async () => {
    await expect(parse("memory", { key: "a" })).rejects.toThrow(
      "expected key and sequence"
    );
    await expect(
      parse("memory", { key: "a", sequence: 1, type: "touched" })
    ).rejects.toThrow("unknown type");
  });
});

const supabaseDelete = (bucket: string) => ({
  old_record: {
    bucket_id: bucket,
    id: `u-${bucket}`,
    metadata: {},
    name: "user-1/profile.png",
    version: "v1",
  },
  record: null,
  schema: "storage",
  table: "objects",
  type: "DELETE",
});

const blobDeleted = (container: string) => ({
  eventTime: "2026-01-01T00:00:00Z",
  eventType: "Microsoft.Storage.BlobDeleted",
  id: container,
  subject: `/blobServices/default/containers/${container}/blobs/a.txt`,
});

describe("bucket and prefix mapping", () => {
  test("an instance prefix is stripped; keys outside it are dropped", async () => {
    const files = filesAs("s3", { prefix: "tenant-a" });
    const inside = await files.events.parse({
      Records: [
        {
          eventName: "ObjectCreated:Put",
          eventSource: "aws:s3",
          s3: { object: { key: "tenant-a/a.txt", sequencer: "1" } },
        },
      ],
    });
    expect(inside.map((e) => e.key)).toEqual(["a.txt"]);
    const outside = await files.events.parse({
      Records: [
        {
          eventName: "ObjectCreated:Put",
          eventSource: "aws:s3",
          s3: { object: { key: "tenant-b/a.txt" } },
        },
        {
          eventName: "ObjectCreated:Put",
          eventSource: "aws:s3",
          s3: { object: { key: "tenant-a/" } },
        },
      ],
    });
    expect(outside).toEqual([]);
  });

  test("the adapter's own bucket filters by default; events({ bucket: false }) turns it off", async () => {
    const avatars = createFiles({
      adapter: providerAdapter("supabase", { bucket: "avatars" }),
      plugins: [events()],
    });
    expect(await avatars.events.parse(supabaseDelete("originals"))).toEqual([]);
    const own = await avatars.events.parse(supabaseDelete("avatars"));
    expect(own.map((e) => e.key)).toEqual(["user-1/profile.png"]);
    const azure = createFiles({
      adapter: providerAdapter("azure", { bucket: "c1" }),
      plugins: [events()],
    });
    expect(await azure.events.parse(blobDeleted("other"))).toEqual([]);
    expect(await azure.events.parse(blobDeleted("c1"))).toHaveLength(1);
    // A delivery that names no bucket always passes.
    const s3Files = createFiles({
      adapter: providerAdapter("s3", { bucket: "uploads" }),
      plugins: [events()],
    });
    expect(await s3Files.events.parse(fixture("s3/lambda-put.json"))).toEqual(
      []
    );
    expect(
      await s3Files.events.parse({ Records: [s3RecordOf("no-bucket")] })
    ).toHaveLength(1);
    // Opt out, or name another bucket explicitly.
    const anyBucket = createFiles({
      adapter: providerAdapter("s3", { bucket: "uploads" }),
      plugins: [events({ bucket: false })],
    });
    expect(
      await anyBucket.events.parse(fixture("s3/lambda-put.json"))
    ).toHaveLength(1);
    const named = createFiles({
      adapter: providerAdapter("s3", { bucket: "uploads" }),
      plugins: [events({ bucket: "amzn-s3-demo-bucket" })],
    });
    expect(
      await named.events.parse(fixture("s3/lambda-put.json"))
    ).toHaveLength(1);
    // An empty or non-string `bucket` on the adapter isn't a filter.
    const blank = createFiles({
      adapter: providerAdapter("s3", { bucket: "" }),
      plugins: [events()],
    });
    expect(
      await blank.events.parse(fixture("s3/lambda-put.json"))
    ).toHaveLength(1);
  });

  test("events({ bucket }) drops other buckets' events", async () => {
    const files = createFiles({
      adapter: providerAdapter("s3"),
      plugins: [events({ bucket: "amzn-s3-demo-bucket" })],
    });
    expect(
      await files.events.parse(fixture("s3/lambda-put.json"))
    ).toHaveLength(1);
    expect(
      await files.events.parse(fixture("s3/eventbridge-created.json"))
    ).toEqual([]);
    expect(
      await files.events.parse({
        Records: [
          {
            eventName: "ObjectCreated:Put",
            eventSource: "aws:s3",
            s3: { object: { key: "no-bucket" } },
          },
        ],
      })
    ).toHaveLength(1);
  });
});

const r2Put = (eventTime: string) => ({
  action: "PutObject",
  bucket: "b",
  eventTime,
  object: { eTag: "abc", key: "a.txt", size: 3 },
});

describe("event ids never come from the clock", () => {
  const twice = async (
    name: string,
    input: unknown
  ): Promise<[string | undefined, string | undefined]> => {
    const [first] = await parse(name, input);
    await Bun.sleep(2);
    const [again] = await parse(name, structuredClone(input));
    return [first?.id, again?.id];
  };

  test("r2: a re-upload of the same bytes after a delete keeps its own id", async () => {
    const seen = new Set<string>();
    const handled: string[] = [];
    const files = createFiles({
      adapter: providerAdapter("r2"),
      plugins: [
        events({
          dedupe: {
            add: (id) => {
              seen.add(id);
            },
            has: (id) => seen.has(id),
          },
        }),
      ],
    });
    files.events.on("*", (e) => {
      handled.push(`${e.type}:${e.key}`);
    });
    const del = {
      action: "DeleteObject",
      bucket: "b",
      eventTime: "2026-01-01T00:01:00Z",
      object: { key: "a.txt" },
    };
    await files.events.dispatch(r2Put("2026-01-01T00:00:00Z"));
    await files.events.dispatch(del);
    await files.events.dispatch(r2Put("2026-01-01T00:02:00Z"));
    // A redelivery is still dropped.
    await files.events.dispatch(r2Put("2026-01-01T00:02:00Z"));
    expect(handled).toEqual([
      "created:a.txt",
      "deleted:a.txt",
      "created:a.txt",
    ]);
    expect([...seen][0]).toBe("created:b/a.txt@2026-01-01T00:00:00Z#abc");
    const [first, again] = await twice("r2", {
      action: "DeleteObject",
      object: { key: "a.txt" },
    });
    expect(first).toMatch(/^deleted:a\.txt@h:[0-9a-f]{16}$/u);
    expect(again).toBe(first as string);
  });

  test("s3: an EventBridge event without an id", async () => {
    const event = fixture("s3/eventbridge-created.json") as Record<
      string,
      unknown
    >;
    const { id: _id, ...noId } = event;
    const [first, again] = await twice("s3", noId);
    expect(first).toStartWith("created:example-key@");
    expect(again).toBe(first as string);
    const detail = noId.detail as { object: Record<string, unknown> };
    const [sequenced] = await parse("s3", {
      ...noId,
      detail: { ...detail, object: { ...detail.object, sequencer: "00ab" } },
    });
    expect(sequenced?.id).toBe("created:example-key@00ab");
  });

  test("gcs: no generation falls back to the event time, then a hash", async () => {
    const message = fixture("gcs/pubsub-pull-finalize.json") as {
      attributes: Record<string, string>;
    };
    const { objectGeneration: _g, ...attributes } = message.attributes;
    const [timed] = await parse("gcs", { ...message, attributes });
    expect(timed?.id).toBe(
      `OBJECT_FINALIZE:sample-bucket/folder/Test.cs#${attributes.eventTime}`
    );
    const { eventTime: _t, ...bare } = attributes;
    const [first, again] = await twice("gcs", {
      attributes: bare,
      messageId: "1",
    });
    expect(first).toMatch(/#h:[0-9a-f]{16}$/u);
    // A duplicate Pub/Sub message (new message id) for the same change.
    const [duplicate] = await parse("gcs", {
      attributes: bare,
      messageId: "2",
    });
    expect(duplicate?.id).toBe(first as string);
    expect(again).toBe(first as string);
    const [ce1, ce2] = await twice("gcs", {
      source: "//storage.googleapis.com/projects/_/buckets/b",
      specversion: "1.0",
      subject: "objects/a.txt",
      type: "google.cloud.storage.object.v1.deleted",
    });
    expect(ce1).toMatch(/^deleted:b\/a\.txt#h:/u);
    expect(ce2).toBe(ce1 as string);
    // No source: the identity hashed has an absent field.
    const [sourceless] = await parse("gcs", {
      specversion: "1.0",
      subject: "objects/a.txt",
      type: "google.cloud.storage.object.v1.deleted",
    });
    expect(sourceless?.id).toMatch(/^deleted:\/a\.txt#h:/u);
  });

  test("azure: no id or sequencer falls back to the event time, then a hash", async () => {
    const deleted = {
      eventType: "Microsoft.Storage.BlobDeleted",
      subject: "/blobServices/default/containers/c/blobs/a.txt",
    };
    const [timed] = await parse("azure", {
      ...deleted,
      eventTime: "2026-01-01T00:00:00.1234567Z",
    });
    expect(timed?.id).toBe("deleted:c/a.txt@2026-01-01T00:00:00.1234567Z");
    const [first, again] = await twice("azure", deleted);
    expect(first).toMatch(/^deleted:c\/a\.txt@h:/u);
    expect(again).toBe(first as string);
  });

  test("b2, tigris and cloudinary records without ids", async () => {
    const [b2First, b2Again] = await twice("backblaze-b2", {
      events: [{ eventType: "b2:ObjectCreated:Upload", objectName: "a.txt" }],
    });
    expect(b2First).toMatch(/^b2:ObjectCreated:Upload:a\.txt@h:/u);
    expect(b2Again).toBe(b2First as string);
    const [b2Stamped] = await parse("backblaze-b2", {
      events: [
        {
          eventTimestamp: 1_700_000_000_000,
          eventType: "b2:ObjectCreated:Upload",
          objectName: "a.txt",
          objectVersionId: "v1",
        },
      ],
    });
    expect(b2Stamped?.id).toBe(
      "b2:ObjectCreated:Upload:a.txt@v1#1700000000000"
    );
    const [tigrisFirst, tigrisAgain] = await twice("tigris", {
      events: [{ eventName: "OBJECT_DELETED", object: { key: "a.txt" } }],
    });
    expect(tigrisFirst).toMatch(/^OBJECT_DELETED:\/a\.txt@h:/u);
    expect(tigrisAgain).toBe(tigrisFirst as string);
    const [upload1, upload2] = await twice("cloudinary", {
      asset_id: "x",
      notification_type: "upload",
      public_id: "a",
      resource_type: "raw",
    });
    expect(upload1).toMatch(/^upload:x@h:/u);
    expect(upload2).toBe(upload1 as string);
    const [renamed] = await parse("cloudinary", {
      asset_id: "x",
      from_public_id: "a",
      notification_context: { triggered_at: "2026-01-01T00:00:00.123456Z" },
      notification_type: "rename",
      to_public_id: "b",
    });
    expect(renamed?.id).toBe("rename:x@2026-01-01T00:00:00.123456Z:from");
  });
});
