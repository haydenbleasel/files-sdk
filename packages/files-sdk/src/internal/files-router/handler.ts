// The dispatch core. Maps a `ParsedRequest` to a `ResultModel` by routing each
// wire op through the deny-by-default authorize gate, applying the resolved
// scope (key prefix, expiry clamp, bulk filter), calling `Files`, and shaping
// the response. It throws `RouterError`/`FilesError` on failure; the public
// `handle` (api/index.ts) converts those to the error envelope. The only Web
// type it touches is `Request` — forwarded opaquely to `authorize` — so the
// dispatch itself stays framework-free and is driven by constructing requests.

import type { FileInfo, Files, SearchMatch } from "../../index.js";
import { isAttachmentDisposition } from "../content-disposition.js";
import { FilesError, isDispositionUnsupported } from "../errors.js";
import { globPrefix } from "../glob.js";
import { isBoolean, isFunction, isNumber, isString } from "../is.js";
import type { JsonObject, JsonValue } from "../json.js";
import { isJsonArray, isJsonObject } from "../json.js";
import { RouterError } from "../router-core/envelope.js";
import type { AllowedOrigins } from "../router-core/origin.js";
import { isOriginAllowed } from "../router-core/origin.js";
import type { ParsedRequest, ResultModel } from "../router-core/web.js";
import type { SearchPatternLimits } from "../search-matcher.js";
import {
  SEARCH_MATCHES,
  buildSearchMatcher,
  isSearchMatch,
  searchPatternProblem,
} from "../search-matcher.js";
import { isSafeSearchRegex } from "../search-regex.js";
import type { Authorize, AuthorizeContext, Scope } from "./authorize.js";
import { runAuthorize } from "./authorize.js";
import type { DownloadConfig } from "./download.js";
import { handleDownload, urlWithDisposition } from "./download.js";
import { assertSafePrefix, scopeKey, unscopeKey } from "./keys.js";
import type {
  ClientFileInfo,
  FilesOperation,
  WireBulkError,
  WireFileInfo,
  WireFileVersion,
  WireTrashedFile,
} from "./protocol.js";
import { bulkErrorToWire, fileInfoToWire } from "./serialize.js";
import type {
  CompletionStore,
  OnUploadComplete,
  UploadData,
} from "./upload-complete.js";
import type { UploadConfig } from "./upload.js";
import {
  boundQuery,
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
  /** Cap on `keys[]` / `files[]` / `completions[]` in one request. */
  maxBatchSize: number;
  /** Ceiling on a bulk request's client-supplied `concurrency`. */
  maxConcurrency: number;
  /** Complexity bounds on a `search` pattern. */
  searchPatternLimits: SearchPatternLimits;
  downloadMode: "auto" | "redirect" | "proxy";
  onUnsupportedRange: "reject" | "ignore";
  proxyUrl: (token: string) => string;
  now: () => number;
  onUploadComplete?: OnUploadComplete<UploadData>;
  onRejected: "delete" | "keep";
  completions?: CompletionStore;
}

// --- request-shape validators (throw 422 on a bad client payload) ---

const fail = (message: string): never => {
  throw new RouterError("Validation", message);
};

const asRecord = (value: JsonValue | undefined): JsonObject =>
  isJsonObject(value) ? value : fail("expected a JSON object body");

// Field readers: each takes the decoded object and a field name, so the
// 422 message names the field and the read is checked in one place.

const str = (record: JsonObject, field: string): string => {
  const value = record[field];
  return isString(value) ? value : fail(`expected string: ${field}`);
};

const num = (record: JsonObject, field: string): number => {
  const value = record[field];
  return isNumber(value) ? value : fail(`expected number: ${field}`);
};

const strArray = (record: JsonObject, field: string): string[] => {
  const value = record[field];
  if (!isJsonArray(value) || !value.every(isString)) {
    return fail(`expected string[]: ${field}`);
  }
  return value;
};

