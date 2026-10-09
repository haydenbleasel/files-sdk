import type { ConditionalFilesOperation } from "../index.js";
import { FilesError } from "./errors.js";

/**
 * Veto a conditional operation from inside a plugin's `wrap`, before any
 * provider I/O.
 *
 * The dispatcher already fails closed on everything that crosses `next()` —
 * a dropped or changed predicate, a rerouted verb, a second native call, a
 * synthesized result. What it cannot see is a side effect a plugin performs
 * on its own (a snapshot copy, a write to another backend, a pointer rewrite)
 * that would be left uncoupled from the native compare-and-set. A plugin with
 * that kind of out-of-band mutation must veto the modes it cannot make atomic;
 * this is the one shape every bundled plugin uses for it, so the resulting
 * `FilesError` is uniform: `Unsupported`-coded (so `permanent`), and worded as
 * `<plugin>: conditional <kind> is unsupported because <reason>`.
 *
 * @throws {FilesError} always
 */
export const rejectConditional = (
  op: Pick<ConditionalFilesOperation, "kind">,
  plugin: string,
  reason: string
): never => {
  throw new FilesError(
    "Unsupported",
    `${plugin}: conditional ${op.kind} is unsupported because ${reason}`
  );
};
