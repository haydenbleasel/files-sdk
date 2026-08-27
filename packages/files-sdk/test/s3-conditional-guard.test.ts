import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { FilesError } from "../src/index.js";
import { createS3Adapter } from "../src/s3/core.js";
import type { S3Adapter, S3Sdk } from "../src/s3/core.js";

// This file deliberately does NOT use aws-sdk-client-mock: that stubs
// `send`, so the middleware stack — where the header guard lives — never
// runs. Instead the client is real and its request handler is a fake that
// records what would have gone on the wire and answers with a canned
// response, so the serializer, our build-step guard, and signing all run.

interface SentRequest {
  headers: Record<string, string>;
  method: string;
  path: string;
}

const xml = (body: string) => Readable.from([Buffer.from(body)]);

const fakeHandler = (sent: SentRequest[]) => ({
  handle: (request: SentRequest) => {
    sent.push(request);
    return Promise.resolve({
      response: {
        body: xml(
          request.method === "PUT" && !request.headers["x-amz-copy-source"]
            ? ""
            : '<CopyObjectResult><ETag>"copied"</ETag></CopyObjectResult>'
        ),
        headers: { etag: '"committed"' },
        statusCode: 200,
      },
    });
  },
});

/**
 * Build the adapter over a real client. `strip` simulates an older
 * `@aws-sdk/client-s3` whose CopyObject model predates `IfMatch` /
 * `IfNoneMatch`: the input field is accepted but never serialized.
 */
const adapterOver = (
  sent: SentRequest[],
  strip?: string,
  simulate?: { endpoint?: string; conditional?: boolean }
): S3Adapter => {
  class TestClient extends S3Client {
    // aws-sdk-client-mock (used by s3.test.ts) stubs `S3Client.prototype.send`
    // for the whole process and never restores it, so reach past that own
    // property to the inherited, real `Client#send` — this file exists to run
    // the middleware stack, which the stub short-circuits.
    override send = (
      Object.getPrototypeOf(S3Client.prototype) as { send: S3Client["send"] }
    ).send;

    constructor(config: S3ClientConfig) {
      super({
        ...config,
        credentials: { accessKeyId: "AKIA", secretAccessKey: "secret" },
        // Stands in for a shared-config `endpoint_url`: the adapter never
        // saw an `endpoint` option, but the client resolves elsewhere.
        ...(simulate?.endpoint && { endpoint: simulate.endpoint }),
        requestHandler: fakeHandler(sent),
      });
      if (strip) {
        this.middlewareStack.add(
          (next) => (args) => {
            const request = args.request as { headers: Record<string, string> };
            Reflect.deleteProperty(request.headers, strip);
            return next(args);
          },
          { name: "simulateOldSdk", priority: "high", step: "build" }
        );
      }
    }
  }
  const sdk: S3Sdk = {
    clientS3: {
      AbortMultipartUploadCommand,
      CompleteMultipartUploadCommand,
      CopyObjectCommand,
      CreateMultipartUploadCommand,
      DeleteObjectCommand,
      DeleteObjectsCommand,
      GetObjectCommand,
      HeadObjectCommand,
      ListObjectsV2Command,
      ListPartsCommand,
      PutObjectCommand,
      S3Client: TestClient,
      UploadPartCommand,
    },
    presignedPost: { createPresignedPost },
    requestPresigner: { getSignedUrl },
  };
  return createS3Adapter(sdk, {
    bucket: "b",
    region: "us-east-1",
    ...(simulate?.conditional !== undefined && {
      conditional: simulate.conditional,
    }),
  });
};

const native = (
  adapter: S3Adapter
): Required<NonNullable<S3Adapter["conditional"]>> => {
  const {
    copy,
    create,
    delete: remove,
    exactRead,
    replace,
  } = adapter.conditional ?? {};
  if (!(copy && create && remove && exactRead && replace)) {
    throw new Error("expected native conditional primitives");
  }
  return { copy, create, delete: remove, exactRead, replace };
};

