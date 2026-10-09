// Each format's parser, driven by payloads captured from the provider's docs
// (see test/fixtures/events/*/SOURCES.md for where each one came from).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { events, formatForAdapter } from "../src/events/index.js";
import type { EventFormat } from "../src/events/index.js";
import type { Adapter, FileEvent } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";

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
    adapter: { ...memory(), name } as Adapter,
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

describe("formatForAdapter", () => {
  test.each([
    ["s3", "s3"],
    ["s3-fetch", "s3"],
    ["bun-s3", "s3"],
    ["minio", "s3"],
    ["minio-fetch", "s3"],
    ["rustfs", "s3"],
    ["rustfs-fetch", "s3"],
    ["wasabi", "s3"],
    ["r2", "r2"],
    ["r2-http", "r2"],
    ["r2-http-fetch", "r2"],
    ["r2-binding", "r2"],
    ["gcs", "gcs"],
    ["firebase-storage", "gcs"],
    ["azure", "azure"],
    ["memory", "memory"],
  ] as [string, EventFormat][])("%s → %s", (name, format) => {
    expect(formatForAdapter(name)).toBe(format);
  });

  test("an adapter with no verified notification format has none", () => {
    expect(formatForAdapter("vercel-blob")).toBeUndefined();
    expect(formatForAdapter("digitalocean-spaces")).toBeUndefined();
    expect(formatForAdapter("storj")).toBeUndefined();
  });
});

describe("s3", () => {
  test("a Lambda S3 event", async () => {
    const [event] = await parse("s3", fixture("s3/lambda-put.json"));
    expect(event).toMatchObject({
      etag: "d41d8cd98f00b204e9800998ecf8427e",
      id: "created:HappyFace.jpg@0055AED6DCD90281E5",
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
    const [rustfs] = await parse(
      "rustfs",
      fixture("s3-compatible/rustfs-webhook.json")
    );
    expect(rustfs).toMatchObject({ key: "uploads/hello.dat", type: "created" });
    const wasabi = fixture("s3-compatible/wasabi-sns-message.json");
    const [direct] = await parse("wasabi", wasabi);
    expect(direct).toMatchObject({
      key: "heart.jpg",
      size: 9061,
      type: "created",
    });
    const viaSns = await parse("wasabi", {
      Message: JSON.stringify(wasabi),
      TopicArn: "arn:aws:sns:us-east-1:123456789012:wasabi",
      Type: "Notification",
    });
    expect(viaSns.map((e) => e.key)).toEqual(["heart.jpg"]);
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
    const base = fixture("s3/lambda-put.json") as {
      Records: { eventName: string }[];
    };
    const record = { ...base.Records[0], eventName };
    const list = await parse("s3", { Records: [record] });
    expect(list[0]?.type).toBe(type as FileEvent["type"]);
  });

  test("an id falls back from sequencer to versionId to etag", async () => {
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
      "created:HappyFace.jpg@096fKKXTRTtl3on89fVO.nfljtsv6qko"
    );
  });

  test("malformed deliveries throw", async () => {
    await expect(parse("s3", { hello: "world" })).rejects.toThrow(
      "not a s3 notification"
    );
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

  test("events({ bucket }) drops other buckets' events", async () => {
    const files = createFiles({
      adapter: { ...memory(), name: "s3" } as Adapter,
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