const optStr = (record: JsonObject, field: string): string | undefined =>
  record[field] === undefined ? undefined : str(record, field);

const optNum = (record: JsonObject, field: string): number | undefined =>
  record[field] === undefined ? undefined : num(record, field);

const optBool = (record: JsonObject, field: string): boolean | undefined => {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  return isBoolean(value) ? value : fail(`expected boolean: ${field}`);
};

const routerUrlDisposition = (
  requested: string | undefined,
  serverDisposition: string | undefined
): string => {
  if (serverDisposition) {
    return serverDisposition;
  }
  return isAttachmentDisposition(requested) ? requested : "attachment";
};

// The `url` op on an adapter that can't bind any disposition into its URLs:
// the gateway's `attachment` default can't be guaranteed, so fail loud and say
// how to proceed rather than hand out a URL that may render inline.
const URL_DISPOSITION_REFUSED =
  'url: this adapter cannot set Content-Disposition on its URLs, so the gateway cannot guarantee "attachment". Return { disposition: "inline" } from authorize for routes where inline URLs are acceptable, or use download, which proxies the bytes and sets Content-Disposition itself.';

// A bulk request's array length is client-controlled work (one provider call
// per entry), so cap it before touching storage: 413 with reason `count`.
const capBatch = (ctx: HandlerContext, field: string, length: number): void => {
  if (length > ctx.maxBatchSize) {
    throw new RouterError(
      "Validation",
      `too many ${field}: ${length} (at most ${ctx.maxBatchSize})`,
      "count",
      413
    );
  }
};

const keyBatch = (ctx: HandlerContext, record: JsonObject): string[] => {
  const keys = strArray(record, "keys");
  capBatch(ctx, "keys", keys.length);
  return keys;
};

// The client's bulk fan-out, clamped to the router ceiling (and at least 1).
const bulkConcurrency = (
  ctx: HandlerContext,
  record: JsonObject
): number | undefined => {
  const requested = optNum(record, "concurrency");
  return requested === undefined
    ? undefined
    : Math.max(1, Math.min(Math.floor(requested), ctx.maxConcurrency));
};

const fileInfos = (ctx: HandlerContext, body: JsonObject): ClientFileInfo[] => {
  const value = body.files;
  if (!isJsonArray(value) || value.length === 0) {
    return fail("expected a non-empty files[]");
  }
  capBatch(ctx, "files", value.length);
  return value.map((item) => {
    const r = asRecord(item);
    return {
      name: str(r, "name"),
      size: num(r, "size"),
      type: str(r, "type"),
    };
  });
};

const completions = (
  ctx: HandlerContext,
  body: JsonObject
): { id: string; key: string }[] => {
  const value = body.completions;
  if (!isJsonArray(value)) {
    return fail("expected completions[]");
  }
  capBatch(ctx, "completions", value.length);
  return value.map((item) => {
    const r = asRecord(item);
    return { id: str(r, "id"), key: str(r, "key") };
  });
};

// --- shared helpers ---

