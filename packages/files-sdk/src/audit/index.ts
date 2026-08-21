import { isConditionalOperation } from "../index.js";
import type {
  ConditionalActionType,
  ConditionalFilesOperation,
  FilesActionType,
  FilesOperation,
  FilesPlugin,
  PluginNext,
  UploadResult,
} from "../index.js";
import { FilesError } from "../internal/errors.js";
import type { FilesErrorCode } from "../internal/errors.js";

const conditionalAction = (
  op: ConditionalFilesOperation
): ConditionalActionType => {
  if (op.kind === "upload") {
    return op.mode;
  }
  if (op.kind === "download") {
    return "exact-read";
  }
  if (op.kind === "delete") {
    return "match-delete";
  }
  return "conditional-copy";
};

/**
 * The mutating verbs, audited by default — the same set the SDK treats as
 * writes. `signedUploadUrl` is here because minting an upload capability is a
 * write you want on the record (who was handed the ability to upload).
 */
const WRITE_ACTIONS: readonly FilesActionType[] = [
  "upload",
  "delete",
  "copy",
  "move",
  "signedUploadUrl",
];

/** Every public verb — what `events: "all"` audits (reads included). */
const ALL_ACTIONS: readonly FilesActionType[] = [
  "upload",
  "download",
  "head",
  "exists",
  "delete",
  "copy",
  "move",
  "list",
  "url",
  "signedUploadUrl",
];

/**
 * One structured who/what/when entry handed to {@link AuditOptions.sink} after
 * an operation settles — richer than a {@link FilesActionEvent} and written
 * through an **awaited** sink, so it can be durably persisted before the call
 * returns. Keys are always the caller-facing ones, never the internal prefixed
 * path.
 */
export interface AuditRecord {
  /** The verb that ran (mirrors {@link FilesActionType}). */
  action: FilesActionType;
  /** Native conditional primitive, without its ETag predicate. */
  condition?: ConditionalActionType;
  /** Caller-facing key — present for every verb except `copy` / `move` / `list`. */
  key?: string;
  /** `copy` / `move` source. */
  from?: string;
  /** `copy` / `move` destination. */
  to?: string;
  /**
   * Who performed it, from {@link AuditOptions.actor}. Absent when no resolver
   * is configured or it returns `undefined`.
   */
  actor?: string;
  /** When the operation started, in ms since the epoch (from {@link AuditOptions.clock}). */
  at: number;
  /**
   * Wall-clock duration of the logical operation in ms. Plugins sit outside
   * retries, so this covers every retry attempt and any inner plugins, not one
   * provider attempt.
   */
  durationMs: number;
  /** Outcome — `"error"` when the operation threw. */
  status: "success" | "error";
  /** Stored byte size, on a successful `upload` only. */
  size?: number;
  /** Set when this record is one item of a bulk (`[...]`) call. */
  bulk?: true;
  /** Failure detail, on `status: "error"`. */
  error?: { code: FilesErrorCode; message: string };
}

export interface AuditOptions {
  /**
   * Where each {@link AuditRecord} is written. **Awaited** — the operation does
   * not resolve until the sink does, giving you ordering and back-pressure a
   * fire-and-forget {@link FilesHooks} callback can't. Return a promise to do
   * async I/O (insert a row, append to a log).
   *
   * On a **successful** operation a sink that rejects **fails the call**: the
   * mutation already happened but wasn't recorded, and you decide what to do
   * with that (retry, alert) rather than silently losing the entry. On a
   * **failed** operation the original error always wins — a sink that also
   * rejects while recording the failure is suppressed so it can't mask why the
   * call failed. Catch inside your own sink if you'd rather audit best-effort.
   */
  sink: (record: AuditRecord) => void | Promise<void>;
  /**
   * Resolve **who** performed each operation — typically read synchronously
   * from your request context (an `AsyncLocalStorage`). Receives the full
   * {@link FilesOperation}, so you can branch on `op.kind` to read `op.key`,
   * `op.from` / `op.to`, or attribute by prefix. Return `undefined` to leave the
   * record's `actor` unset. Omit to never set one.
   */
  actor?: (op: FilesOperation) => string | undefined;
  /**
   * Which operations to record. Defaults to `"writes"` — the mutating verbs
   * (`upload`, `delete`, `copy`, `move`, `signedUploadUrl`). Pass `"all"` to
   * also audit reads (`download`, `head`, `exists`, `list`, `url`), or an
   * explicit list of verbs to record exactly those.
   */
  events?: "writes" | "all" | readonly FilesActionType[];
  /**
   * The clock used for {@link AuditRecord.at} and `durationMs`. Defaults to
   * `Date.now`. Inject a fake for deterministic timestamps in tests, or a
   * trusted time source.
   */
  clock?: () => number;
}

/** Resolve the {@link AuditOptions.events} setting to the set of audited verbs. */
const auditedKinds = (events: AuditOptions["events"]): Set<FilesActionType> => {
  if (events === "all") {
    return new Set(ALL_ACTIONS);
  }
  if (events === undefined || events === "writes") {
    return new Set(WRITE_ACTIONS);
  }
  return new Set(events);
};

