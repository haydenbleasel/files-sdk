import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { md5Hex } from "../src/internal/md5.js";

const encoder = new TextEncoder();
const nodeMd5 = (bytes: Uint8Array): string =>
  createHash("md5").update(bytes).digest("hex");

// A deterministic, non-repeating-looking byte pattern of any length.
const pattern = (length: number): Uint8Array =>
  Uint8Array.from({ length }, (_, i) => (i * 131 + 7) % 256);

describe("md5Hex", () => {
  // RFC 1321 appendix A.5 test suite.
  test.each([
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ])("RFC 1321 vector %j", (input, digest) => {
    expect(md5Hex(encoder.encode(input))).toBe(digest);
  });

  // Every padding shape: tails that fit one block, tails that spill into a
  // second (56..63 leftover bytes), exact block multiples, and multi-block
  // bodies with each kind of tail.
  test.each([1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003])(
    "matches node:crypto for %i bytes",
    (length) => {
      const bytes = pattern(length);
      expect(md5Hex(bytes)).toBe(nodeMd5(bytes));
    }
  );

  test("hashes only a subarray's own bytes, not its whole buffer", () => {
    const backing = pattern(300);
    const slice = backing.subarray(37, 237);
    expect(md5Hex(slice)).toBe(nodeMd5(slice));
    expect(md5Hex(slice)).not.toBe(md5Hex(backing));
  });

  test("leaves the input untouched", () => {
    const bytes = pattern(70);
    const before = [...bytes];
    md5Hex(bytes);
    expect([...bytes]).toEqual(before);
  });
});