describe("s3 adapter — conditional header guard", () => {
  test("a current SDK serializes every predicate and the request goes out", async () => {
    const sent: SentRequest[] = [];
    const conditional = native(adapterOver(sent));

    await conditional.copy.run("from.txt", "to.txt", {
      destination: { type: "create" },
      source: { etag: "src" },
    });
    await conditional.create("new.txt", "body");
    await conditional.delete("old.txt", "gone");

    expect(sent).toHaveLength(3);
    const [copy, put, del] = sent as [SentRequest, SentRequest, SentRequest];
    expect(copy.headers["x-amz-copy-source-if-match"]).toBe('"src"');
    expect(copy.headers["if-none-match"]).toBe("*");
    expect(put.headers["if-none-match"]).toBe("*");
    expect(del.headers["if-match"]).toBe('"gone"');
  });

  test("an SDK that drops a conditional copy predicate fails closed before the request is sent", async () => {
    const sent: SentRequest[] = [];
    const conditional = native(adapterOver(sent, "if-none-match"));

    const failure = await conditional.copy
      .run("from.txt", "to.txt", {
        destination: { type: "create" },
        source: { etag: "src" },
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(FilesError);
    expect((failure as FilesError).code).toBe("Provider");
    expect((failure as FilesError).permanent).toBe(true);
    expect((failure as Error).message).toMatch(
      /did not serialize if-none-match/u
    );
    // Nothing reached the wire — no unconditional overwrite happened.
    expect(sent).toHaveLength(0);
  });

  test("the guard covers the source predicate and the single-object primitives too", async () => {
    const copySent: SentRequest[] = [];
    await expect(
      native(adapterOver(copySent, "x-amz-copy-source-if-match")).copy.run(
        "from.txt",
        "to.txt",
        {
          destination: { etag: "dst", type: "replace" },
          source: { etag: "src" },
        }
      )
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(copySent).toHaveLength(0);

    const putSent: SentRequest[] = [];
    await expect(
      native(adapterOver(putSent, "if-match")).replace("k", "body", "old")
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(putSent).toHaveLength(0);
  });

  test("ordinary requests are untouched by the guard", async () => {
    const sent: SentRequest[] = [];
    const adapter = adapterOver(sent, "if-match");
    await adapter.copy("from.txt", "to.txt");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["if-match"]).toBeUndefined();
  });

  test("a shared-config endpoint_url that resolves off AWS fails closed at request time", async () => {
    const sent: SentRequest[] = [];
    // The constructor gate still exposes the primitives (no `endpoint`, no
    // env redirect), so this is exactly the gap a profile `endpoint_url`
    // opens — closed by the resolved hostname on the built request.
    const adapter = adapterOver(sent, undefined, {
      endpoint: "http://localhost:9000",
    });
    const conditional = native(adapter);
    const failure = await conditional
      .create("k", "body")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FilesError);
    expect((failure as FilesError).permanent).toBe(true);
    expect((failure as Error).message).toMatch(
      /only sent to AWS S3.*localhost.*conditional: true/u
    );
    expect(sent).toHaveLength(0);
    // Ordinary traffic to that endpoint is unaffected.
    await adapter.copy("from.txt", "to.txt");
    expect(sent).toHaveLength(1);
  });

  test("conditional: true opts a verified S3-compatible endpoint in", async () => {
    const sent: SentRequest[] = [];
    const conditional = native(
      adapterOver(sent, undefined, {
        conditional: true,
        endpoint: "http://localhost:9000",
      })
    );
    await conditional.create("k", "body");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers["if-none-match"]).toBe("*");
  });

  test("AWS-hosted endpoints — VPC, FIPS, dual-stack, GovCloud — pass the hostname check", async () => {
    const hosts = [
      "https://bucket.vpce-0a1b2c.s3.us-east-1.vpce.amazonaws.com",
      "https://s3-fips.us-gov-west-1.amazonaws.com",
      "https://s3.dualstack.us-east-1.amazonaws.com",
      "https://s3.cn-north-1.amazonaws.com.cn",
    ];
    for (const endpoint of hosts) {
      const sent: SentRequest[] = [];
      // eslint-disable-next-line no-await-in-loop -- each host is an independent case
      await native(adapterOver(sent, undefined, { endpoint })).delete(
        "k",
        "etag"
      );
      expect(sent).toHaveLength(1);
    }
  });
});
