import { describe, expect, test } from "bun:test";

import {
  sameOriginSessionUrl,
  trustedHttpsSessionUrl,
} from "../src/internal/resumable-session-url.js";

describe("trustedHttpsSessionUrl", () => {
  const trusted = ["storage.example.com"];

  test("accepts a trusted host and its subdomains", () => {
    expect(
      trustedHttpsSessionUrl(
        "https://storage.example.com/u/1",
        "session URL",
        trusted
      )
    ).toBe("https://storage.example.com/u/1");
    expect(
      trustedHttpsSessionUrl(
        "https://eu.storage.example.com/u/1",
        "session URL",
        trusted
      )
    ).toBe("https://eu.storage.example.com/u/1");
  });

  test("rejects a non-absolute URL", () => {
    expect(() =>
      trustedHttpsSessionUrl("/relative", "session URL", trusted)
    ).toThrow("session URL must be an absolute URL");
  });

  test("rejects embedded credentials", () => {
    expect(() =>
      trustedHttpsSessionUrl(
        "https://user:pass@storage.example.com/u/1",
        "session URL",
        trusted
      )
    ).toThrow("session URL must not include credentials");
  });

  test("rejects a non-HTTPS scheme", () => {
    expect(() =>
      trustedHttpsSessionUrl(
        "http://storage.example.com/u/1",
        "session URL",
        trusted
      )
    ).toThrow("session URL must use HTTPS");
  });

  test("rejects an untrusted host", () => {
    expect(() =>
      trustedHttpsSessionUrl(
        "https://evil.example.net/u/1",
        "session URL",
        trusted
      )
    ).toThrow("session URL host is not trusted for resumable uploads");
  });
});

describe("sameOriginSessionUrl", () => {
  const base = "https://api.example.com/resumable/";

  test("accepts a same-origin URL under the base path", () => {
    expect(
      sameOriginSessionUrl(
        "https://api.example.com/resumable/session/1",
        base,
        "session URL"
      )
    ).toBe("https://api.example.com/resumable/session/1");
  });

  test("resolves a relative value against the base", () => {
    expect(sameOriginSessionUrl("session/2", base, "session URL")).toBe(
      "https://api.example.com/resumable/session/2"
    );
  });

  test("rejects a malformed base", () => {
    expect(() =>
      sameOriginSessionUrl("session/1", "not a url", "session URL")
    ).toThrow("session URL base must be an absolute URL");
  });

  test("rejects embedded credentials", () => {
    expect(() =>
      sameOriginSessionUrl(
        "https://user:pass@api.example.com/resumable/session/1",
        base,
        "session URL"
      )
    ).toThrow("session URL must not include credentials");
  });

  test("rejects a cross-origin URL", () => {
    expect(() =>
      sameOriginSessionUrl(
        "https://other.example.com/resumable/session/1",
        base,
        "session URL"
      )
    ).toThrow(
      "session URL origin does not match the configured resumable endpoint"
    );
  });

  test("rejects a path outside the base", () => {
    expect(() =>
      sameOriginSessionUrl(
        "https://api.example.com/admin/session/1",
        base,
        "session URL"
      )
    ).toThrow("session URL path is outside the configured resumable endpoint");
  });
});
