// The dispatch core. Maps a `ParsedRequest` to a `ResultModel` by routing each
// wire op through the deny-by-default authorize gate, applying the resolved
// scope (key prefix, expiry clamp, bulk filter), calling `Files`, and shaping
// the response. It throws `RouterError`/`FilesError` on failure; the public
// `handle` (api/index.ts) converts those to the error envelope. The only Web
// type it touches is `Request` — forwarded opaquely to `authorize` — so the
// dispatch itself stays framework-free and is driven by constructing requests.

import type { Files } from "../../index.js";
import type { FilesError } from "../errors.js";
import { RouterError } from "../router-core/envelope.js";
import type { AllowedOrigins } from "../router-core/origin.js";
import { isOriginAllowed } from "../router-core/origin.js";
import type { ParsedRequest, ResultModel } from "../router-core/web.js";
import type { Authorize, AuthorizeContext, Scope } from "./authorize.js";
import { runAuthorize } from "./authorize.js";
import type { DownloadConfig } from "./download.js";
import { handleDownload } from "./download.js";
import { assertSafePrefix, scopeKey, unscopeKey } from "./keys.js";
import type {
  ClientFileInfo,
  FilesOperation,
  WireBulkError,
  WireStoredFile,
} from "./protocol.js";
import { bulkErrorToWire, storedFileToWire } from "./serialize.js";
import type { UploadConfig } from "./upload.js";
import {
  handleComplete,
  handleExplicitUpload,
  handlePresign,
  handleProxyUpload,
} from "./upload.js";

export interface HandlerContext {
  files: Files;
  authorize?: Authorize;
  operations?: ReadonlySet<FilesOperation>;
  allowedOrigins?: AllowedOrigins;
  secret: string;
  req: Request;
  defaultExpiresIn: number;
  forceDisposition: boolean;
  maxListLimit: number;
  maxSearchResults: number;
  maxUploadSize?: number;
  downloadMode: "auto" | "redirect" | "proxy";
  onUnsupportedRange: "reject" | "ignore";
  proxyUrl: (token: string) => string;
  now: () => number;
}

// --- request-shape validators (throw 422 on a bad client payload) ---

const fail = (message: string): never => {
  throw new RouterError("Validation", message);
};

const asRecord = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("expected a JSON object body");
  }
  return value as Record<string, unknown>;
};

const str = (value: unknown, field: string): string =>
  typeof value === "string" ? value : fail(`expected string: ${field}`);

const num = (value: unknown, field: string): number =>
  typeof value === "number" ? value : fail(`expected number: ${field}`);

const strArray = (value: unknown, field: string): string[] => {
  if (!Array.isArray(value) || value.some((x) => typeof x !== "string")) {
    return fail(`expected string[]: ${field}`);
  }
  return value as string[];
};

const optStr = (value: unknown, field: string): string | undefined =>
  value === undefined ? undefined : str(value, field);

const optNum = (value: unknown, field: string): number | undefined =>
  value === undefined ? undefined : num(value, field);

const optBool = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "boolean"
    ? value
    : fail(`expected boolean: ${field}`);
};

const fileInfos = (value: unknown): ClientFileInfo[] => {
  if (!Array.isArray(value) || value.length === 0) {
    return fail("expected a non-empty files[]");
  }
  return value.map((item) => {
    const r = asRecord(item);
    return {
      name: str(r.name, "name"),
      size: num(r.size, "size"),
      type: str(r.type, "type"),
    };
  });
};

const completions = (value: unknown): { id: string; key: string }[] => {
  if (!Array.isArray(value)) {
    return fail("expected completions[]");
  }
  return value.map((item) => {
    const r = asRecord(item);
    return { id: str(r.id, "id"), key: str(r.key, "key") };
  });
};

// --- shared helpers ---

const json = (body: unknown): ResultModel => ({
  body,
  kind: "json",
  status: 200,
});

const unscoper = (scope: Scope) => (key: string) =>
  unscopeKey(scope.prefix, key);

