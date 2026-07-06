import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Dropbox } from "dropbox";

import { dropbox } from "../src/dropbox/index.js";

interface AuthHandleLike {
  ensureAccessToken: () => Promise<void>;
  getAccessToken: () => Promise<string>;
}

const handleOf = (adapter: ReturnType<typeof dropbox>): AuthHandleLike =>
  (adapter as unknown as { _authHandle: AuthHandleLike })._authHandle;

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // Restore fetch before each test; tests opt in to mocking it.
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("dropbox auth construction", () => {
  test("accessToken (string) sets the token verbatim", async () => {
    const adapter = dropbox({ accessToken: "tok-static" });
    expect(await handleOf(adapter).getAccessToken()).toBe("tok-static");
  });

  test("accessToken (function) is awaited on each call", async () => {
    let n = 0;
    const adapter = dropbox({
      accessToken: () => {
        n += 1;
        return Promise.resolve(`tok-${n}`);
      },
    });
    expect(await handleOf(adapter).getAccessToken()).toBe("tok-1");
    expect(await handleOf(adapter).getAccessToken()).toBe("tok-2");
    expect(n).toBe(2);
  });

  test("accessToken (sync function) is supported", async () => {
    const adapter = dropbox({ accessToken: () => "sync-tok" });
    expect(await handleOf(adapter).getAccessToken()).toBe("sync-tok");
  });

  test("refreshToken mints a token via the v2 token endpoint", async () => {
    const fetchMock = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        expect(url).toBe("https://api.dropboxapi.com/oauth2/token");
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("rt-1");
        expect(body.get("client_id")).toBe("ak-1");
        expect(body.get("client_secret")).toBe("as-1");
        return Promise.resolve(
          Response.json(
            {
              access_token: "minted-tok",
              expires_in: 3600,
              token_type: "Bearer",
            },
            { status: 200 }
          )
        );
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = dropbox({
      appKey: "ak-1",
      appSecret: "as-1",
      refreshToken: "rt-1",
    });
    expect(await handleOf(adapter).getAccessToken()).toBe("minted-tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refreshToken without appSecret omits client_secret", async () => {
    let capturedBody: URLSearchParams | undefined;
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      capturedBody = init?.body as URLSearchParams;
      return Promise.resolve(
        Response.json(
          { access_token: "tok", expires_in: 3600 },
          { status: 200 }
        )
      );
    }) as typeof fetch;
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    await handleOf(adapter).getAccessToken();
    expect(capturedBody?.get("client_id")).toBe("ak");
    expect(capturedBody?.get("client_secret")).toBeNull();
  });

  test("refreshToken caches the token and avoids re-fetching within the window", async () => {
    const fetchMock = mock(() =>
      Promise.resolve(
        Response.json(
          { access_token: "cached-tok", expires_in: 3600 },
          { status: 200 }
        )
      )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    expect(await handleOf(adapter).getAccessToken()).toBe("cached-tok");
    expect(await handleOf(adapter).getAccessToken()).toBe("cached-tok");
    expect(await handleOf(adapter).getAccessToken()).toBe("cached-tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("refreshToken re-fetches once the cached token is near expiry", async () => {
    let call = 0;
    const fetchMock = mock(() => {
      call += 1;
      // First response expires almost immediately (1s). The cache window
      // subtracts 60s from the expiry, so the next call falls outside the
      // window and triggers a re-fetch.
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
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    expect(await handleOf(adapter).getAccessToken()).toBe("old-tok");
    expect(await handleOf(adapter).getAccessToken()).toBe("new-tok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("refreshToken throws Unauthorized when the token endpoint returns non-OK", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("invalid_grant: bad refresh token", {
          status: 400,
          statusText: "Bad Request",
        })
      )) as unknown as typeof fetch;
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    await expect(handleOf(adapter).getAccessToken()).rejects.toThrow(
      /refresh-token exchange failed/iu
    );
  });

  test("refreshToken throws when the response is missing access_token", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        Response.json({ error: "invalid_grant" }, { status: 200 })
      )) as unknown as typeof fetch;
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    await expect(handleOf(adapter).getAccessToken()).rejects.toThrow(
      /missing access_token/iu
    );
  });

  test("env-var fallback uses DROPBOX_ACCESS_TOKEN when no opts are passed", async () => {
    const prev = process.env.DROPBOX_ACCESS_TOKEN;
    process.env.DROPBOX_ACCESS_TOKEN = "env-tok";
    try {
      const adapter = dropbox({});
      expect(await handleOf(adapter).getAccessToken()).toBe("env-tok");
    } finally {
      restoreEnv("DROPBOX_ACCESS_TOKEN", prev);
    }
  });

  test("ensureAccessToken on a static-token adapter is a no-op that resolves", async () => {
    // A verbatim string token is already applied at construction, so
    // ensureAccessToken has nothing to refresh — it should just resolve.
    const adapter = dropbox({ accessToken: "tok-static" });
    await expect(
      handleOf(adapter).ensureAccessToken()
    ).resolves.toBeUndefined();
    // The token is unchanged by the no-op.
    expect(await handleOf(adapter).getAccessToken()).toBe("tok-static");
  });

  test("refresh-token exchange failure tolerates an unreadable error body", async () => {
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
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    await expect(handleOf(adapter).getAccessToken()).rejects.toThrow(
      /refresh-token exchange failed \(500\): Server Error/iu
    );
  });

  test("ensureAccessToken on a callable-token adapter awaits and applies the source", async () => {
    let calls = 0;
    const adapter = dropbox({
      accessToken: () => {
        calls += 1;
        return Promise.resolve(`callable-${calls}`);
      },
    });
    await handleOf(adapter).ensureAccessToken();
    await handleOf(adapter).ensureAccessToken();
    // ensureAccessToken must invoke the source each time — no caching.
    expect(calls).toBe(2);
  });

  test("ensureAccessToken on a refresh-token adapter performs the OAuth exchange", async () => {
    let calls = 0;
    const fetchMock = mock(() => {
      calls += 1;
      return Promise.resolve(
        Response.json(
          { access_token: "refresh-tok", expires_in: 3600 },
          { status: 200 }
        )
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const adapter = dropbox({ appKey: "ak", refreshToken: "rt" });
    await handleOf(adapter).ensureAccessToken();
    expect(calls).toBe(1);
    // Subsequent ensure call falls inside the cache window — no re-fetch.
    await handleOf(adapter).ensureAccessToken();
    expect(calls).toBe(1);
  });

  test("pre-built client adapter exposes the underlying SDK token via getAccessToken", async () => {
    const fakeClient = {
      auth: {
        getAccessToken: () => "preset-from-sdk",
        setAccessToken: () => {},
      },
    } as unknown as Dropbox;
    const adapter = dropbox({ client: fakeClient });
    expect(await handleOf(adapter).getAccessToken()).toBe("preset-from-sdk");
    // ensureAccessToken on a pre-built client is a no-op (the caller owns
    // the token lifecycle), but should still resolve cleanly.
    await handleOf(adapter).ensureAccessToken();
  });

  test("env-var fallback uses DROPBOX_REFRESH_TOKEN + DROPBOX_APP_KEY", async () => {
    const prevRt = process.env.DROPBOX_REFRESH_TOKEN;
    const prevAk = process.env.DROPBOX_APP_KEY;
    const prevAs = process.env.DROPBOX_APP_SECRET;
    process.env.DROPBOX_REFRESH_TOKEN = "env-rt";
    process.env.DROPBOX_APP_KEY = "env-ak";
    process.env.DROPBOX_APP_SECRET = "env-as";
    let capturedBody: URLSearchParams | undefined;
    globalThis.fetch = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      capturedBody = init?.body as URLSearchParams;
      return Promise.resolve(
        Response.json(
          { access_token: "env-minted", expires_in: 3600 },
          { status: 200 }
        )
      );
    }) as typeof fetch;
    try {
      const adapter = dropbox({});
      expect(await handleOf(adapter).getAccessToken()).toBe("env-minted");
      expect(capturedBody?.get("client_id")).toBe("env-ak");
      expect(capturedBody?.get("client_secret")).toBe("env-as");
      expect(capturedBody?.get("refresh_token")).toBe("env-rt");
    } finally {
      restoreEnv("DROPBOX_REFRESH_TOKEN", prevRt);
      restoreEnv("DROPBOX_APP_KEY", prevAk);
      restoreEnv("DROPBOX_APP_SECRET", prevAs);
    }
  });
});
