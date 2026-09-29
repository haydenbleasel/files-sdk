import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { AuthenticationError, ClientSecretCredential } from "@azure/identity";
import type { AuthenticationProvider } from "@microsoft/microsoft-graph-client";
import { Client } from "@microsoft/microsoft-graph-client";

import { mapGraphError, onedrive } from "../src/onedrive/index.js";

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

// Module-level mocking via mock.module is awkward here because the adapter
// imports ClientSecretCredential and Client from real packages and we need
// the real GraphError + ResponseType to remain intact for the sibling
// onedrive.test.ts. Monkey-patching the static methods we need to intercept
// is simpler, fully scoped to this file's lifecycle, and keeps the rest of
// each module untouched.

const fakeGraphClient = {
  api: () => ({
    get: () => Promise.resolve({}),
  }),
};

let capturedAuthProvider: AuthenticationProvider | undefined;

const originalInitWithMiddleware = Client.initWithMiddleware;
const originalCsGetToken = ClientSecretCredential.prototype.getToken;
const originalFetch = globalThis.fetch;

const getTokenStub = function getTokenStub(this: { tenantId?: string }) {
  return Promise.resolve({
    expiresOnTimestamp: Date.now() + 3_600_000,
    // tenantId is the only public field on ClientSecretCredential; clientId
    // is private. The assertion in the test only inspects the prefix +
    // tenant to confirm wiring.
    token: `cs-token:${this.tenantId ?? "unknown"}`,
  });
};

beforeAll(() => {
  // Replace Client.initWithMiddleware so adapter construction never hits
  // the network and we capture the authProvider the adapter built.
  (Client as unknown as { initWithMiddleware: unknown }).initWithMiddleware =
    (opts: { authProvider?: AuthenticationProvider }) => {
      capturedAuthProvider = opts.authProvider;
      return fakeGraphClient;
    };
  // Stub ClientSecretCredential.getToken to return a deterministic token
  // tagged with the tenant + clientId so the test can assert wiring.
  (
    ClientSecretCredential.prototype as unknown as {
      getToken: (this: { tenantId?: string }) => unknown;
    }
  ).getToken = getTokenStub;
});

afterAll(() => {
  (Client as unknown as { initWithMiddleware: unknown }).initWithMiddleware =
    originalInitWithMiddleware;
  (
    ClientSecretCredential.prototype as unknown as { getToken: unknown }
  ).getToken = originalCsGetToken;
});

