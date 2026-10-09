// oxlint-disable unicorn/no-await-expression-member -- asserting fields off awaited Responses is the natural shape here.
import {
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { timingSafeEqual } from "../src/events/crypto.js";
import { events } from "../src/events/index.js";
import type { EventsOptions, GoogleOidcOptions } from "../src/events/index.js";
import type { FileEvent, FilesPlugin } from "../src/index.js";
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

afterEach(() => {
  mock.restore();
});

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

const withTiering = (opts: EventsOptions) =>
  createFiles({
    adapter: providerAdapter("s3"),
    plugins: [
      events(opts),
      tiering({ cold: memory(), fallback: true, route: () => "hot" }),
    ],
    prefix: "app",
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
    expect(() =>
      filesAs("backblaze-b2").events.webhook({ verify: { secret: "" } })
    ).toThrow("verify.secret must be a non-empty secret");
  });

  test("an adapter with no format fails at construction", () => {
    expect(() =>
      filesAs("vercel-blob").events.webhook({ verify: false })
    ).toThrow("has no notification format");
  });

  test("a plugin that refuses provider events fails at construction", () => {
    // tiering({ fallback: true }) turns the adapter's format off...
    expect(() => withTiering({}).events.webhook({ verify: false })).toThrow(
      "has no notification format on this instance: a plugin turned provider events off"
    );
    // ...and refuses provider events when one is forced.
    expect(() =>
      withTiering({ format: "s3" }).events.webhook({ verify: false })
    ).toThrow("fallback: true");
  });

  test("the error for a missing format lists every format", () => {
    expect(() =>
      filesAs("vercel-blob").events.webhook({ verify: false })
    ).toThrow(
      "pass a `format` (appwrite, azure, b2, box, cloudinary, gcs, memory, r2, s3, supabase, tigris)"
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
    const reported: unknown[] = [];
    const files = filesAs("minio", {
      onError: (cause) => {
        reported.push(cause);
      },
    });
    const hook = files.events.webhook({ verify: false });
    expect((await hook.handle(post("{not json"))).status).toBe(400);
    const bad = await hook.handle(post('{"x":1}'));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("not a s3 notification");
    files.events.on("*", () => {
      throw new Error("db password=hunter2");
    });
    const res = await hook.handle(post(s3Body));
    expect(res.status).toBe(500);
    // The handler's message stays out of the response; onError has it.
    expect(await res.json()).toEqual({
      error: { message: "files-sdk/events: a handler failed" },
    });
    expect(String(reported[0])).toContain("hunter2");
  });

  test("an unexpected failure is a generic 500, reported to onError", async () => {
    const reported: string[] = [];
    const onError = (cause: unknown, req: Request) => {
      reported.push(`${new URL(req.url).pathname}: ${String(cause)}`);
    };
    // A plugin hook that throws a plain error while mapping a delivery.
    const boom: FilesPlugin = {
      event: (event) => {
        if (event.key !== "probe") {
          throw new Error("internal detail");
        }
        return event;
      },
      name: "boom",
    };
    const files = createFiles({
      adapter: providerAdapter("minio"),
      plugins: [events(), boom],
    });
    const hook = files.events.webhook({ onError, verify: false });
    const mapped = await hook.handle(post(s3Body));
    expect(mapped.status).toBe(500);
    expect(await mapped.json()).toEqual({
      error: { message: "files-sdk/events: the delivery failed" },
    });
    // A dedupe store that's down: not a handler failure, so it's reported.
    const store = filesAs("minio", {
      dedupe: {
        add: () => {},
        has: () => {
          throw new Error("redis down");
        },
      },
    });
    const deduped = await store.events
      .webhook({ onError, verify: false })
      .handle(post(s3Body));
    expect(deduped.status).toBe(500);
    // A JWKS that isn't JSON fails while authenticating.
    const garbled = filesAs("gcs").events.webhook({
      onError,
      verify: {
        google: {
          audience: URL_,
          email: "push@p.iam.gserviceaccount.com",
          fetch: (() =>
            Promise.resolve(new Response("<html>"))) as unknown as typeof fetch,
        },
      },
    });
    const token = `${btoa(JSON.stringify({ alg: "RS256", kid: "k" }))}.e30.sig`;
    const auth = await garbled.handle(
      post("{}", { authorization: `Bearer ${token}` })
    );
    expect(auth.status).toBe(500);
    expect(await auth.text()).not.toContain("html");
    expect(reported).toEqual([
      "/hooks/storage: Error: internal detail",
      "/hooks/storage: Error: redis down",
      expect.stringContaining("/hooks/storage: SyntaxError"),
    ]);
  });

  test("the default onError logs; a throwing onError is contained", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    const failing = filesAs("minio", {
      dedupe: {
        add: () => {},
        has: () => {
          throw new Error("redis down");
        },
      },
    });
    const logged = await failing.events
      .webhook({ verify: false })
      .handle(post(s3Body));
    expect(logged.status).toBe(500);
    expect(String(error.mock.calls[0]?.[0])).toContain(
      "webhook delivery to /hooks/storage failed"
    );
    const throwing = await failing.events
      .webhook({
        onError: () => {
          throw new Error("reporter down");
        },
        verify: false,
      })
      .handle(post(s3Body));
    expect(throwing.status).toBe(500);
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

  test("an unreachable key server is a 502, so the provider redelivers", async () => {
    const hook = filesAs("gcs").events.webhook({
      verify: {
        google: {
          audience: URL_,
          email: "push@p.iam.gserviceaccount.com",
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
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("fetching Google's signing keys failed");
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
    jwks: () => object = () => ({ keys: [{ ...jwk, kid: "k1" }] }),
    now: () => number = () => NOW
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
          now,
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

  test("an unknown key id refetches (key rotation), at most once a minute", async () => {
    let rotated = false;
    let clock = NOW;
    const { fetchJwks, hook } = setup(
      () =>
        rotated
          ? { keys: [{ ...jwk, kid: "k2" }, { kid: "ec", kty: "EC" }, "junk"] }
          : { keys: [{ ...jwk, kid: "k1" }] },
      () => clock
    );
    const withKid = async (kid: string) =>
      hook.handle(
        post(push, {
          authorization: `Bearer ${await sign(valid(), { kid })}`,
        })
      );
    expect((await withKid("k1")).status).toBe(200);
    rotated = true;
    // Within a minute of the last fetch, an unknown id doesn't refetch.
    const early = await withKid("k2");
    expect(early.status).toBe(401);
    expect(await early.text()).toContain("unknown key");
    expect(fetchJwks).toHaveBeenCalledTimes(1);
    clock += 61_000;
    expect((await withKid("k2")).status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    // A flood of made-up ids costs nothing more until the minute is up.
    for (const kid of ["k9", "k10", "k11"]) {
      // oxlint-disable-next-line no-await-in-loop -- one after the other
      expect((await withKid(kid)).status).toBe(401);
    }
    expect(fetchJwks).toHaveBeenCalledTimes(2);
    // After an hour the keys are refetched even for a known id.
    clock += 3_600_000;
    expect((await withKid("k2")).status).toBe(200);
    expect(fetchJwks).toHaveBeenCalledTimes(3);
  });

  test("concurrent deliveries share one key fetch", async () => {
    const { fetchJwks, hook } = setup();
    const token = await sign(valid());
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        hook.handle(post(push, { authorization: `Bearer ${token}` }))
      )
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(fetchJwks).toHaveBeenCalledTimes(1);
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

  test("an array audience passes; a token with no email doesn't", async () => {
    const { hook } = setup();
    const array = await hook.handle(
      post(push, {
        authorization: `Bearer ${await sign({ ...valid(), aud: [AUDIENCE] })}`,
      })
    );
    expect(array.status).toBe(200);
    const { email: _e, ...noEmail } = valid();
    const anyone = await hook.handle(
      post(push, { authorization: `Bearer ${await sign(noEmail)}` })
    );
    expect(anyone.status).toBe(401);
    expect(await anyone.text()).toContain("another service account");
  });

  test("an audience and a service account are both required", () => {
    const files = filesAs("gcs");
    for (const [google, message] of [
      [{ audience: AUDIENCE }, "verify.google.email must be"],
      [{ audience: AUDIENCE, email: "" }, "verify.google.email must be"],
      [{ email: EMAIL }, "verify.google.audience must be"],
      [{ audience: "", email: EMAIL }, "verify.google.audience must be"],
    ] as const) {
      expect(() =>
        files.events.webhook({
          verify: { google: google as unknown as GoogleOidcOptions },
        })
      ).toThrow(message);
    }
  });

  test("a failing JWKS fetch is a 502", async () => {
    const hook = filesAs("gcs").events.webhook({
      verify: {
        google: {
          audience: AUDIENCE,
          email: EMAIL,
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
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("signing keys failed (503)");
  });

  test("the default fetch and clock are used when none are given", () => {
    const hook = filesAs("gcs").events.webhook({
      verify: { google: { audience: AUDIENCE, email: EMAIL } },
    });
    expect(hook.handle).toBeFunction();
  });
});
