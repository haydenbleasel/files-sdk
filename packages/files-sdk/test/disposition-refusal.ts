import { expect } from "bun:test";

import { isDispositionUnsupported } from "../src/internal/errors.js";

/**
 * Assert `pending` rejects with an adapter's branded `responseContentDisposition`
 * refusal — the one the gateway (`files-sdk/api`) recognizes to proxy a
 * download or mint an inline URL without the option.
 */
export const expectDispositionRefusal = async (
  pending: Promise<unknown>
): Promise<void> => {
  const outcome = await pending.then(
    () => "resolved",
    (error: unknown) => error
  );
  expect(isDispositionUnsupported(outcome)).toBe(true);
};
