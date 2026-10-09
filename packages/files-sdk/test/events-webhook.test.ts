// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited Responses is the natural shape here.
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { timingSafeEqual } from "../src/events/crypto.js";
import { events } from "../src/events/index.js";
import type { EventsOptions } from "../src/events/index.js";
import type { FileEvent } from "../src/index.js";
import { createFiles } from "../src/index.js";
import { memory } from "../src/memory/index.js";
import { createRouteHandler } from "../src/next/index.js";
import { tiering } from "../src/tiering/index.js";
import { providerAdapter } from "./events-helper.js";

const FIXTURES = path.join(import.meta.dir, "fixtures", "events");
const fixtureText = (name: string): string =>
  readFileSync(path.join(FIXTURES, name), "utf-8");
const headersOf = (name: string): Record<string, string> =>
  JSON.parse(fixtureText(name)) as Record<string, string>;

const URL_ = "https://app.test/hooks/storage";

const filesAs = (name: string, opts: EventsOptions = {}) =>
  createFiles({
    adapter: providerAdapter(name),
    plugins: [events(opts)],
  });

const post = (
  body: string,
  headers: Record<string, string> = {},
  url = URL_
): Request =>
  new Request(url, {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

const s3Body = JSON.stringify({
  Records: [
    {
      eventName: "s3:ObjectCreated:Put",
      eventSource: "minio:s3",
      s3: { object: { key: "a.txt", sequencer: "1", size: 1 } },
    },
  ],
});

describe("webhook() construction", () => {
  test("verify is required", () => {
    const files = filesAs("minio");
    expect(() =>
      // @ts-expect-error — verify is required
      files.events.webhook({})
    ).toThrow("pass `verify`");
    expect(() => files.events.webhook({ verify: { token: "" } })).toThrow(
      "non-empty secret"
    );
  });

  test("an adapter with no format fails at construction", () => {
    expect(() =>
      filesAs("vercel-blob").events.webhook({ verify: false })
    ).toThrow("has no notification format");
  });

  test("a plugin that refuses provider events fails at construction", () => {
    const files = createFiles({
      adapter: providerAdapter("s3"),
      plugins: [
        events(),
        tiering({ cold: memory(), fallback: true, route: () => "hot" }),
      ],
      prefix: "app",
    });
    expect(() => files.events.webhook({ verify: false })).toThrow(
      "fallback: true"
    );
  });
});

describe("token verification", () => {
  const setup = () => {
    const files = filesAs("minio");
    const seen: FileEvent[] = [];
    files.events.on("*", (e) => {
      seen.push(e);
    });
    return {
      hook: files.events.webhook({ verify: { token: "s3cret" } }),
      seen,
    };
  };

  test("MinIO's Authorization: Bearer header", async () => {
    const { hook, seen } = setup();
    const res = await hook.handle(
      post(s3Body, { authorization: "Bearer s3cret" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 1 });
    expect(seen.map((e) => e.key)).toEqual(["a.txt"]);
  });

  test("a verbatim header and a ?token= query param", async () => {
    const { hook } = setup();
    expect(
      (await hook.handle(post(s3Body, { authorization: "s3cret" }))).status
    ).toBe(200);
    expect(
      (await hook.handle(post(s3Body, {}, `${URL_}?token=s3cret`))).status
    ).toBe(200);
  });

  test("a missing or wrong token is a 401 and runs nothing", async () => {
    const { hook, seen } = setup();
    const cases: Record<string, string>[] = [
      {},
      { authorization: "Bearer nope" },
    ];
    for (const headers of cases) {
      // oxlint-disable-next-line no-await-in-loop -- two cases
      const res = await hook.handle(post(s3Body, headers));
      expect(res.status).toBe(401);
    }
    expect(seen).toEqual([]);
  });

  test("timingSafeEqual", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "ab")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("a", "")).toBe(false);
  });
});