const bulkErrors = (
  errors: { key: string; error: FilesError }[] | undefined,
  unscope: (key: string) => string
): WireBulkError[] | undefined =>
  errors?.length
    ? errors.map((e) => bulkErrorToWire(e.error, e.key, unscope))
    : undefined;

const uploadCfg = (ctx: HandlerContext): UploadConfig => ({
  defaultExpiresIn: ctx.defaultExpiresIn,
  files: ctx.files,
  maxUploadSize: ctx.maxUploadSize,
  now: ctx.now,
  proxyUrl: ctx.proxyUrl,
  secret: ctx.secret,
});

const downloadCfg = (ctx: HandlerContext): DownloadConfig => ({
  defaultExpiresIn: ctx.defaultExpiresIn,
  downloadMode: ctx.downloadMode,
  files: ctx.files,
  forceDisposition: ctx.forceDisposition,
  onUnsupportedRange: ctx.onUnsupportedRange,
});

const requireOrigin = (ctx: HandlerContext, parsed: ParsedRequest): void => {
  if (!isOriginAllowed(parsed.origin, ctx.allowedOrigins)) {
    throw new RouterError("Forbidden", "origin not allowed", "origin");
  }
};

const authorizeOp = (
  ctx: HandlerContext,
  partial: Omit<AuthorizeContext, "req">
): Promise<Scope> =>
  runAuthorize(ctx.authorize, ctx.operations, { req: ctx.req, ...partial });

const clampExpiry = (
  ctx: HandlerContext,
  requested: number,
  scope: Scope
): number => {
  let value = requested;
  if (scope.maxExpiresIn !== undefined) {
    value = Math.min(value, scope.maxExpiresIn);
  }
  const capMax = ctx.files.capabilities.signedUrl.maxExpiresIn;
  if (capMax !== undefined) {
    value = Math.min(value, capMax);
  }
  return value;
};

const filtered = (scope: Scope, keys: string[]): string[] =>
  scope.filterKeys ? keys.filter(scope.filterKeys) : keys;

// --- JSON op dispatch ---