beforeEach(() => {
  capturedAuthProvider = undefined;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("onedrive auth construction", () => {
  test("accessToken (string) returns the token verbatim", async () => {
    onedrive({ accessToken: "tok-static", driveId: "d1" });
    expect(capturedAuthProvider).toBeDefined();
    expect(await capturedAuthProvider?.getAccessToken()).toBe("tok-static");
  });

  test("accessToken (function) is awaited on each call", async () => {
    let n = 0;
    onedrive({
      accessToken: () => {
        n += 1;
        return Promise.resolve(`tok-${n}`);
      },
      driveId: "d1",
    });
    expect(await capturedAuthProvider?.getAccessToken()).toBe("tok-1");
    expect(await capturedAuthProvider?.getAccessToken()).toBe("tok-2");
    expect(n).toBe(2);
  });

  test("accessToken (sync function) is supported", async () => {
    onedrive({
      accessToken: () => "sync-tok",
      driveId: "d1",
    });
    expect(await capturedAuthProvider?.getAccessToken()).toBe("sync-tok");
  });

  test("clientCredentials wires ClientSecretCredential through to the auth provider", async () => {
    onedrive({
      clientCredentials: {
        clientId: "c",
        clientSecret: "s",
        tenantId: "tenant-1",
      },
      driveId: "d1",
    });
    expect(capturedAuthProvider).toBeDefined();
    expect(await capturedAuthProvider?.getAccessToken()).toBe(
      "cs-token:tenant-1"
    );
  });

  test("oauth refresh-token mints a token via the v2 token endpoint", async () => {
    const fetchMock = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe(
          "https://login.microsoftonline.com/tenant-x/oauth2/v2.0/token"
        );
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt-1");
        expect(body.get("client_id")).toBe("cid-1");
        expect(body.get("client_secret")).toBe("cs-1");
        expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
        return Promise.resolve(
          Response.json(
            {
              access_token: "minted-tok",
              expires_in: 3600,
              token_type: "Bearer",
            },
            { headers: { "Content-Type": "application/json" }, status: 200 }
          )
        );
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    onedrive({
      oauth: {
        clientId: "cid-1",
        clientSecret: "cs-1",
        refreshToken: "rt-1",
        tenantId: "tenant-x",
      },
    });
    expect(await capturedAuthProvider?.getAccessToken()).toBe("minted-tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("oauth refresh-token defaults tenantId to 'common'", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = ((input: string | URL | Request) => {
      capturedUrl = typeof input === "string" ? input : input.toString();
      return Promise.resolve(
        Response.json(
          { access_token: "tok", expires_in: 3600 },
          { status: 200 }
        )
      );
    }) as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    await capturedAuthProvider?.getAccessToken();
    expect(capturedUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    );
  });

  test("oauth refresh-token caches the token and avoids re-fetching within the window", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json(
          { access_token: "cached-tok", expires_in: 3600 },
          { status: 200 }
        )
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    expect(await capturedAuthProvider?.getAccessToken()).toBe("cached-tok");
    expect(await capturedAuthProvider?.getAccessToken()).toBe("cached-tok");
    expect(await capturedAuthProvider?.getAccessToken()).toBe("cached-tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("oauth refresh-token re-fetches once the cached token is near expiry", async () => {
    let call = 0;
    const fetchMock = mock(() => {
      call += 1;
      // First call's token expires almost immediately. The cache window
      // subtracts 60s from expires_on, so an `expires_in: 1` falls below
      // the threshold immediately and the next getAccessToken re-fetches.
      return Promise.resolve(
        Response.json(
          {
            access_token: call === 1 ? "old-tok" : "new-tok",
            expires_in: call === 1 ? 1 : 3600,
          },
          { status: 200 }
        )
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    expect(await capturedAuthProvider?.getAccessToken()).toBe("old-tok");
    expect(await capturedAuthProvider?.getAccessToken()).toBe("new-tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("oauth refresh-token throws Unauthorized when the token endpoint returns non-OK", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("invalid_grant: bad refresh token", {
          status: 400,
          statusText: "Bad Request",
        })
      )) as unknown as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    await expect(capturedAuthProvider?.getAccessToken()).rejects.toThrow(
      /refresh-token exchange failed/iu
    );
  });

  test("oauth refresh-token exchange failure tolerates an unreadable error body", async () => {
    // The non-OK branch reads the response body for context but guards it
    // with `.catch(() => "")`; if reading the body itself throws, the error
    // falls back to the status text rather than blowing up.
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: () => Promise.reject(new Error("stream broken")),
      })) as unknown as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    await expect(capturedAuthProvider?.getAccessToken()).rejects.toThrow(
      /refresh-token exchange failed \(500\): Server Error/iu
    );
  });

  test("oauth refresh-token throws when the response is missing access_token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ error: "invalid_grant" }, { status: 200 })
      )) as unknown as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    await expect(capturedAuthProvider?.getAccessToken()).rejects.toThrow(
      /missing access_token/iu
    );
  });

  // Run one request through a real Graph client wired to the auth provider the
  // adapter built, and map its failure the way every adapter method does.
  const graphCallError = async () => {
    const real = originalInitWithMiddleware({
      ...(capturedAuthProvider && { authProvider: capturedAuthProvider }),
    });
    const error = await real
      .api("/me/drive/root")
      .get()
      .catch((error_: unknown) => error_);
    return mapGraphError(error);
  };

  test("a rejected refresh token surfaces as Unauthorized through the Graph client", async () => {
    // The Graph client flattens an auth provider's error into a status-less
    // GraphError keeping only its name, so the name has to carry the class.
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("invalid_grant", { status: 400 })
      )) as unknown as typeof fetch;
    onedrive({
      oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
    });
    const err = await graphCallError();
    expect(err.code).toBe("Unauthorized");
    expect(err.message).toMatch(/refresh-token exchange failed \(400\)/u);
  });

  test("a throttled or failing token endpoint stays a retryable Provider error", async () => {
    for (const status of [429, 503]) {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response("try later", { status })
        )) as unknown as typeof fetch;
      onedrive({
        oauth: { clientId: "c", clientSecret: "s", refreshToken: "r" },
      });
      // oxlint-disable-next-line no-await-in-loop -- one status per iteration, sequential by design
      await expect(
        capturedAuthProvider?.getAccessToken()
      ).rejects.toMatchObject({ code: "Provider" });
      // oxlint-disable-next-line no-await-in-loop -- one status per iteration, sequential by design
      const err = await graphCallError();
      expect(err.code).toBe("Provider");
    }
  });

  test("a clientCredentials rejection from @azure/identity surfaces as Unauthorized", async () => {
    const proto = ClientSecretCredential.prototype as unknown as {
      getToken: () => unknown;
    };
    const stub = proto.getToken;
    proto.getToken = () =>
      Promise.reject(
        new AuthenticationError(401, {
          error: "invalid_client",
          error_description: "AADSTS7000215: Invalid client secret provided.",
        })
      );
    try {
      onedrive({
        clientCredentials: { clientId: "c", clientSecret: "s", tenantId: "t" },
        driveId: "d1",
      });
      const err = await graphCallError();
      expect(err.code).toBe("Unauthorized");
    } finally {
      proto.getToken = stub;
    }
  });

  test("env-var fallback uses ONEDRIVE_ACCESS_TOKEN when no opts are passed", async () => {
    const prev = process.env.ONEDRIVE_ACCESS_TOKEN;
    process.env.ONEDRIVE_ACCESS_TOKEN = "env-tok";
    try {
      onedrive();
      expect(await capturedAuthProvider?.getAccessToken()).toBe("env-tok");
    } finally {
      restoreEnv("ONEDRIVE_ACCESS_TOKEN", prev);
    }
  });

  test("env-var fallback uses ONEDRIVE_TENANT_ID + CLIENT_ID + CLIENT_SECRET", async () => {
    const prevT = process.env.ONEDRIVE_TENANT_ID;
    const prevC = process.env.ONEDRIVE_CLIENT_ID;
    const prevS = process.env.ONEDRIVE_CLIENT_SECRET;
    const prevD = process.env.ONEDRIVE_DRIVE_ID;
    process.env.ONEDRIVE_TENANT_ID = "tenant-env";
    process.env.ONEDRIVE_CLIENT_ID = "cid-env";
    process.env.ONEDRIVE_CLIENT_SECRET = "sec-env";
    process.env.ONEDRIVE_DRIVE_ID = "drive-env";
    try {
      onedrive();
      expect(await capturedAuthProvider?.getAccessToken()).toBe(
        "cs-token:tenant-env"
      );
    } finally {
      restoreEnv("ONEDRIVE_TENANT_ID", prevT);
      restoreEnv("ONEDRIVE_CLIENT_ID", prevC);
      restoreEnv("ONEDRIVE_CLIENT_SECRET", prevS);
      restoreEnv("ONEDRIVE_DRIVE_ID", prevD);
    }
  });

  test("env-var clientCredentials still requires a target (driveId/siteId/userId)", () => {
    const prevT = process.env.ONEDRIVE_TENANT_ID;
    const prevC = process.env.ONEDRIVE_CLIENT_ID;
    const prevS = process.env.ONEDRIVE_CLIENT_SECRET;
    process.env.ONEDRIVE_TENANT_ID = "tenant-env";
    process.env.ONEDRIVE_CLIENT_ID = "cid-env";
    process.env.ONEDRIVE_CLIENT_SECRET = "sec-env";
    try {
      expect(() => onedrive()).toThrow(
        /clientCredentials auth requires `driveId`/iu
      );
    } finally {
      restoreEnv("ONEDRIVE_TENANT_ID", prevT);
      restoreEnv("ONEDRIVE_CLIENT_ID", prevC);
      restoreEnv("ONEDRIVE_CLIENT_SECRET", prevS);
    }
  });

  test("env ONEDRIVE_DRIVE_ID populates basePath", () => {
    const prevTok = process.env.ONEDRIVE_ACCESS_TOKEN;
    const prevD = process.env.ONEDRIVE_DRIVE_ID;
    process.env.ONEDRIVE_ACCESS_TOKEN = "env-tok";
    process.env.ONEDRIVE_DRIVE_ID = "drive-xyz";
    try {
      const adapter = onedrive();
      expect(adapter.basePath).toBe("/drives/drive-xyz");
    } finally {
      restoreEnv("ONEDRIVE_ACCESS_TOKEN", prevTok);
      restoreEnv("ONEDRIVE_DRIVE_ID", prevD);
    }
  });

  test("missing auth + no env vars throws", () => {
    expect(() => onedrive()).toThrow(/missing auth/iu);
  });
});