describe("status codes", () => {
  test("400 on a malformed delivery, 500 when a handler throws", async () => {
    const files = filesAs("minio", { onError: () => {} });
    const hook = files.events.webhook({ verify: false });
    expect((await hook.handle(post("{not json"))).status).toBe(400);
    expect((await hook.handle(post('{"x":1}'))).status).toBe(400);
    files.events.on("*", () => {
      throw new Error("db down");
    });
    const res = await hook.handle(post(s3Body));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { message: "files-sdk/events: a handler failed: db down" },
    });
  });

  test("405 for other methods; 204 for a plain OPTIONS; 200 for HEAD", async () => {
    const hook = filesAs("minio").events.webhook({ verify: { token: "t" } });
    const head = await hook.handle(new Request(URL_, { method: "HEAD" }));
    expect(head.status).toBe(200);
    const get = await hook.handle(new Request(URL_));
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    const options = await hook.handle(
      new Request(`${URL_}?token=t`, { method: "OPTIONS" })
    );
    expect(options.status).toBe(204);
  });

  test("a non-Unauthorized verification failure is a 500", async () => {
    const hook = filesAs("gcs").events.webhook({
      verify: {
        google: {
          audience: URL_,
          fetch: (() =>
            Promise.reject(
              new Error("network down")
            )) as unknown as typeof fetch,
        },
      },
    });
    const token = `${btoa(JSON.stringify({ alg: "RS256", kid: "k" }))}.e30.sig`;
    const res = await hook.handle(
      post("{}", { authorization: `Bearer ${token}` })
    );
    expect(res.status).toBe(500);
  });

  test("mounts through a gateway binding", async () => {
    const files = filesAs("minio");
    const { POST } = createRouteHandler(
      files.events.webhook({ verify: false })
    );
    expect((await POST(post(s3Body))).status).toBe(200);
  });
});

