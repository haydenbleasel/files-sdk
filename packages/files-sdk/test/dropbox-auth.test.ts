import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { dropbox } from "../src/dropbox/index.js";

interface AuthHandleLike {
  ensureAccessToken(): Promise<void>;
  getAccessToken(): Promise<string>;
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
