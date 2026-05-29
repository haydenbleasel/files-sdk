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

import { ClientSecretCredential } from "@azure/identity";
import type { AuthenticationProvider } from "@microsoft/microsoft-graph-client";
import { Client, GraphError } from "@microsoft/microsoft-graph-client";

import { Files, FilesError } from "../src/index.js";
import { sharepoint } from "../src/sharepoint/index.js";

// SharePoint resolution traffic — these are the Graph endpoints the adapter
// hits before delegating to onedrive(). Each handler is set per-test and
// returns the JSON the adapter parses.
type Handler = (path: string, body?: unknown) => Promise<unknown> | unknown;

let getHandler: Handler;
let postHandler: Handler;
let putHandler: Handler;
let deleteHandler: Handler;
let lastCalls: { method: string; path: string; body?: unknown }[];

const restoreEnv = (key: string, value: string | undefined): void => {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
};

const fakeApi = (path: string) => ({
  delete: () => {
    lastCalls.push({ method: "DELETE", path });
    return Promise.resolve(deleteHandler(path));
  },
  get: () => {
    lastCalls.push({ method: "GET", path });
    return Promise.resolve(getHandler(path));
  },
  header: () => fakeApi(path),
  post: (body?: unknown) => {
    lastCalls.push({ body, method: "POST", path });
    return Promise.resolve(postHandler(path, body));
  },
  put: (body?: unknown) => {
    lastCalls.push({ body, method: "PUT", path });
    return Promise.resolve(putHandler(path, body));
  },
  responseType: () => fakeApi(path),
  top: () => fakeApi(path),
});

const fakeGraphClient = {
  api: fakeApi,
};

const originalInitWithMiddleware = Client.initWithMiddleware;
const originalCsGetToken = ClientSecretCredential.prototype.getToken;

beforeAll(() => {
  (Client as unknown as { initWithMiddleware: unknown }).initWithMiddleware =
    (_opts: { authProvider?: AuthenticationProvider }) => fakeGraphClient;
  (
    ClientSecretCredential.prototype as unknown as {
      getToken: () => unknown;
    }
  ).getToken = () =>
    Promise.resolve({
      expiresOnTimestamp: Date.now() + 3_600_000,
      token: "fake-token",
    });
});

afterAll(() => {
  (Client as unknown as { initWithMiddleware: unknown }).initWithMiddleware =
    originalInitWithMiddleware;
  (
    ClientSecretCredential.prototype as unknown as { getToken: unknown }
  ).getToken = originalCsGetToken;
});

const ENV_KEYS = [
  "SHAREPOINT_SITE_ID",
  "SHAREPOINT_SITE_URL",
  "SHAREPOINT_HOSTNAME",
  "SHAREPOINT_DRIVE_ID",
  "SHAREPOINT_DOCUMENT_LIBRARY",
  "SHAREPOINT_ACCESS_TOKEN",
  "SHAREPOINT_TENANT_ID",
  "SHAREPOINT_CLIENT_ID",
  "SHAREPOINT_CLIENT_SECRET",
  "ONEDRIVE_ACCESS_TOKEN",
  "ONEDRIVE_TENANT_ID",
  "ONEDRIVE_CLIENT_ID",
  "ONEDRIVE_CLIENT_SECRET",
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  lastCalls = [];
  getHandler = () => ({});
  postHandler = () => ({});
  putHandler = () => ({});
  deleteHandler = () => ({});
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key]);
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    restoreEnv(key, savedEnv.get(key));
  }
});

const CREDS = {
  clientId: "client-1",
  clientSecret: "secret-1",
  tenantId: "tenant-1",
};

