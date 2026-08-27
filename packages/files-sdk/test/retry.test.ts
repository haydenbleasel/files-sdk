import { describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";

import { FilesError } from "../src/internal/errors.js";
import {
  abortError,
  canRetry,
  combineSignals,
  manualAnySignal,
  maxRetries,
  mergeSignals,
  retryBackoff,
  runWithSignal,
  sleep,
  timeoutMs,
} from "../src/internal/retry.js";

describe("mergeSignals", () => {
  test("no signals and no timeout returns nothing", () => {
    const merged = mergeSignals([]);
    expect(merged.signal).toBeUndefined();
    expect(merged.cleanup).toBeUndefined();
  });

  test("a single signal with no timeout passes through unchanged", () => {
    const controller = new AbortController();
    const merged = mergeSignals([controller.signal]);
    expect(merged.signal).toBe(controller.signal);
    expect(merged.cleanup).toBeUndefined();
  });

  test("an already-aborted input aborts the merged signal immediately", () => {
    const aborted = new AbortController();
    aborted.abort("nope");
    const merged = mergeSignals([aborted.signal, new AbortController().signal]);
    expect(merged.signal?.aborted).toBe(true);
    merged.cleanup?.();
  });

  test("aborting any input aborts the merged signal", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeSignals([a.signal, b.signal]);
    expect(merged.signal?.aborted).toBe(false);
    a.abort("boom");
    expect(merged.signal?.aborted).toBe(true);
    merged.cleanup?.();
  });

  test("a timeout aborts the merged signal", async () => {
    const merged = mergeSignals([], 5);
    await delay(15);
    expect(merged.signal?.aborted).toBe(true);
    merged.cleanup?.();
  });

  test("a non-finite timeout means no timeout, not an instant one", async () => {
    // Node/Bun clamp a delay > 2^31-1 (or Infinity) to 1ms, which would
    // time every op out immediately.
    const none = mergeSignals([], Number.POSITIVE_INFINITY);
    expect(none.signal).toBeUndefined();
    expect(none.cleanup).toBeUndefined();

    const controller = new AbortController();
    const single = mergeSignals([controller.signal], Number.POSITIVE_INFINITY);
    expect(single.signal).toBe(controller.signal);
    expect(single.cleanup).toBeUndefined();

    const huge = mergeSignals([], Number.MAX_SAFE_INTEGER);
    await delay(15);
    expect(huge.signal?.aborted).toBe(false);
    huge.cleanup?.();
  });

  test("cleanup disarms the timeout but keeps caller signals wired", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeSignals([a.signal, b.signal], 5);
    merged.cleanup?.();
    await delay(15);
    // The per-attempt timer is gone once the attempt settles...
    expect(merged.signal?.aborted).toBe(false);
    // ...but a caller abort still reaches whatever holds the merged signal
    // (a lazily-consumed download body, for instance).
    b.abort("late");
    expect(merged.signal?.aborted).toBe(true);
    expect(merged.signal?.reason).toBe("late");
  });
});

describe("timeoutMs", () => {
  test("drops unset, non-positive, and non-finite timeouts", () => {
    expect(timeoutMs()).toBeUndefined();
    expect(timeoutMs(0)).toBeUndefined();
    expect(timeoutMs(-1)).toBeUndefined();
    expect(timeoutMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(timeoutMs(Number.NaN)).toBeUndefined();
  });

  test("passes a sane timeout through and clamps an oversized one", () => {
    expect(timeoutMs(250)).toBe(250);
    expect(timeoutMs(2 ** 40)).toBe(2_147_483_647);
  });
});

describe("combineSignals", () => {
  test("nothing in, nothing out; one in, the same one out", () => {
    expect(combineSignals([])).toBeUndefined();
    const controller = new AbortController();
    expect(combineSignals([controller.signal])).toBe(controller.signal);
  });

  test("two inputs fold into a fresh signal that follows either", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = combineSignals([a.signal, b.signal]);
    expect(merged).not.toBe(a.signal);
    expect(merged?.aborted).toBe(false);
    b.abort("b");
    expect(merged?.reason).toBe("b");
  });

  test("the manual fallback follows the first input to abort", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = manualAnySignal([a.signal, b.signal]);
    expect(merged.aborted).toBe(false);
    b.abort("first");
    a.abort("second");
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe("first");
  });

  test("the manual fallback reflects an already-aborted input", () => {
    const aborted = new AbortController();
    aborted.abort("early");
    const merged = manualAnySignal([
      aborted.signal,
      new AbortController().signal,
    ]);
    expect(merged.aborted).toBe(true);
    expect(merged.reason).toBe("early");
  });
});

