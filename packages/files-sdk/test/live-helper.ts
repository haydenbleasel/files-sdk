/**
 * Shared plumbing for `*.live.test.ts` suites — tests that hit a *real*
 * provider instead of a mock.
 *
 * Live tests are SKIPPED by default. They only run when `LIVE_TESTS=1` is set,
 * and adapters that need credentials skip additionally when those env vars are
 * absent. This keeps the default `bun test` (and CI on every PR) fast, offline,
 * and credential-free, while still letting a maintainer exercise a real backend
 * on demand (`LIVE_TESTS=1 bun test s3.live`).
 *
 * The CI gate lives in `.github/workflows/live-tests.yml`: live tests run only
 * on `workflow_dispatch` (or a maintainer-applied `live-tests` label), never on
 * `pull_request` from forks, so credentials can't leak.
 */
import { describe } from "bun:test";

/** True when the live suite has been explicitly opted into. */
export const liveEnabled = process.env.LIVE_TESTS === "1";

/**
 * `describe` that runs only when `LIVE_TESTS=1`, otherwise skips. Use for live
 * suites that need no credentials (e.g. the `fs` adapter against a temp dir).
 */
export const liveDescribe = liveEnabled ? describe : describe.skip;

/**
 * `describe` that runs only when `LIVE_TESTS=1` *and* every named env var is
 * present and non-empty. Use for live suites that need credentials so a missing
 * secret skips the suite cleanly instead of failing with an auth error.
 */
export const liveDescribeWithEnv = (
  required: readonly string[]
): typeof describe | typeof describe.skip => {
  if (!liveEnabled) {
    return describe.skip;
  }
  const haveAll = required.every((name) => {
    const value = process.env[name];
    return typeof value === "string" && value.length > 0;
  });
  return haveAll ? describe : describe.skip;
};

/** Read a required env var, throwing a clear error if it's missing. */
export const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required env var ${name} for live test`);
  }
  return value;
};
