import { describe, expect, test } from "bun:test";

import { Files } from "../src/index.js";
import type {
  Adapter,
  ListResult,
  SignedUpload,
  SignUploadOptions,
  StoredFile,
  UrlOptions,
} from "../src/index.js";
import { signedUrlPolicy } from "../src/signed-url-policy/index.js";
import type { SignedUrlPolicyOptions } from "../src/signed-url-policy/index.js";

// A recording adapter: the only methods under test are `url` and
// `signedUploadUrl`, so it captures the exact options the plugin forwards to
// each and returns them for assertion. Every other method is an inert stub the
// plugin never touches.
interface Recorder {
  adapter: Adapter;
  urlOpts: UrlOptions | undefined;
  signOpts: SignUploadOptions | undefined;
}

const recorder = (): Recorder => {
  const rec: Recorder = {
    adapter: undefined as unknown as Adapter,
    signOpts: undefined,
    urlOpts: undefined,
  };
  rec.adapter = {
    copy: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    download: () => Promise.resolve({} as StoredFile),
    exists: () => Promise.resolve(true),
    head: () => Promise.resolve({} as StoredFile),
    list: () => Promise.resolve({ items: [] } as ListResult),
    name: "recorder",
    raw: {},
    signedUploadUrl: (key, opts): Promise<SignedUpload> => {
      rec.signOpts = opts;
      return Promise.resolve({ method: "PUT", url: `rec://${key}` });
    },
    upload: (key) =>
      Promise.resolve({
        contentType: "application/octet-stream",
        etag: "e",
        key,
        lastModified: 0,
        size: 0,
      }),
    url: (key, opts): Promise<string> => {
      rec.urlOpts = opts;
      return Promise.resolve(`rec://${key}`);
    },
  };
  return rec;
};

const withPolicy = (
  options: SignedUrlPolicyOptions = {},
  rec: Recorder = recorder()
): { files: Files; rec: Recorder } => ({
  files: new Files({
    adapter: rec.adapter,
    plugins: [signedUrlPolicy(options)],
  }),
  rec,
});

describe("signedUrlPolicy — url() disposition", () => {
  test("forces attachment by default when the caller passes none", async () => {
    const { files, rec } = withPolicy();
    await files.url("user.html");
    expect(rec.urlOpts?.responseContentDisposition).toBe("attachment");
  });

  test("overrides an inline disposition", async () => {
    const { files, rec } = withPolicy();
    await files.url("user.html", { responseContentDisposition: "inline" });
    expect(rec.urlOpts?.responseContentDisposition).toBe("attachment");
  });

  test("preserves a caller-set attachment with a filename", async () => {
    const { files, rec } = withPolicy();
    await files.url("doc.pdf", {
      responseContentDisposition: 'attachment; filename="report.pdf"',
    });
    expect(rec.urlOpts?.responseContentDisposition).toBe(
      'attachment; filename="report.pdf"'
    );
  });

  test("treats a leading-whitespace attachment as already safe", async () => {
    const { files, rec } = withPolicy();
    await files.url("doc.pdf", {
      responseContentDisposition: "  attachment",
    });
    expect(rec.urlOpts?.responseContentDisposition).toBe("  attachment");
  });

  test("uses a configured default disposition with a filename", async () => {
    const { files, rec } = withPolicy({
      disposition: 'attachment; filename="download.bin"',
    });
    await files.url("blob");
    expect(rec.urlOpts?.responseContentDisposition).toBe(
      'attachment; filename="download.bin"'
    );
  });

  test("disposition:false leaves the caller's disposition untouched", async () => {
    const { files, rec } = withPolicy({ disposition: false });
    await files.url("user.html", { responseContentDisposition: "inline" });
    expect(rec.urlOpts?.responseContentDisposition).toBe("inline");
  });

  test("disposition:false leaves an absent disposition absent", async () => {
    const { files, rec } = withPolicy({ disposition: false });
    await files.url("user.html");
    expect(rec.urlOpts?.responseContentDisposition).toBeUndefined();
  });
});

describe("signedUrlPolicy — url() expiry", () => {
  test("clamps an over-cap expiresIn down to the cap", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await files.url("a", { expiresIn: 86_400 });
    expect(rec.urlOpts?.expiresIn).toBe(900);
  });

  test("leaves an under-cap expiresIn as-is", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await files.url("a", { expiresIn: 60 });
    expect(rec.urlOpts?.expiresIn).toBe(60);
  });

  test("pins an absent expiresIn to the cap to guarantee the ceiling", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await files.url("a");
    expect(rec.urlOpts?.expiresIn).toBe(900);
  });

  test("leaves expiresIn untouched when no cap is set", async () => {
    const { files, rec } = withPolicy();
    await files.url("a", { expiresIn: 86_400 });
    expect(rec.urlOpts?.expiresIn).toBe(86_400);
  });
});

describe("signedUrlPolicy — signedUploadUrl()", () => {
  test("clamps an over-cap expiresIn", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await files.signedUploadUrl("a", { expiresIn: 86_400 });
    expect(rec.signOpts?.expiresIn).toBe(900);
  });

  test("leaves an under-cap expiresIn as-is", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await files.signedUploadUrl("a", { expiresIn: 120 });
    expect(rec.signOpts?.expiresIn).toBe(120);
  });

  test("pins an absent signed-upload expiresIn to the cap", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await (
      files.signedUploadUrl as (
        key: string,
        opts: Partial<SignUploadOptions>
      ) => Promise<SignedUpload>
    )("a", {});
    expect(rec.signOpts?.expiresIn).toBe(900);
  });

  test("injects maxSize when the caller omits it", async () => {
    const { files, rec } = withPolicy({ maxUploadSize: 1024 });
    await files.signedUploadUrl("a", { expiresIn: 60 });
    expect(rec.signOpts?.maxSize).toBe(1024);
  });

  test("clamps an over-cap maxSize down to the cap", async () => {
    const { files, rec } = withPolicy({ maxUploadSize: 1024 });
    await files.signedUploadUrl("a", { expiresIn: 60, maxSize: 9999 });
    expect(rec.signOpts?.maxSize).toBe(1024);
  });

  test("leaves an under-cap maxSize as-is", async () => {
    const { files, rec } = withPolicy({ maxUploadSize: 1024 });
    await files.signedUploadUrl("a", { expiresIn: 60, maxSize: 256 });
    expect(rec.signOpts?.maxSize).toBe(256);
  });

  test("leaves maxSize unset when no upload cap is configured", async () => {
    const { files, rec } = withPolicy({ maxExpiresIn: 900 });
    await files.signedUploadUrl("a", { expiresIn: 60 });
    expect(rec.signOpts?.maxSize).toBeUndefined();
  });

  test("does not force a disposition on signed uploads", async () => {
    const { files, rec } = withPolicy();
    await files.signedUploadUrl("a", { expiresIn: 60 });
    // SignUploadOptions has no disposition field; just confirm it passed through.
    expect(rec.signOpts?.expiresIn).toBe(60);
  });
});

describe("signedUrlPolicy — pass-through", () => {
  test("does not disturb other verbs", async () => {
    const { files } = withPolicy({ maxExpiresIn: 900, maxUploadSize: 1024 });
    await files.upload("a", "hi");
    expect(await files.exists("a")).toBe(true);
  });

  test("names the plugin for diagnostics", () => {
    expect(signedUrlPolicy().name).toBe("signed-url-policy");
  });
});