const json = <T extends object>(body: T): ResultModel => ({
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

const uploadCfg = (
  ctx: HandlerContext,
  parsed: ParsedRequest,
  scope?: Scope
): UploadConfig => ({
  boundPath: parsed.path,
  boundQuery: boundQuery(parsed.query),
  defaultExpiresIn: ctx.defaultExpiresIn,
  files: ctx.files,
  lifecycle: {
    completions: ctx.completions,
    context: scope?.context,
    onRejected: ctx.onRejected,
    onUploadComplete: ctx.onUploadComplete,
    req: ctx.req,
  },
  maxUploadSize: ctx.maxUploadSize,
  now: ctx.now,
  proxyUrl: ctx.proxyUrl,
  secret: ctx.secret,
  signal: parsed.signal,
});

const downloadCfg = (ctx: HandlerContext): DownloadConfig => ({
  defaultExpiresIn: ctx.defaultExpiresIn,
  downloadMode: ctx.downloadMode,
  files: ctx.files,
  forceDisposition: ctx.forceDisposition,
  onUnsupportedRange: ctx.onUnsupportedRange,
});

// Under an authorize `keyPrefix` scope the pattern is matched against the
// caller-facing key (the prefix stripped), so `*.png` / `^a` / exact `a.png`
// find `users/1/a.png` for a client scoped to `users/1/` — mirroring how `list`
// returns unscoped keys. Without a scope prefix `files.search()` already
// matches the caller-facing key, so it is used as-is (keeping its glob-head
// prefix push-down).
const searchScoped = (
  ctx: HandlerContext,
  scope: Scope,
  q: {
    pattern: string | RegExp;
    match: SearchMatch;
    caseInsensitive: boolean;
    clientPrefix: string;
    searchPrefix: string;
    limit: number | undefined;
    signal: AbortSignal | undefined;
    unscope: (key: string) => string;
  }
): AsyncIterable<FileInfo> => {
  const paging = {
    ...(q.limit && { limit: q.limit }),
    signal: q.signal,
  };
  if (!scope.prefix) {
    return ctx.files.search(q.pattern, {
      ...paging,
      caseInsensitive: q.caseInsensitive,
      match: q.match,
      ...(q.searchPrefix && { prefix: q.searchPrefix }),
    });
  }
  const matches = buildSearchMatcher(q.pattern, q.match, q.caseInsensitive);
  // Same push-down as `files.search()`: a case-sensitive glob's literal head
  // bounds the walk when the client didn't pass its own prefix.
  const globHead =
    isString(q.pattern) && q.match === "glob" && !q.caseInsensitive
      ? globPrefix(q.pattern)
      : undefined;
  const walkPrefix =
    q.clientPrefix || globHead === undefined
      ? q.searchPrefix
      : scope.prefix + globHead;
  const walk = ctx.files.listAll({ ...paging, prefix: walkPrefix });
  return {
    async *[Symbol.asyncIterator]() {
      for await (const file of walk) {
        if (matches(q.unscope(file.key))) {
          yield file;
        }
      }
    },
  };
};

// Compile a client-supplied search regex, refusing (422) one that doesn't
// parse or could backtrack catastrophically.
const searchRegex = (source: string, flags: string): RegExp => {
  let regexp: RegExp;
  try {
    regexp = new RegExp(source, flags);
  } catch {
    throw new RouterError("Validation", "invalid search regex");
  }
  if (!isSafeSearchRegex(regexp)) {
    throw new RouterError("Validation", "search pattern is too complex");
  }
  return regexp;
};

const requireOrigin = (ctx: HandlerContext, parsed: ParsedRequest): void => {
  if (
    !isOriginAllowed(parsed.origin, ctx.allowedOrigins, parsed.requestOrigin)
  ) {
    throw new RouterError("Forbidden", "origin not allowed", "origin");
  }
};

const authorizeOp = (
  ctx: HandlerContext,
  partial: Omit<AuthorizeContext, "req">
): Promise<Scope> =>
  runAuthorize(ctx.authorize, ctx.operations, { req: ctx.req, ...partial });

// Clamp to the `authorize` scope and to the adapter's hard cap for this kind
// of URL — `signedUrl` for downloads, `signedUpload` for direct uploads.
const clampExpiry = (
  ctx: HandlerContext,
  requested: number,
  scope: Scope,
  kind: "signedUpload" | "signedUrl"
): number => {
  let value = requested;
  if (scope.maxExpiresIn !== undefined) {
    value = Math.min(value, scope.maxExpiresIn);
  }
  const capMax = ctx.files.capabilities[kind].maxExpiresIn;
  if (capMax !== undefined) {
    value = Math.min(value, capMax);
  }
  return value;
};

const clampUploadMaxSize = (
  requestedMaxSize: number | undefined,
  maxUploadSize: number | undefined
): number | undefined => {
  if (requestedMaxSize === undefined) {
    return maxUploadSize;
  }
  return maxUploadSize === undefined
    ? requestedMaxSize
    : Math.min(requestedMaxSize, maxUploadSize);
};

const filtered = (scope: Scope, keys: string[]): string[] =>
  scope.filterKeys ? keys.filter(scope.filterKeys) : keys;

// --- plugin verbs (versioning / softDelete) ---

/**
 * The optional methods `versioning()` / `softDelete()` graft onto a `Files`
 * instance. They aren't on the base `Files` type, so the handler feature-detects
 * them and 422s when the matching plugin isn't configured. The two restores are
 * namespaced — `restoreVersion(key, versionId?)` from `versioning`,
 * `restoreTrashed(key)` from `softDelete` — so both plugins can sit on one
 * instance and each wire op maps to exactly one method.
 */
interface PluginMethods {
  versions?: (key: string) => Promise<
    {
      versionId: string;
      size: number;
      lastModified: number;
      etag?: string;
    }[]
  >;
  restoreVersion?: (key: string, versionId?: string) => Promise<FileInfo>;
  trashed?: () => Promise<
    { key: string; size: number; lastModified?: number; etag?: string }[]
  >;
  restoreTrashed?: (key: string) => Promise<FileInfo>;
  purge?: (key?: string) => Promise<void>;
}

// SAFETY: `versioning()` / `softDelete()` graft these methods onto the `Files`
// instance at runtime (Tier C `extend`), so they may or may not be present;
// every member is optional and each call site feature-detects it with
// `isFunction` before invoking, so an absent method is handled, never assumed.
const pluginMethods = (ctx: HandlerContext): PluginMethods =>
  ctx.files as Files & PluginMethods;

const notConfigured = (plugin: string): never => {
  throw new RouterError(
    "Validation",
    `${plugin} plugin is not configured on this gateway`
  );
};

const toWireVersion = (v: {
  versionId: string;
  size: number;
  lastModified: number;
  etag?: string;
}): WireFileVersion => ({
  lastModified: v.lastModified,
  size: v.size,
  versionId: v.versionId,
  ...(v.etag !== undefined && { etag: v.etag }),
});

const toWireTrashed = (t: {
  key: string;
  size: number;
  lastModified?: number;
  etag?: string;
}): WireTrashedFile => ({
  key: t.key,
  size: t.size,
  ...(t.lastModified !== undefined && { lastModified: t.lastModified }),
  ...(t.etag !== undefined && { etag: t.etag }),
});

// --- JSON op dispatch ---

// oxlint-disable-next-line complexity -- a flat per-op dispatch table; each arm is a thin call
const dispatchJson = async (
  ctx: HandlerContext,
  parsed: ParsedRequest
  // oxlint-disable-next-line sonarjs/cognitive-complexity -- a flat per-op dispatch table; each arm is a thin call
): Promise<ResultModel> => {
  const body = asRecord(parsed.json);
  const op = str(body, "op");
  const { signal } = parsed;

  switch (op) {
    case "head": {
      const key = str(body, "key");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "head",
        params: {},
      });
      const file = await ctx.files.head(scopeKey(scope.prefix, key), {
        signal,
      });
      return json({ file: fileInfoToWire(file, unscoper(scope)) });
    }
    case "head-many": {
      const keys = keyBatch(ctx, body);
      const scope = await authorizeOp(ctx, {
        keys,
        operation: "head",
        params: {},
      });
      const unscope = unscoper(scope);
      const result = await ctx.files.head(
        filtered(scope, keys).map((k) => scopeKey(scope.prefix, k)),
        {
          concurrency: bulkConcurrency(ctx, body),
          stopOnError: optBool(body, "stopOnError"),
        }
      );
      const errors = bulkErrors(result.errors, unscope);
      return json({
        results: result.results.map((f) => fileInfoToWire(f, unscope)),
        ...(errors && { errors }),
      });
    }
    case "exists": {
      const key = str(body, "key");
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
      const keys = keyBatch(ctx, body);
      const scope = await authorizeOp(ctx, {
        keys,
        operation: "exists",
        params: {},
      });
      const unscope = unscoper(scope);
      const result = await ctx.files.exists(
        filtered(scope, keys).map((k) => scopeKey(scope.prefix, k)),
        {
          concurrency: bulkConcurrency(ctx, body),
          stopOnError: optBool(body, "stopOnError"),
        }
      );
      const errors = bulkErrors(result.errors, unscope);
      return json({
        existing: result.existing.map(unscope),
        missing: result.missing.map(unscope),
        ...(errors && { errors }),
      });
    }
    case "delete": {
      requireOrigin(ctx, parsed);
      const key = str(body, "key");
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
      const keys = keyBatch(ctx, body);
      const scope = await authorizeOp(ctx, {
        keys,
        operation: "delete",
        params: {},
      });
      const unscope = unscoper(scope);
      const result = await ctx.files.delete(
        filtered(scope, keys).map((k) => scopeKey(scope.prefix, k)),
        {
          concurrency: bulkConcurrency(ctx, body),
          stopOnError: optBool(body, "stopOnError"),
        }
      );
      const errors = bulkErrors(result.errors, unscope);
      return json({
        results: result.results.map(unscope),
        ...(errors && { errors }),
      });
    }
    case "copy":
    case "move": {
      requireOrigin(ctx, parsed);
      const from = str(body, "from");
      const to = str(body, "to");
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
      const key = str(body, "key");
      const expiresIn = optNum(body, "expiresIn");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "url",
        params: { expiresIn },
      });
      const disposition = routerUrlDisposition(
        optStr(body, "responseContentDisposition"),
        scope.disposition
      );
      // The link always carries a disposition, so it's signed whenever the
      // adapter can sign (with the default expiry unless the client asked for
      // one). An adapter that only hands out permanent links gets no
      // `expiresIn` — unless the client asked for one or `authorize` caps the
      // lifetime, where the SDK refuses it (a 422) rather than return a link
      // that outlives what was asked.
      const sign =
        expiresIn !== undefined ||
        scope.maxExpiresIn !== undefined ||
        ctx.files.capabilities.signedUrl.supported;
      try {
        const url = await urlWithDisposition(
          ctx.files,
          scopeKey(scope.prefix, key),
          {
            ...(sign && {
              expiresIn: clampExpiry(
                ctx,
                expiresIn ?? ctx.defaultExpiresIn,
                scope,
                "signedUrl"
              ),
            }),
            signal,
          },
          disposition,
          scope.disposition
        );
        return json({ url });
      } catch (error) {
        if (isDispositionUnsupported(error)) {
          throw new FilesError("Unsupported", URL_DISPOSITION_REFUSED, error);
        }
        throw error;
      }
    }
    case "list": {
      const scope = await authorizeOp(ctx, { operation: "list", params: {} });
      const clientPrefix = optStr(body, "prefix") ?? "";
      assertSafePrefix(clientPrefix);
      const listPrefix = scope.prefix + clientPrefix;
      const limit = Math.min(
        optNum(body, "limit") ?? ctx.maxListLimit,
        scope.maxResults ?? ctx.maxListLimit,
        ctx.maxListLimit
      );
      const unscope = unscoper(scope);
      const result = await ctx.files.list({
        limit,
        signal,
        ...(listPrefix && { prefix: listPrefix }),
        ...(body.cursor !== undefined && { cursor: str(body, "cursor") }),
        ...(body.delimiter !== undefined && {
          delimiter: str(body, "delimiter"),
        }),
      });
      return json({
        items: result.items.map((f) => fileInfoToWire(f, unscope)),
        ...(result.prefixes && { prefixes: result.prefixes.map(unscope) }),
        ...(result.cursor && { cursor: result.cursor }),
      });
    }
    case "search": {
      const scope = await authorizeOp(ctx, { operation: "search", params: {} });
      const clientPrefix = optStr(body, "prefix") ?? "";
      assertSafePrefix(clientPrefix);
      const searchPrefix = scope.prefix + clientPrefix;
      const match = optStr(body, "match") ?? "glob";
      if (!isSearchMatch(match)) {
        return fail(
          `expected one of ${SEARCH_MATCHES.map((m) => `"${m}"`).join(" | ")}: match`
        );
      }
      const caseInsensitive = optBool(body, "caseInsensitive") ?? false;
      const requestedLimit = optNum(body, "limit");
      const pageLimit =
        requestedLimit === undefined
          ? undefined
          : Math.min(requestedLimit, ctx.maxListLimit);
      let pattern: string | RegExp;
      if (optBool(body, "isRegex")) {
        pattern = searchRegex(
          str(body, "pattern"),
          optStr(body, "flags") ?? "u"
        );
      } else {
        pattern = str(body, "pattern");
        if (match === "regex") {
          // Compile it here, with the flags `files.search()` would use, so a
          // bad pattern is the same 422 as the `isRegex` form rather than a
          // `Provider` 500 from the matcher.
          searchRegex(pattern, caseInsensitive ? "iu" : "u");
        }
      }
      const problem = searchPatternProblem(
        pattern,
        match,
        caseInsensitive,
        ctx.searchPatternLimits
      );
      if (problem) {
        throw new RouterError("Validation", problem);
      }
      const cap = Math.min(
        optNum(body, "maxResults") ?? ctx.maxSearchResults,
        scope.maxResults ?? ctx.maxSearchResults,
        ctx.maxSearchResults
      );
      const unscope = unscoper(scope);
      const matches: WireFileInfo[] = [];
      let truncated = false;
      for await (const file of searchScoped(ctx, scope, {
        caseInsensitive,
        clientPrefix,
        limit: pageLimit,
        match,
        pattern,
        searchPrefix,
        signal,
        unscope,
      })) {
        if (matches.length >= cap) {
          truncated = true;
          break;
        }
        matches.push(fileInfoToWire(file, unscope));
      }
      return json({ matches, truncated });
    }
    case "capabilities": {
      await authorizeOp(ctx, { operation: "capabilities", params: {} });
      return json({ capabilities: ctx.files.capabilities });
    }
    case "signed-upload-url": {
      requireOrigin(ctx, parsed);
      const key = str(body, "key");
      const expiresIn = num(body, "expiresIn");
      const maxSize = clampUploadMaxSize(
        optNum(body, "maxSize"),
        ctx.maxUploadSize
      );
      const minSize = optNum(body, "minSize");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "signedUploadUrl",
        params: {
          expiresIn,
          ...(maxSize !== undefined && { maxSize }),
          ...(minSize !== undefined && { minSize }),
        },
      });
      const contentType = optStr(body, "contentType");
      const signed = await ctx.files.signedUploadUrl(
        scopeKey(scope.prefix, key),
        {
          expiresIn: clampExpiry(ctx, expiresIn, scope, "signedUpload"),
          signal,
          ...(contentType && { contentType }),
          ...(maxSize !== undefined && { maxSize }),
          ...(minSize !== undefined && { minSize }),
        }
      );
      return json({ signed });
    }
    case "presign": {
      requireOrigin(ctx, parsed);
      const files = fileInfos(ctx, body);
      const scope = await authorizeOp(ctx, { operation: "upload", params: {} });
      return handlePresign(
        uploadCfg(ctx, parsed),
        files,
        optNum(body, "expiresIn"),
        scope,
        unscoper(scope)
      );
    }
    case "complete": {
      requireOrigin(ctx, parsed);
      const items = completions(ctx, body);
      const scope = await authorizeOp(ctx, { operation: "upload", params: {} });
      return handleComplete(
        uploadCfg(ctx, parsed, scope),
        items,
        scope,
        unscoper(scope)
      );
    }
    case "versions": {
      const key = str(body, "key");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "versions",
        params: {},
      });
      const plugin = pluginMethods(ctx);
      if (!isFunction(plugin.versions)) {
        return notConfigured("versioning");
      }
      const versions = await plugin.versions(scopeKey(scope.prefix, key));
      return json({ versions: versions.map(toWireVersion) });
    }
    case "restore-version": {
      requireOrigin(ctx, parsed);
      const key = str(body, "key");
      const versionId = optStr(body, "versionId");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "restoreVersion",
        params: { versionId },
      });
      const plugin = pluginMethods(ctx);
      if (!isFunction(plugin.restoreVersion)) {
        return notConfigured("versioning");
      }
      const file = await plugin.restoreVersion(
        scopeKey(scope.prefix, key),
        versionId
      );
      return json({ file: fileInfoToWire(file, unscoper(scope)) });
    }
    case "trashed": {
      const scope = await authorizeOp(ctx, {
        operation: "trashed",
        params: {},
      });
      const plugin = pluginMethods(ctx);
      if (!isFunction(plugin.trashed)) {
        return notConfigured("softDelete");
      }
      const unscope = unscoper(scope);
      // `trashed()` returns the whole trash; under a key-prefix scope, expose
      // only the caller's own keys (and honor a bulk `filterKeys`).
      const all = await plugin.trashed();
      const visible = all.flatMap((t) => {
        if (!t.key.startsWith(scope.prefix)) {
          return [];
        }
        const wire = toWireTrashed({ ...t, key: unscope(t.key) });
        return scope.filterKeys && !scope.filterKeys(wire.key) ? [] : [wire];
      });
      return json({ trashed: visible });
    }
    case "restore-trashed": {
      requireOrigin(ctx, parsed);
      const key = str(body, "key");
      const scope = await authorizeOp(ctx, {
        key,
        operation: "restoreTrashed",
        params: {},
      });
      const plugin = pluginMethods(ctx);
      if (!isFunction(plugin.restoreTrashed)) {
        return notConfigured("softDelete");
      }
      const file = await plugin.restoreTrashed(scopeKey(scope.prefix, key));
      return json({ file: fileInfoToWire(file, unscoper(scope)) });
    }
    case "purge": {
      requireOrigin(ctx, parsed);
      const key = optStr(body, "key");
      const scope = await authorizeOp(ctx, {
        ...(key !== undefined && { key }),
        operation: "purge",
        params: {},
      });
      const plugin = pluginMethods(ctx);
      if (!isFunction(plugin.purge)) {
        return notConfigured("softDelete");
      }
      if (key !== undefined) {
        if (scope.filterKeys && !scope.filterKeys(key)) {
          throw new RouterError(
            "Forbidden",
            "key is outside authorized scope",
            "forbidden"
          );
        }
        await plugin.purge(scopeKey(scope.prefix, key));
      } else if (scope.prefix || scope.filterKeys) {
        // Empty-trash under a scope must never purge another tenant's keys (or
        // ones `filterKeys` hides), and a bare `purge()` empties everything —
        // so purge only the entries this caller may see.
        if (!isFunction(plugin.trashed)) {
          return notConfigured("softDelete");
        }
        const entries = await plugin.trashed();
        const mine = entries.filter((t) => {
          if (!t.key.startsWith(scope.prefix)) {
            return false;
          }
          const unscoped = unscoper(scope)(t.key);
          return !scope.filterKeys || scope.filterKeys(unscoped);
        });
        for (const t of mine) {
          // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- purge scoped trash entries sequentially; stops on the first failure
          await plugin.purge(t.key);
        }
      } else {
        await plugin.purge();
      }
      return json({ ok: true });
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
      { ifRange: parsed.ifRangeHeader, range: parsed.rangeHeader },
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
      uploadCfg(ctx, parsed, scope),
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
      uploadCfg(ctx, parsed),
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