// oxlint-disable-next-line complexity -- a flat per-op dispatch table; each arm is a thin call.
const dispatchJson = async (
  ctx: HandlerContext,
  parsed: ParsedRequest
): Promise<ResultModel> => {
  const body = asRecord(parsed.json);
  const op = str(body.op, "op");
  const { signal } = parsed;

  switch (op) {
    case "head": {
      const key = str(body.key, "key");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "head",
        params: {},
      });
      const file = await ctx.files.head(scopeKey(scope.prefix, key), {
        signal,
      });
      return json({ file: storedFileToWire(file, unscoper(scope)) });
    }
    case "head-many": {
      requireOrigin(ctx, parsed);
      const keys = strArray(body.keys, "keys");
      const scope = await authorizeOp(ctx, {
        keys,
        operation: "head",
        params: {},
      });
      const unscope = unscoper(scope);
      const result = await ctx.files.head(
        filtered(scope, keys).map((k) => scopeKey(scope.prefix, k)),
        {
          concurrency: optNum(body.concurrency, "concurrency"),
          stopOnError: optBool(body.stopOnError, "stopOnError"),
        }
      );
      return json({
        files: result.files.map((f) => storedFileToWire(f, unscope)),
        ...(bulkErrors(result.errors, unscope)
          ? { errors: bulkErrors(result.errors, unscope) }
          : {}),
      });
    }
    case "exists": {
      const key = str(body.key, "key");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "exists",
        params: {},
      });
      const exists = await ctx.files.exists(scopeKey(scope.prefix, key), {
        signal,
      });
      return json({ exists });
    }
    case "exists-many": {
      const keys = strArray(body.keys, "keys");
      const scope = await authorizeOp(ctx, {
        keys,
        operation: "exists",
        params: {},
      });
      const unscope = unscoper(scope);
      const result = await ctx.files.exists(
        filtered(scope, keys).map((k) => scopeKey(scope.prefix, k)),
        {
          concurrency: optNum(body.concurrency, "concurrency"),
          stopOnError: optBool(body.stopOnError, "stopOnError"),
        }
      );
      return json({
        existing: result.existing.map(unscope),
        missing: result.missing.map(unscope),
        ...(bulkErrors(result.errors, unscope)
          ? { errors: bulkErrors(result.errors, unscope) }
          : {}),
      });
    }
    case "delete": {
      requireOrigin(ctx, parsed);
      const key = str(body.key, "key");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "delete",
        params: {},
      });
      await ctx.files.delete(scopeKey(scope.prefix, key), { signal });
      return json({ ok: true });
    }
    case "delete-many": {
      requireOrigin(ctx, parsed);
      const keys = strArray(body.keys, "keys");
      const scope = await authorizeOp(ctx, {
        keys,
        operation: "delete",
        params: {},
      });
      const unscope = unscoper(scope);
      const result = await ctx.files.delete(
        filtered(scope, keys).map((k) => scopeKey(scope.prefix, k)),
        {
          concurrency: optNum(body.concurrency, "concurrency"),
          stopOnError: optBool(body.stopOnError, "stopOnError"),
        }
      );
      return json({
        deleted: result.deleted.map(unscope),
        ...(bulkErrors(result.errors, unscope)
          ? { errors: bulkErrors(result.errors, unscope) }
          : {}),
      });
    }
    case "copy":
    case "move": {
      requireOrigin(ctx, parsed);
      const from = str(body.from, "from");
      const to = str(body.to, "to");
      const scope = await authorizeOp(ctx, {
        from,
        operation: op,
        params: {},
        to,
      });
      const storageFrom = scopeKey(scope.prefix, from);
      const storageTo = scopeKey(scope.prefix, to);
      await (op === "copy"
        ? ctx.files.copy(storageFrom, storageTo, { signal })
        : ctx.files.move(storageFrom, storageTo, { signal }));
      return json({ ok: true });
    }
    case "url": {
      const key = str(body.key, "key");
      const expiresIn = optNum(body.expiresIn, "expiresIn");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "url",
        params: { expiresIn },
      });
      const disposition =
        scope.disposition ??
        optStr(body.responseContentDisposition, "responseContentDisposition");
      const url = await ctx.files.url(scopeKey(scope.prefix, key), {
        expiresIn: clampExpiry(ctx, expiresIn ?? ctx.defaultExpiresIn, scope),
        ...(disposition ? { responseContentDisposition: disposition } : {}),
      });
      return json({ url });
    }
    case "list": {
      const scope = await authorizeOp(ctx, { operation: "list", params: {} });
      const clientPrefix = optStr(body.prefix, "prefix") ?? "";
      assertSafePrefix(clientPrefix);
      const listPrefix = scope.prefix + clientPrefix;
      const limit = Math.min(
        optNum(body.limit, "limit") ?? ctx.maxListLimit,
        ctx.maxListLimit
      );
      const unscope = unscoper(scope);
      const result = await ctx.files.list({
        limit,
        signal,
        ...(listPrefix ? { prefix: listPrefix } : {}),
        ...(body.cursor === undefined
          ? {}
          : { cursor: str(body.cursor, "cursor") }),
        ...(body.delimiter === undefined
          ? {}
          : { delimiter: str(body.delimiter, "delimiter") }),
      });
      return json({
        items: result.items.map((f) => storedFileToWire(f, unscope)),
        ...(result.prefixes ? { prefixes: result.prefixes.map(unscope) } : {}),
        ...(result.cursor ? { cursor: result.cursor } : {}),
      });
    }
    case "search": {
      const scope = await authorizeOp(ctx, { operation: "search", params: {} });
      const clientPrefix = optStr(body.prefix, "prefix") ?? "";
      assertSafePrefix(clientPrefix);
      const searchPrefix = scope.prefix + clientPrefix;
      const pattern = optBool(body.isRegex, "isRegex")
        ? new RegExp(
            str(body.pattern, "pattern"),
            optStr(body.flags, "flags") ?? "u"
          )
        : str(body.pattern, "pattern");
      const cap = Math.min(
        optNum(body.maxResults, "maxResults") ?? ctx.maxSearchResults,
        scope.maxResults ?? ctx.maxSearchResults,
        ctx.maxSearchResults
      );
      const unscope = unscoper(scope);
      const matches: WireStoredFile[] = [];
      let truncated = false;
      for await (const file of ctx.files.search(pattern, {
        signal,
        ...(optStr(body.match, "match") ? { match: body.match as never } : {}),
        ...(optBool(body.caseInsensitive, "caseInsensitive") === undefined
          ? {}
          : { caseInsensitive: body.caseInsensitive as boolean }),
        ...(optNum(body.limit, "limit") ? { limit: body.limit as number } : {}),
        ...(searchPrefix ? { prefix: searchPrefix } : {}),
      })) {
        if (matches.length >= cap) {
          truncated = true;
          break;
        }
        matches.push(storedFileToWire(file, unscope));
      }
      return json({ matches, truncated });
    }
    case "capabilities": {
      await authorizeOp(ctx, { operation: "capabilities", params: {} });
      return json({ capabilities: ctx.files.capabilities });
    }
    case "signed-upload-url": {
      requireOrigin(ctx, parsed);
      const key = str(body.key, "key");
      const expiresIn = num(body.expiresIn, "expiresIn");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "signedUploadUrl",
        params: { expiresIn },
      });
      const signed = await ctx.files.signedUploadUrl(
        scopeKey(scope.prefix, key),
        {
          expiresIn: clampExpiry(ctx, expiresIn, scope),
          ...(optStr(body.contentType, "contentType")
            ? { contentType: body.contentType as string }
            : {}),
          ...(optNum(body.maxSize, "maxSize") === undefined
            ? {}
            : { maxSize: body.maxSize as number }),
          ...(optNum(body.minSize, "minSize") === undefined
            ? {}
            : { minSize: body.minSize as number }),
        }
      );
      return json({ signed });
    }
    case "presign": {
      requireOrigin(ctx, parsed);
      const files = fileInfos(body.files);
      const scope = await authorizeOp(ctx, { operation: "upload", params: {} });
      return handlePresign(
        uploadCfg(ctx),
        files,
        optNum(body.expiresIn, "expiresIn"),
        scope,
        unscoper(scope)
      );
    }
    case "complete": {
      requireOrigin(ctx, parsed);
      const items = completions(body.completions);
      const scope = await authorizeOp(ctx, { operation: "upload", params: {} });
      return handleComplete(uploadCfg(ctx), items, unscoper(scope));
    }
    default: {
      return fail(`unknown op: ${op}`);
    }
  }
};