/** Normalize whatever was thrown to a stable `{ code, message }`. */
const errorInfo = (
  failure: unknown
): { code: FilesErrorCode; message: string } => {
  const error = FilesError.wrap(failure);
  return { code: error.code, message: error.message };
};

interface RecordContext {
  actor: string | undefined;
  at: number;
  durationMs: number;
  status: "success" | "error";
  result?: unknown;
  failure?: unknown;
}

/** Assemble the {@link AuditRecord} from the op and its settled outcome. */
const buildRecord = (op: FilesOperation, ctx: RecordContext): AuditRecord => {
  const { actor, at, durationMs, status, result, failure } = ctx;
  // The locus differs per verb: copy/move name from/to, list names nothing.
  let locus: { key: string } | { from: string; to: string } | undefined;
  if (op.kind === "copy" || op.kind === "move") {
    locus = { from: op.from, to: op.to };
  } else if (op.kind !== "list") {
    locus = { key: op.key };
  }
  const hasSize =
    status === "success" &&
    op.kind === "upload" &&
    typeof (result as UploadResult).size === "number";
  const condition: ConditionalActionType | undefined = isConditionalOperation(
    op
  )
    ? conditionalAction(op)
    : undefined;
  return {
    action: op.kind,
    at,
    durationMs,
    status,
    ...locus,
    ...(condition !== undefined && { condition }),
    ...(actor !== undefined && { actor }),
    ...("bulk" in op && op.bulk ? { bulk: true } : {}),
    ...(hasSize && { size: (result as UploadResult).size }),
    ...(status === "error" && { error: errorInfo(failure) }),
  };
};

/**
 * Write a structured who / what / when record of every mutation to an
 * **awaited** sink — the durable, awaitable counterpart to the fire-and-forget
 * {@link FilesHooks} `onAction`. Each audited operation produces one
 * {@link AuditRecord} carrying the verb, the caller-facing key (or `from` /
 * `to`), an optional `actor`, the start time and duration, the outcome, and —
 * on a successful `upload` — the stored size. By default it records the
 * mutating verbs (`upload`, `delete`, `copy`, `move`, `signedUploadUrl`); pass
 * `events: "all"` to also audit reads.
 *
 * Because the sink is **awaited**, the operation doesn't resolve until the
 * record is written. That's the whole reason to reach for this over an
 * `onAction` hook: ordering, back-pressure, and a write failure you can see. On
 * a successful operation a rejecting sink **fails the call** (the mutation
 * happened but wasn't recorded — fail closed, your move); on a failed operation
 * the operation's own error always wins, so a sink problem can never mask why
 * the call failed.
 *
 * Body-transparent: it never buffers, transforms, or reads the body (`size`
 * comes from the upload result's declared metadata, not the bytes), so
 * streaming, range downloads, `url()`, and `signedUploadUrl()` all keep
 * working. It writes **no object metadata** and has **no native dependencies**,
 * so it works on any adapter and a bucket behind it is indistinguishable from
 * one without it.
 *
 * Plugins run **outside** retries, so a call that retries is still **one**
 * record (its `durationMs` spans the retries), and a `wrap` sees caller-facing
 * keys, never the internal prefixed path. Bulk `upload([...])` / `delete([...])`
 * fan out to **one record per item**, each flagged `bulk: true`. Place
 * `audit()` **first** (outermost) so it records the caller's logical intent — a
 * `delete` that an inner [`softDelete()`](/plugins/soft-delete) turns into a
 * `move` is still audited as the `delete` the caller asked for.
 *
 * It's `wrap`-only (adds no methods), so plain `new Files({ plugins })` works.
 *
 * @param options `sink` (required), plus optional `actor`, `events`, `clock`.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { audit } from "files-sdk/audit";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [
 *     audit({
 *       actor: () => currentUser()?.id, // read from your request context
 *       sink: (record) => db.insert("audit_log", record), // awaited
 *     }),
 *   ],
 * });
 *
 * await files.delete("notes.txt");
 * // → sink({ action: "delete", key: "notes.txt", actor: "u_42",
 * //          at: 1717..., durationMs: 12, status: "success" })
 * ```
 */
export const audit = (options: AuditOptions): FilesPlugin => {
  const { sink, actor } = options;
  const audited = auditedKinds(options.events);
  const clock = options.clock ?? Date.now;

  const wrap = (async (
    op: FilesOperation,
    next: PluginNext
  ): Promise<unknown> => {
    if (!audited.has(op.kind)) {
      return next(op);
    }
    const at = clock();
    const who = actor?.(op);
    let result: unknown;
    try {
      result = await next(op);
    } catch (error) {
      // The operation failed: record it best-effort, then re-throw. A sink that
      // also rejects here is suppressed so it can't mask why the call failed.
      try {
        await sink(
          buildRecord(op, {
            actor: who,
            at,
            durationMs: clock() - at,
            failure: error,
            status: "error",
          })
        );
      } catch {
        // suppressed — the operation's own error below is the one that matters
      }
      throw error;
    }
    // Success: the audit write is part of the contract, so a rejecting sink
    // fails the call rather than silently dropping the record.
    await sink(
      buildRecord(op, {
        actor: who,
        at,
        durationMs: clock() - at,
        result,
        status: "success",
      })
    );
    return result;
  }) as NonNullable<FilesPlugin["wrap"]>;

  return { name: "audit", wrap };
};