describe("Azure Event Grid handshakes", () => {
  test("subscription validation echoes the code", async () => {
    const files = filesAs("azure");
    const handler = mock();
    files.events.on("*", handler);
    const hook = files.events.webhook({ verify: { token: "t" } });
    const res = await hook.handle(
      post(
        fixtureText("azure/subscription-validation.json"),
        headersOf("azure/subscription-validation.headers.json"),
        `${URL_}?token=t`
      )
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(
      JSON.parse(fixtureText("azure/subscription-validation.response.json"))
    );
    expect(handler).not.toHaveBeenCalled();
  });

  test("the CloudEvents OPTIONS handshake echoes the origin", async () => {
    const hook = filesAs("azure").events.webhook({ verify: { token: "t" } });
    const res = await hook.handle(
      new Request(`${URL_}?token=t`, {
        headers: headersOf("azure/cloudevents-options-handshake.headers.json"),
        method: "OPTIONS",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("webhook-allowed-origin")).toBe(
      "eventemitter.example.com"
    );
    expect(res.headers.get("webhook-allowed-rate")).toBe("*");
  });

  test("a notification is dispatched", async () => {
    const files = filesAs("azure");
    const seen: FileEvent[] = [];
    files.events.on("*", (e) => {
      seen.push(e);
    });
    const hook = files.events.webhook({ verify: false });
    const res = await hook.handle(
      post(
        fixtureText("azure/cloudevents-created.json"),
        headersOf("azure/cloudevents-created.headers.json")
      )
    );
    expect(res.status).toBe(200);
    expect(seen.map((e) => e.key)).toEqual(["new-file.txt"]);
  });
});

const b64url = (bytes: Uint8Array | string): string => {
  const raw =
    typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const byte of raw) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
};

const generate = () =>
  crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );

describe("Google OIDC verification", () => {
  const AUDIENCE = URL_;
  const EMAIL = "push@project.iam.gserviceaccount.com";
  const NOW = 1_700_000_000_000;
  let privateKey: CryptoKey;
  let jwk: JsonWebKey;
  let other: CryptoKey;

  const sign = async (
    claims: Record<string, unknown>,
    opts: { kid?: string; alg?: string; key?: CryptoKey } = {}
  ): Promise<string> => {
    const head = b64url(
      JSON.stringify({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })
    );
    const payload = b64url(JSON.stringify(claims));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        opts.key ?? privateKey,
        new TextEncoder().encode(`${head}.${payload}`)
      )
    );
    return `${head}.${payload}.${b64url(signature)}`;
  };

  const valid = () => ({
    aud: AUDIENCE,
    email: EMAIL,
    email_verified: true,
    exp: NOW / 1000 + 3600,
    iat: NOW / 1000,
    iss: "https://accounts.google.com",
  });

  beforeAll(async () => {
    const pair = await generate();
    ({ privateKey } = pair);
    jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    other = (await generate()).privateKey;
  });

  const setup = (
    jwks: () => object = () => ({ keys: [{ ...jwk, kid: "k1" }] })
  ) => {
    const fetchJwks = mock((_url: string) =>
      Promise.resolve(Response.json(jwks()))
    );
    const files = filesAs("gcs");
    const seen: FileEvent[] = [];
    files.events.on("*", (e) => {
      seen.push(e);
    });
    const hook = files.events.webhook({
      verify: {
        google: {
          audience: AUDIENCE,
          email: EMAIL,
          fetch: fetchJwks as unknown as typeof fetch,
          now: () => NOW,
        },
      },
    });
    return { fetchJwks, hook, seen };
  };

  const push = fixtureText("gcs/pubsub-push-finalize.json");

  test("a valid token is accepted, and the JWKS is cached", async () => {
    const { fetchJwks, hook, seen } = setup();
    for (let i = 0; i < 2; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- two deliveries, one after the other
      const token = await sign(valid());
      // oxlint-disable-next-line no-await-in-loop -- two deliveries, one after the other
      const res = await hook.handle(
        post(push, { authorization: `Bearer ${token}` })
      );
      expect(res.status).toBe(200);
    }
    expect(seen.map((e) => e.key)).toEqual([
      "folder/Test.cs",
      "folder/Test.cs",
    ]);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    expect(fetchJwks.mock.calls[0]?.[0]).toBe(
      "https://www.googleapis.com/oauth2/v3/certs"
    );
  });

  test("an unknown key id refetches once (key rotation)", async () => {
    let rotated = false;
    const { fetchJwks, hook } = setup(() =>
      rotated
        ? { keys: [{ ...jwk, kid: "k2" }, { kid: "ec", kty: "EC" }, "junk"] }
        : { keys: [{ ...jwk, kid: "k1" }] }
    );
    await hook.handle(
      post(push, { authorization: `Bearer ${await sign(valid())}` })
    );
    rotated = true;
    const res = await hook.handle(
      post(push, {
        authorization: `Bearer ${await sign(valid(), { kid: "k2" })}`,
      })
    );
    expect(res.status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    const unknown = await hook.handle(
      post(push, {
        authorization: `Bearer ${await sign(valid(), { kid: "k9" })}`,
      })
    );
    expect(unknown.status).toBe(401);
    expect(await unknown.text()).toContain("unknown key");
  });

  test.each([
    ["no header", "", "missing Google OIDC bearer token"],
    ["not a JWT", "Bearer abc", "malformed OIDC token"],
    ["garbage segments", "Bearer a.b.c", "malformed OIDC token"],
  ])("%s → 401", async (_name, authorization, message) => {
    const { hook } = setup();
    const headers: Record<string, string> = authorization
      ? { authorization }
      : {};
    const res = await hook.handle(post(push, headers));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(message);
  });

  test.each([
    ["an HS256 token", () => sign(valid(), { alg: "HS256" }), "not RS256"],
    [
      "a wrong signature",
      () => sign(valid(), { key: other }),
      "signature is invalid",
    ],
    [
      "another issuer",
      () => sign({ ...valid(), iss: "https://evil.example" }),
      "not issued by Google",
    ],
    [
      "another audience",
      () => sign({ ...valid(), aud: "https://other" }),
      "audience",
    ],
    [
      "an expired token",
      () => sign({ ...valid(), exp: NOW / 1000 - 3600 }),
      "expired",
    ],
    [
      "a future token",
      () => sign({ ...valid(), iat: NOW / 1000 + 3600 }),
      "not valid yet",
    ],
    [
      "another account",
      () => sign({ ...valid(), email: "x@y.z" }),
      "another service account",
    ],
    [
      "an unverified email",
      () => sign({ ...valid(), email_verified: false }),
      "another service account",
    ],
  ])("%s → 401", async (_name, token, message) => {
    const { hook, seen } = setup();
    const res = await hook.handle(
      post(push, { authorization: `Bearer ${await token()}` })
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain(message);
    expect(seen).toEqual([]);
  });

  test("an array audience; no email check when none is configured", async () => {
    const fetchJwks = mock(() =>
      Promise.resolve(Response.json({ keys: [{ ...jwk, kid: "k1" }] }))
    );
    const hook = filesAs("gcs").events.webhook({
      verify: {
        google: {
          audience: AUDIENCE,
          fetch: fetchJwks as unknown as typeof fetch,
          now: () => NOW,
        },
      },
    });
    const { email: _e, ...noEmail } = valid();
    const res = await hook.handle(
      post(push, {
        authorization: `Bearer ${await sign({ ...noEmail, aud: [AUDIENCE] })}`,
      })
    );
    expect(res.status).toBe(200);
  });

  test("a failing JWKS fetch is a 500", async () => {
    const hook = filesAs("gcs").events.webhook({
      verify: {
        google: {
          audience: AUDIENCE,
          fetch: (() =>
            Promise.resolve(
              new Response("nope", { status: 503 })
            )) as unknown as typeof fetch,
          now: () => NOW,
        },
      },
    });
    const res = await hook.handle(
      post(push, { authorization: `Bearer ${await sign(valid())}` })
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("signing keys failed (503)");
  });

  test("the default fetch and clock are used when none are given", () => {
    const hook = filesAs("gcs").events.webhook({
      verify: { google: { audience: AUDIENCE } },
    });
    expect(hook.handle).toBeFunction();
  });
});