describe("abortError", () => {
  test("passes a FilesError through unchanged", () => {
    const original = new FilesError("Provider", "x", undefined, {
      aborted: true,
    });
    expect(abortError(original)).toBe(original);
  });

  test("wraps an Error with its message", () => {
    const err = abortError(new Error("kaboom"));
    expect(err.aborted).toBe(true);
    expect(err.message).toContain("kaboom");
  });

  test("handles undefined and non-error reasons", () => {
    expect(abortError().message).toBe("Operation aborted");
    expect(abortError("stringy").message).toContain("stringy");
  });
});

describe("runWithSignal", () => {
  test("runs without a signal", async () => {
    await expect(
      runWithSignal(undefined, () => Promise.resolve(7))
    ).resolves.toBe(7);
  });

  test("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("pre");
    await expect(
      runWithSignal(controller.signal, () => Promise.resolve(1))
    ).rejects.toMatchObject({ aborted: true });
  });

  test("rejects when the signal aborts mid-flight", async () => {
    const controller = new AbortController();
    const promise = runWithSignal(controller.signal, async () => {
      await delay(100);
      return 1;
    });
    controller.abort("mid");
    await expect(promise).rejects.toMatchObject({ aborted: true });
  });

  test("resolves and detaches the listener on success", async () => {
    const controller = new AbortController();
    await expect(
      runWithSignal(controller.signal, () => Promise.resolve("ok"))
    ).resolves.toBe("ok");
  });
});

describe("sleep", () => {
  test("a non-positive duration resolves immediately", async () => {
    await expect(sleep(0)).resolves.toBeUndefined();
  });

  test("throws when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("pre");
    await expect(sleep(50, controller.signal)).rejects.toMatchObject({
      aborted: true,
    });
  });

  test("resolves after the delay", async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });

  test("rejects when aborted during the delay", async () => {
    const controller = new AbortController();
    const promise = sleep(1000, controller.signal);
    controller.abort("during");
    await expect(promise).rejects.toMatchObject({ aborted: true });
  });
});

describe("retry math", () => {
  test("maxRetries returns 0 when not retryable", () => {
    expect(maxRetries(5, false)).toBe(0);
  });

  test("maxRetries reads a bare number and an object", () => {
    expect(maxRetries(3, true)).toBe(3);
    expect(maxRetries({ max: 4 }, true)).toBe(4);
    expect(maxRetries(undefined, true)).toBe(0);
  });

  test("retryBackoff uses a custom curve when provided", () => {
    const err = new FilesError("Provider", "x");
    expect(
      retryBackoff({ backoff: ({ attempt }) => attempt * 10, max: 3 }, 2, err)
    ).toBe(20);
  });

  test("retryBackoff defaults to a capped exponential curve", () => {
    const err = new FilesError("Provider", "x");
    expect(retryBackoff(undefined, 1, err)).toBe(100);
    expect(retryBackoff(undefined, 2, err)).toBe(200);
    // Large attempt counts saturate at the 30s cap.
    expect(retryBackoff(20, 50, err)).toBe(30_000);
  });

  test("canRetry gates on attempt count, code, and abort flag", () => {
    const provider = new FilesError("Provider", "x");
    expect(canRetry(provider, 0, 2)).toBe(true);
    // At the attempt cap, no further retries.
    expect(canRetry(provider, 2, 2)).toBe(false);
    expect(canRetry(new FilesError("NotFound", "x"), 0, 2)).toBe(false);
    const aborted = new FilesError("Provider", "x", undefined, {
      aborted: true,
    });
    expect(canRetry(aborted, 0, 2)).toBe(false);
    // Deterministic failures (range ignored, bad delimiter) opt out of the
    // Provider-implies-transient presumption.
    const permanent = new FilesError("Provider", "x", undefined, {
      permanent: true,
    });
    expect(canRetry(permanent, 0, 2)).toBe(false);
  });
});
