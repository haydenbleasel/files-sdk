import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Span, Tracer } from "@opentelemetry/api";

import { isConditionalOperation } from "../index.js";
import type {
  ConditionalActionType,
  ConditionalFilesOperation,
  FilesOperation,
  FilesPlugin,
  ListResult,
  PluginNext,
  StoredFile,
  UploadResult,
} from "../index.js";

/** Span name prefix when {@link TracingOptions.spanPrefix} is omitted. */
const DEFAULT_SPAN_PREFIX = "files.";

/** Instrumentation name used for the default tracer. */
const INSTRUMENTATION_NAME = "files-sdk";

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

export interface TracingOptions {
  /**
   * The tracer spans are created on. Defaults to
   * `trace.getTracer("files-sdk")` — the global tracer from `@opentelemetry/api`
   * — so with an OpenTelemetry SDK registered it just works. Pass your own to
   * scope the instrumentation name/version or to inject a tracer in tests.
   */
  tracer?: Tracer;
  /**
   * Prefix for span names. Each operation becomes `${spanPrefix}${op.kind}` —
   * the default `"files."` yields `files.upload`, `files.download`, etc. Names
   * stay deliberately low-cardinality (the key lives in an attribute, not the
   * name) so traces group cleanly.
   */
  spanPrefix?: string;
  /**
   * Add or override attributes per operation. Receives the full
   * {@link FilesOperation} and is merged **over** the built-ins, so it can
   * attach context (a tenant id, a request id) or redact a default by returning
   * it as `undefined` — e.g. `{ "files.key": undefined }` to keep keys out of
   * your traces. Return nothing to add none.
   */
  attributes?: (op: FilesOperation) => Attributes | undefined;
}

/** Caller-facing attributes known before the operation runs. */
const baseAttributes = (op: FilesOperation): Attributes => {
  const attributes: Attributes = { "files.operation": op.kind };
  if (isConditionalOperation(op)) {
    attributes["files.condition"] = conditionalAction(op);
  }
  if (op.kind === "copy" || op.kind === "move") {
    attributes["files.from"] = op.from;
    attributes["files.to"] = op.to;
  } else if (op.kind !== "list") {
    attributes["files.key"] = op.key;
  }
  if ("bulk" in op && op.bulk) {
    attributes["files.bulk"] = true;
  }
  return attributes;
};

/**
 * Cheap, body-transparent attributes pulled from a successful result — the
 * stored size, the `exists` verdict, the listed count. Reads only declared
 * properties, never the body, so streaming and ranges are untouched.
 */
const resultAttributes = (
  op: FilesOperation,
  result: unknown
): Attributes | undefined => {
  if (op.kind === "upload") {
    return { "files.size": (result as UploadResult).size };
  }
  if (op.kind === "download" || op.kind === "head") {
    const { size } = result as StoredFile;
    return typeof size === "number" ? { "files.size": size } : undefined;
  }
  if (op.kind === "exists") {
    return { "files.exists": result as boolean };
  }
  if (op.kind === "list") {
    return { "files.count": (result as ListResult).items.length };
  }
  return undefined;
};

/**
 * Open an OpenTelemetry span around every operation on a {@link Files}
 * instance. Each call becomes one span named `files.<verb>` carrying the
 * caller-facing key (or `from` / `to` for `copy` / `move`), a `files.bulk` flag
 * for batch items, and a cheap result attribute on success (`files.size`,
 * `files.exists`, `files.count`). A throw is recorded on the span with
 * `recordException` and an `ERROR` status, then re-thrown untouched.
 *
 * Spans are opened with `startActiveSpan`, so they nest correctly: each op span
 * is a child of whatever span is active when you call, and any sub-operation an
 * inner plugin issues — or an `extend` method calling back into the instance —
 * becomes a child of the op span in turn.
 *
 * Body-transparent: it never buffers, transforms, or reads the body (result
 * attributes come from declared metadata, not bytes), so streaming, range
 * downloads, `url()`, and `signedUploadUrl()` all keep working on any adapter.
 *
 * `@opentelemetry/api` is an **optional peer dependency**. The tracer defaults
 * to the global `trace.getTracer("files-sdk")`, which is a no-op until you
 * register an OpenTelemetry SDK — so installing the plugin costs nothing until
 * you wire up an exporter.
 *
 * Plugins run **outside** retries, so a span covers the whole logical call
 * including every retry attempt, not one span per attempt. Place `tracing()`
 * **first** (outermost) so the span wraps the caller-facing operation and the
 * work of inner plugins shows up nested beneath it; place it last to time only
 * the provider call.
 *
 * @param options optional `{ tracer, spanPrefix, attributes }`.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { tracing } from "files-sdk/tracing";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [tracing()], // uses the global tracer
 * });
 *
 * await files.upload("a.txt", "hello"); // → span "files.upload" { files.key, files.size }
 * ```
 */
export const tracing = (options: TracingOptions = {}): FilesPlugin => {
  const { attributes: customAttributes } = options;
  const tracer = options.tracer ?? trace.getTracer(INSTRUMENTATION_NAME);
  const spanPrefix = options.spanPrefix ?? DEFAULT_SPAN_PREFIX;

  const wrap = ((op: FilesOperation, next: PluginNext): Promise<unknown> =>
    tracer.startActiveSpan(
      `${spanPrefix}${op.kind}`,
      { attributes: { ...baseAttributes(op), ...customAttributes?.(op) } },
      async (span: Span) => {
        try {
          const result = await next(op);
          const extra = resultAttributes(op, result);
          if (extra) {
            span.setAttributes(extra);
          }
          return result;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          span.end();
        }
      }
    )) as NonNullable<FilesPlugin["wrap"]>;

  return { name: "tracing", wrap };
};