describe("sharepoint adapter", () => {
  test("construction > missing auth throws", () => {
    expect(() => sharepoint({ siteId: "site-1" })).toThrow(/missing auth/u);
  });

  test("construction > exposes name and raw", () => {
    const adapter = sharepoint({
      clientCredentials: CREDS,
      siteId: "site-1",
    });
    expect(adapter.name).toBe("sharepoint");
    expect(adapter.raw).toBe(fakeGraphClient as unknown as typeof adapter.raw);
  });

  test("resolution > siteUrl is parsed and queried via /sites/{host}:{path}", async () => {
    getHandler = (path) => {
      if (path === "/sites/contoso.sharepoint.com:/sites/marketing") {
        return { id: "site-resolved" };
      }
      if (path === "/sites/site-resolved/drive") {
        return { id: "drive-default" };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      siteUrl: "https://contoso.sharepoint.com/sites/marketing",
    });
    // Trigger lazy resolution by calling any method.
    await adapter.list().catch(() => {
      /* ignore — list() goes through onedrive; we only need resolution */
    });
    const siteCall = lastCalls.find((c) =>
      c.path.includes(":/sites/marketing")
    );
    expect(siteCall).toBeDefined();
    expect(siteCall?.path).toBe(
      "/sites/contoso.sharepoint.com:/sites/marketing"
    );
  });

  test("resolution > documentLibrary picks named drive", async () => {
    getHandler = (path) => {
      if (path === "/sites/site-1") {
        return { id: "site-1-id" };
      }
      if (path === "/sites/site-1-id/drives") {
        return {
          value: [
            { id: "drive-docs", name: "Documents" },
            { id: "drive-reports", name: "Reports" },
          ],
        };
      }
      // Subsequent onedrive() calls — list children at the root.
      if (path === "/drives/drive-reports/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      documentLibrary: "Reports",
      hostname: "site-1",
    });
    await adapter.list();
    const childrenCall = lastCalls.find((c) =>
      c.path.startsWith("/drives/drive-reports/")
    );
    expect(childrenCall).toBeDefined();
  });

  test("resolution > missing library throws with available names", async () => {
    getHandler = (path) => {
      if (path === "/sites/site-1") {
        return { id: "site-1-id" };
      }
      if (path === "/sites/site-1-id/drives") {
        return {
          value: [
            { id: "drive-docs", name: "Documents" },
            { id: "drive-reports", name: "Reports" },
          ],
        };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      documentLibrary: "DoesNotExist",
      hostname: "site-1",
    });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("DoesNotExist"),
    });
    await expect(adapter.list()).rejects.toMatchObject({
      message: expect.stringContaining("Documents, Reports"),
    });
  });

  test("resolution > explicit driveId skips site resolution", async () => {
    getHandler = (path) => {
      if (path === "/drives/drive-explicit/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      driveId: "drive-explicit",
    });
    await adapter.list();
    const sitesCalls = lastCalls.filter((c) => c.path.includes("/sites/"));
    expect(sitesCalls).toHaveLength(0);
  });

  test("resolution > falls back to SHAREPOINT_SITE_ID env", async () => {
    process.env.SHAREPOINT_SITE_ID = "env-site";
    getHandler = (path) => {
      if (path === "/sites/env-site/drive") {
        return { id: "env-drive" };
      }
      if (path === "/drives/env-drive/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({ clientCredentials: CREDS });
    await adapter.list();
    expect(lastCalls.some((c) => c.path === "/sites/env-site/drive")).toBe(
      true
    );
  });

  test("resolution > falls back to ONEDRIVE_* creds when SHAREPOINT_* absent", async () => {
    process.env.ONEDRIVE_TENANT_ID = "od-tenant";
    process.env.ONEDRIVE_CLIENT_ID = "od-client";
    process.env.ONEDRIVE_CLIENT_SECRET = "od-secret";
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({ driveId: "d" });
    await adapter.list();
    expect(lastCalls.some((c) => c.path === "/drives/d/root/children")).toBe(
      true
    );
  });

  test("resolution > caches the resolved drive across calls", async () => {
    let siteLookups = 0;
    getHandler = (path) => {
      if (path === "/sites/site-1") {
        siteLookups += 1;
        return { id: "site-1-id" };
      }
      if (path === "/sites/site-1-id/drive") {
        return { id: "drive-default" };
      }
      if (path === "/drives/drive-default/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      hostname: "site-1",
    });
    await adapter.list();
    await adapter.list();
    await adapter.list();
    expect(siteLookups).toBe(1);
  });

  test("resolution > retries after a failure (does not cache rejection)", async () => {
    let attempt = 0;
    getHandler = (path) => {
      if (path === "/sites/site-1") {
        attempt += 1;
        if (attempt === 1) {
          throw new Error("transient");
        }
        return { id: "site-1-id" };
      }
      if (path === "/sites/site-1-id/drive") {
        return { id: "d" };
      }
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      hostname: "site-1",
    });
    await expect(adapter.list()).rejects.toBeDefined();
    const result = await adapter.list();
    expect(result.items).toEqual([]);
    expect(attempt).toBe(2);
  });

  test("error relabel > 'OneDrive error' becomes 'SharePoint error'", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root:/missing:") {
        const err = new GraphError(404, "Not found");
        err.code = "itemNotFound";
        throw err;
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      driveId: "d",
    });
    // head() routes through itemApiPath which is /drives/d/root:/missing:
    try {
      await adapter.head("missing");
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).code).toBe("NotFound");
    }
  });

  test("error relabel > Provider message gets relabeled", async () => {
    // Onedrive throws Provider with "OneDrive error" message on unmappable
    // failures. Force one by making the inner client throw a non-Graph error.
    getHandler = (path) => {
      if (path === "/drives/d/root:/k:") {
        const e = new Error("OneDrive error") as Error & {
          statusCode: number;
        };
        e.statusCode = 500;
        throw e;
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      driveId: "d",
    });
    try {
      await adapter.head("k");
      expect.unreachable();
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(FilesError);
      expect((error as FilesError).message).toContain("SharePoint error");
      expect((error as FilesError).message).not.toContain("OneDrive error");
    }
  });

  test("upload > delegates to inner onedrive() (PUT to drives/.../content)", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root:/hello.txt:") {
        return {
          eTag: '"new-etag"',
          file: { mimeType: "text/plain" },
          id: "item-1",
          lastModifiedDateTime: "2024-01-01T00:00:00Z",
          name: "hello.txt",
          size: 5,
        };
      }
      return {};
    };
    putHandler = (path) => {
      if (path === "/drives/d/root:/hello.txt:/content") {
        return {
          eTag: '"new-etag"',
          file: { mimeType: "text/plain" },
          id: "item-1",
          lastModifiedDateTime: "2024-01-01T00:00:00Z",
          name: "hello.txt",
          size: 5,
        };
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    const result = await files.upload("hello.txt", "hello");
    expect(result.size).toBe(5);
    expect(result.contentType).toBe("text/plain; charset=utf-8");
    const putCall = lastCalls.find(
      (c) => c.method === "PUT" && c.path.endsWith(":/content")
    );
    expect(putCall).toBeDefined();
  });

  test("signedUploadUrl > delegates to createUploadSession", async () => {
    postHandler = (path) => {
      if (path === "/drives/d/root:/big.bin:/createUploadSession") {
        return {
          expirationDateTime: new Date(Date.now() + 3_600_000).toISOString(),
          uploadUrl: "https://upload.example.com/session-abc",
        };
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    const signed = await files.signedUploadUrl("big.bin", {
      expiresIn: 3600,
    });
    expect(signed.method).toBe("PUT");
    if (signed.method !== "PUT") {
      throw new Error("expected PUT shape");
    }
    expect(signed.url).toBe("https://upload.example.com/session-abc");
  });

  test("siteUrl > non-URL string throws Provider", async () => {
    const adapter = sharepoint({
      clientCredentials: CREDS,
      siteUrl: "not a url",
    });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("not a valid URL"),
    });
  });

  test("client escape hatch > accepts pre-built Client", async () => {
    const adapter = sharepoint({
      client: fakeGraphClient as unknown as Client,
      driveId: "d",
    });
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("auth > oauth refresh-token shape is accepted", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      driveId: "d",
      oauth: {
        clientId: "oc",
        clientSecret: "os",
        refreshToken: "rt",
      },
    });
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("auth > accessToken string is accepted", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      accessToken: "static-token",
      driveId: "d",
    });
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("auth > accessToken async function is accepted", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      accessToken: () => Promise.resolve("async-token"),
      driveId: "d",
    });
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("auth > SHAREPOINT_ACCESS_TOKEN env is honored", async () => {
    process.env.SHAREPOINT_ACCESS_TOKEN = "env-sp-token";
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({ driveId: "d" });
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("auth > ONEDRIVE_ACCESS_TOKEN env is honored as fallback", async () => {
    process.env.ONEDRIVE_ACCESS_TOKEN = "env-od-token";
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({ driveId: "d" });
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("resolution > missing site selector throws Provider on first call", async () => {
    const adapter = sharepoint({ clientCredentials: CREDS });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("site selection required"),
    });
  });

  test("resolution > site lookup returning no id throws", async () => {
    getHandler = (path) => {
      if (path === "/sites/missing-host") {
        // no id
        return {};
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      hostname: "missing-host",
    });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("returned no id"),
    });
  });

  test("resolution > default drive lookup returning no id throws", async () => {
    getHandler = (path) => {
      if (path === "/sites/site-1") {
        return { id: "site-id" };
      }
      if (path === "/sites/site-id/drive") {
        // no id
        return {};
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      hostname: "site-1",
    });
    await expect(adapter.list()).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("default drive"),
    });
  });

  test("resolution > hostname + sitePath builds /sites/{host}:/{path}", async () => {
    let captured = "";
    getHandler = (path) => {
      if (path.startsWith("/sites/contoso") && path.includes(":/")) {
        captured = path;
        return { id: "site-id" };
      }
      if (path === "/sites/site-id/drive") {
        return { id: "d" };
      }
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      hostname: "contoso.sharepoint.com",
      sitePath: "/sites/legal",
    });
    await adapter.list();
    expect(captured).toBe("/sites/contoso.sharepoint.com:/sites/legal");
  });

  test("rootFolderPath > pre-resolution getter trims surrounding slashes", () => {
    const adapter = sharepoint({
      clientCredentials: CREDS,
      driveId: "d",
      rootFolderPath: "/Uploads/2024/",
    });
    expect(adapter.rootFolderPath).toBe("Uploads/2024");
  });

  test("rootFolderPath > defaults to empty string when unset", () => {
    const adapter = sharepoint({
      clientCredentials: CREDS,
      driveId: "d",
    });
    expect(adapter.rootFolderPath).toBe("");
  });

  test("rootFolderPath > rejects dot segments in roots and delegated keys", async () => {
    const unsafeRoot = sharepoint({
      clientCredentials: CREDS,
      driveId: "d",
      rootFolderPath: "../Uploads",
    });
    await expect(unsafeRoot.list()).rejects.toThrow(
      /rootFolderPath must not contain/u
    );

    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
        rootFolderPath: "Uploads",
      }),
    });
    await expect(files.download("../secret.txt")).rejects.toThrow(
      /key must not contain/u
    );
    expect(lastCalls).toEqual([]);
  });

  test("delete > delegates to onedrive (DELETE on item path)", async () => {
    deleteHandler = () => Promise.resolve({});
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    await files.delete("hello.txt");
    const deleteCall = lastCalls.find(
      (c) => c.method === "DELETE" && c.path === "/drives/d/root:/hello.txt:"
    );
    expect(deleteCall).toBeDefined();
  });

  test("head > delegates to onedrive (GET on item path)", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root:/hello.txt:") {
        return {
          eTag: '"e1"',
          file: { mimeType: "text/plain" },
          id: "id1",
          lastModifiedDateTime: "2024-01-02T03:04:05.000Z",
          name: "hello.txt",
          size: 5,
        };
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    const file = await files.head("hello.txt");
    expect(file.size).toBe(5);
    expect(file.type).toBe("text/plain");
    expect(file.etag).toBe("e1");
  });

  test("download > delegates to onedrive and returns body", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root:/hello.txt:") {
        return {
          eTag: '"e1"',
          file: { mimeType: "text/plain" },
          id: "id1",
          lastModifiedDateTime: "2024-01-02T03:04:05.000Z",
          name: "hello.txt",
          size: 5,
        };
      }
      if (path === "/drives/d/root:/hello.txt:/content") {
        return Buffer.from("hello").buffer;
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    const file = await files.download("hello.txt");
    expect(await file.text()).toBe("hello");
  });

  test("exists > delegates to onedrive (true)", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root:/hello.txt:") {
        return { id: "id1" };
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    await expect(files.exists("hello.txt")).resolves.toBe(true);
  });

  test("exists > delegates to onedrive (false on 404)", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root:/missing.txt:") {
        const err = new GraphError(404, "Not found");
        err.code = "itemNotFound";
        throw err;
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    await expect(files.exists("missing.txt")).resolves.toBe(false);
  });

  test("copy > delegates to onedrive (POST /copy + monitor)", async () => {
    let monitorHit = false;
    postHandler = (path) => {
      if (path === "/drives/d/root:/src.txt:/copy") {
        return new Response(null, {
          headers: { location: "https://monitor.example.com/op-1" },
          status: 202,
        });
      }
      return {};
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      monitorHit = true;
      return Promise.resolve(
        Response.json(
          { status: "completed" },
          {
            headers: { "content-type": "application/json" },
            status: 200,
          }
        )
      );
    }) as unknown as typeof globalThis.fetch;
    try {
      const files = new Files({
        adapter: sharepoint({
          clientCredentials: CREDS,
          driveId: "d",
        }),
      });
      await files.copy("src.txt", "dest.txt");
      expect(monitorHit).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("url > publicByDefault=true delegates to inner createLink", async () => {
    postHandler = (path) => {
      if (path === "/drives/d/root:/k:/createLink") {
        return { link: { webUrl: "https://share.example.com/abc" } };
      }
      return {};
    };
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
        publicByDefault: true,
      }),
    });
    const url = await files.url("k");
    expect(url).toBe("https://share.example.com/abc");
  });

  test("url > default (publicByDefault=false) propagates inner throw, relabeled", async () => {
    const files = new Files({
      adapter: sharepoint({
        clientCredentials: CREDS,
        driveId: "d",
      }),
    });
    await expect(files.url("k")).rejects.toMatchObject({
      code: "Provider",
      message: expect.stringContaining("url()"),
    });
  });

  test("copyTimeoutMs > is forwarded to inner onedrive()", async () => {
    // Force the monitor poll loop to time out by returning inProgress forever.
    postHandler = (path) => {
      if (path === "/drives/d/root:/src.txt:/copy") {
        return new Response(null, {
          headers: { location: "https://monitor.example.com/never" },
          status: 202,
        });
      }
      return {};
    };
    const origFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json(
          { status: "inProgress" },
          {
            headers: { "content-type": "application/json" },
            status: 200,
          }
        )
      )
    ) as unknown as typeof globalThis.fetch;
    try {
      const adapter = sharepoint({
        clientCredentials: CREDS,
        copyTimeoutMs: 10,
        driveId: "d",
      });
      await expect(adapter.copy("src.txt", "dest.txt")).rejects.toMatchObject({
        code: "Provider",
        message: expect.stringContaining("timed out"),
      });
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("clientCredentials direct > works without env vars", async () => {
    getHandler = (path) => {
      if (path === "/drives/d/root/children") {
        return { value: [] };
      }
      return {};
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      driveId: "d",
    });
    const result = await adapter.list();
    expect(result.items).toEqual([]);
  });

  test("non-OneDrive error > passes through unchanged (no relabel)", async () => {
    getHandler = () => {
      throw new Error("plain non-graph error");
    };
    const adapter = sharepoint({
      clientCredentials: CREDS,
      hostname: "site-1",
    });
    try {
      await adapter.list();
      expect.unreachable();
    } catch (error: unknown) {
      const e = error as Error;
      expect(e.message).toContain("plain non-graph error");
    }
  });
});