export const dispatch = async (
  ctx: HandlerContext,
  parsed: ParsedRequest
): Promise<ResultModel> => {
  if (parsed.method === "GET" && parsed.action === "download") {
    const key = parsed.query.get("key");
    if (!key) {
      throw new RouterError("Validation", "download requires a key", "key");
    }
    const scope = await authorizeOp(ctx, {
      key,
      operation: "download",
      params: {},
    });
    return handleDownload(
      downloadCfg(ctx),
      scopeKey(scope.prefix, key),
      key,
      parsed.rangeHeader,
      scope,
      parsed.signal
    );
  }

  if (parsed.method === "PUT" && parsed.action === "upload") {
    requireOrigin(ctx, parsed);
    const key = parsed.query.get("key");
    if (!key) {
      throw new RouterError("Validation", "upload requires a key", "key");
    }
    const scope = await authorizeOp(ctx, {
      key,
      operation: "upload",
      params: {},
    });
    return handleExplicitUpload(
      uploadCfg(ctx),
      scopeKey(scope.prefix, key),
      key,
      parsed.bodyStream,
      parsed.contentType,
      parsed.contentLength
    );
  }

  if (parsed.method === "PUT" && parsed.action === "proxy") {
    requireOrigin(ctx, parsed);
    return handleProxyUpload(
      uploadCfg(ctx),
      parsed.query.get("token"),
      parsed.bodyStream,
      parsed.contentLength
    );
  }

  if (parsed.method === "POST") {
    return dispatchJson(ctx, parsed);
  }

  throw new RouterError("Validation", `unsupported request: ${parsed.method}`);
};
