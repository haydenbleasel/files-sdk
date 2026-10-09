// The `upload` byte paths. Keyless uploads use the secure 3-step protocol
// (`presign` mints a key + HMAC token → direct-to-storage or proxy →
// `complete` verifies via `head`); an explicit-key `upload(key, body)` streams
// straight through. The HMAC token binds the server-chosen key + size/type and
// the minting endpoint (path + query) so the server stays stateless and the
// client can't forge, relax, or redeem it anywhere else.

import type { Files, SignedUpload, UploadResult } from "../../index.js";
import { FilesError } from "../errors.js";
import { RouterError } from "../router-core/envelope.js";
import type { TokenPayload } from "../router-core/sign-token.js";
import { signToken, verifyToken } from "../router-core/sign-token.js";
import type { ResultModel } from "../router-core/web.js";
import type { Scope } from "./authorize.js";
import { assertSafeKey } from "./keys.js";
import type {
  ClientFileInfo,
  PresignedUpload,
  WireBulkError,
  WireFileInfo,
} from "./protocol.js";
import { bulkErrorToWire, fileInfoToWire } from "./serialize.js";

export interface UploadConfig {
  files: Files;
  secret: string;
  defaultExpiresIn: number;
  maxUploadSize?: number;
  proxyUrl: (token: string) => string;
  /** The request's canonical non-routing query — see {@link boundQuery}. */
  boundQuery: string;
  /** The request URL's path — a token only redeems at the endpoint that minted it. */
  boundPath: string;
  now: () => number;
  /** The request's abort signal, threaded into every storage call. */
  signal: AbortSignal;
}

const ROUTING_PARAMS = new Set(["op", "key", "token"]);

/**
 * The query an upload token is bound to: every pair except the gateway's own
 * routing params, sorted into a canonical string. A per-request `files`
 * factory resolves the instance from this query (`?bucket=`), so a token
 * minted under one query must not be redeemable under another — otherwise a
 * caller could presign where uploads are allowed and PUT the bytes into an
 * instance where they are not. Empty for a bare endpoint.
 */
export const boundQuery = (query: URLSearchParams): string => {
  const bound = new URLSearchParams();
  for (const [name, value] of query) {
    if (!ROUTING_PARAMS.has(name)) {
      bound.append(name, value);
    }
  }
  bound.sort();
  return bound.toString();
};

const PATH_MISMATCH = "upload token was issued for a different endpoint";
const QUERY_MISMATCH = "upload token was issued for a different endpoint query";

// Why a verified token can't be redeemed by this request, if it can't: it was
// minted at another path (a sibling router sharing the secret, whose
// `authorize` never approved the upload) or under another query.
const bindingMismatch = (
  payload: TokenPayload,
  cfg: UploadConfig
): string | undefined => {
  if (payload.path !== cfg.boundPath) {
    return PATH_MISMATCH;
  }
  return (payload.query ?? "") === cfg.boundQuery ? undefined : QUERY_MISMATCH;
};

type Redeemed =
  | { ok: true; payload: TokenPayload }
  | { ok: false; message: string };

// Verify `token` and its endpoint binding: the payload this request may act
// on, or why it may not.
const redeem = async (token: string, cfg: UploadConfig): Promise<Redeemed> => {
  const verified = await verifyToken(token, cfg.secret, cfg.now());
  if (!verified.ok) {
    return { message: `upload token ${verified.failure}`, ok: false };
  }
  const mismatch = bindingMismatch(verified.payload, cfg);
  return mismatch ? { message: mismatch, ok: false } : verified;
};

const extFromName = (name: string): string => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  const ext = name.slice(dot);
  return /^\.[a-z0-9]+$/iu.test(ext) ? ext.toLowerCase() : "";
};

const mintKey = (prefix: string, name: string): string => {
  const key = `${prefix}${crypto.randomUUID()}${extFromName(name)}`;
  assertSafeKey(key);
  return key;
};

const clampExpiry = (base: number, ...caps: (number | undefined)[]): number => {
  let value = base;
  for (const cap of caps) {
    if (cap !== undefined) {
      value = Math.min(value, cap);
    }
  }
  return value;
};

const proxyTarget = (
  cfg: UploadConfig,
  token: string,
  type: string
): SignedUpload => ({
  headers: { "content-type": type || "application/octet-stream" },
  method: "PUT",
  url: cfg.proxyUrl(token),
});

interface LimitedBody {
  body: ReadableStream<Uint8Array>;
  /** The size-limit error once the stream has tripped it, else `undefined`. */
  getError: () => RouterError | undefined;
}

const limitBody = (
  body: ReadableStream<Uint8Array>,
  maxSize: number | undefined,
  message: string
): LimitedBody => {
  let limitError: RouterError | undefined;
  const getError = () => limitError;
  if (maxSize === undefined) {
    return { body, getError };
  }
  let total = 0;
  return {
    body: body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          total += chunk.byteLength;
          if (total > maxSize) {
            limitError = new RouterError("Validation", message, "size");
            controller.error(limitError);
            return;
          }
          controller.enqueue(chunk);
        },
      })
    ),
    getError,
  };
};

export const handlePresign = async (
  cfg: UploadConfig,
  files: ClientFileInfo[],
  requestedExpiresIn: number | undefined,
  scope: Scope,
  unscope: (key: string) => string
): Promise<ResultModel> => {
  const { maxUploadSize } = cfg;
  // The declared size is advisory (the proxy PUT and `complete` still enforce
  // the real one), but a file that already says it is too large is refused
  // before anything is signed.
  if (
    maxUploadSize !== undefined &&
    files.some((file) => file.size > maxUploadSize)
  ) {
    throw new RouterError("Validation", "upload exceeds maxUploadSize", "size");
  }
  const { signedUpload } = cfg.files.capabilities;
  const expires = clampExpiry(
    requestedExpiresIn ?? cfg.defaultExpiresIn,
    scope.maxExpiresIn,
    signedUpload.maxExpiresIn
  );
  // Presign only when the adapter can bind everything this upload carries: a
  // `maxUploadSize` it can't enforce, or a content type it can't sign, would
  // be refused — so those go through the proxy, which enforces both itself.
  const canPresign = (file: ClientFileInfo): boolean =>
    signedUpload.supported &&
    (cfg.maxUploadSize === undefined || signedUpload.maxSize) &&
    (!file.type || signedUpload.contentType);

  const presignOne = async (file: ClientFileInfo): Promise<PresignedUpload> => {
    const key = mintKey(scope.prefix, file.name);
    const id = await signToken(
      {
        contentType: file.type || undefined,
        exp: cfg.now() + expires * 1000,
        key,
        maxSize: cfg.maxUploadSize,
        minSize: 0,
        path: cfg.boundPath,
        ...(cfg.boundQuery && { query: cfg.boundQuery }),
      },
      cfg.secret
    );

    let target: SignedUpload;
    if (canPresign(file)) {
      try {
        target = await cfg.files.signedUploadUrl(key, {
          contentType: file.type || undefined,
          expiresIn: expires,
          minSize: 0,
          signal: cfg.signal,
          ...(cfg.maxUploadSize && { maxSize: cfg.maxUploadSize }),
        });
      } catch (error) {
        // A refusal the capabilities didn't predict (a per-call limit such as
        // a `minSize` the provider can't bind) still has a working path: the
        // proxy, which enforces size and type itself. A backend failure or an
        // abort is a real error, so it surfaces instead of being masked.
        const { code } = FilesError.wrap(error);
        if (code !== "Unsupported" && code !== "Invalid") {
          throw error;
        }
        target = proxyTarget(cfg, id, file.type);
      }
    } else {
      target = proxyTarget(cfg, id, file.type);
    }
    return { id, key: unscope(key), target };
  };

  const uploads = await Promise.all(files.map(presignOne));
  return { body: { uploads }, kind: "json", status: 200 };
};

const SCOPE_MISMATCH = "upload token was not issued for this caller";

const unauthorizedEntry = (message: string, key: string): WireBulkError => ({
  error: { aborted: false, code: "Unauthorized", message, timedOut: false },
  key,
});

// An object `complete` found over the token's `maxSize` must not stay stored:
// the key was minted by this server for this upload alone, so removing it
// can't touch anything else. A failed removal is reported, not swallowed.
const removeOversized = async (
  cfg: UploadConfig,
  key: string
): Promise<string> => {
  try {
    await cfg.files.delete(key, { signal: cfg.signal });
    return "";
  } catch (error) {
    const wrapped = FilesError.wrap(error);
    return wrapped.code === "NotFound"
      ? ""
      : ` (removing it failed: ${wrapped.message})`;
  }
};

// One completion: the stored file, or the per-key error entry explaining why
// it can't be completed by this request.
const completeOne = async (
  cfg: UploadConfig,
  completion: { id: string; key: string },
  scope: Scope,
  unscope: (key: string) => string
): Promise<WireFileInfo | WireBulkError> => {
  const verified = await redeem(completion.id, cfg);
  if (!verified.ok) {
    return unauthorizedEntry(verified.message, completion.key);
  }
  const { key, maxSize } = verified.payload;
  // The token is valid, but only for the caller whose `authorize` scope
  // minted it: another tenant presenting it must not learn the storage key or
  // metadata. Answer with the key the caller sent, never the token's.
  if (!key.startsWith(scope.prefix)) {
    return unauthorizedEntry(SCOPE_MISMATCH, completion.key);
  }
  try {
    const meta = await cfg.files.head(key, { signal: cfg.signal });
    if (maxSize !== undefined && meta.size > maxSize) {
      const removal = await removeOversized(cfg, key);
      return {
        error: {
          aborted: false,
          code: "Provider",
          message: `uploaded object is ${meta.size} bytes, exceeds maxSize ${maxSize}${removal}`,
          timedOut: false,
        },
        key: unscope(key),
      };
    }
    return fileInfoToWire(meta, unscope);
  } catch (error) {
    return bulkErrorToWire(FilesError.wrap(error), key, unscope);
  }
};

export const handleComplete = async (
  cfg: UploadConfig,
  completions: { id: string; key: string }[],
  scope: Scope,
  unscope: (key: string) => string
): Promise<ResultModel> => {
  const completed: WireFileInfo[] = [];
  const errors: WireBulkError[] = [];

  for (const completion of completions) {
    // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- completions verified sequentially; small N
    const outcome = await completeOne(cfg, completion, scope, unscope);
    if ("error" in outcome) {
      errors.push(outcome);
    } else {
      completed.push(outcome);
    }
  }

  return {
    body: { files: completed, ...(errors.length > 0 && { errors }) },
    kind: "json",
    status: 200,
  };
};

export const handleProxyUpload = async (
  cfg: UploadConfig,
  token: string | null,
  body: ReadableStream<Uint8Array> | null,
  contentLength: number | undefined
): Promise<ResultModel> => {
  if (!token) {
    throw new RouterError("Unauthorized", "missing proxy token");
  }
  const verified = await redeem(token, cfg);
  if (!verified.ok) {
    throw new RouterError("Unauthorized", verified.message);
  }
  if (!body) {
    throw new RouterError("Validation", "missing request body");
  }
  const { key, maxSize, contentType } = verified.payload;
  if (
    maxSize !== undefined &&
    contentLength !== undefined &&
    contentLength > maxSize
  ) {
    throw new RouterError("Validation", "upload exceeds maxSize", "size");
  }
  const limited = limitBody(body, maxSize, "upload exceeds maxSize");
  try {
    await cfg.files.upload(key, limited.body, {
      signal: cfg.signal,
      ...(contentType && { contentType }),
    });
  } catch (error) {
    throw limited.getError() ?? FilesError.wrap(error);
  }
  return { body: { ok: true }, kind: "json", status: 200 };
};

export const handleExplicitUpload = async (
  cfg: UploadConfig,
  storageKey: string,
  unscopedKey: string,
  body: ReadableStream<Uint8Array> | null,
  contentType: string | null,
  contentLength: number | undefined
): Promise<ResultModel> => {
  if (!body) {
    throw new RouterError("Validation", "missing request body");
  }
  if (
    cfg.maxUploadSize !== undefined &&
    contentLength !== undefined &&
    contentLength > cfg.maxUploadSize
  ) {
    throw new RouterError("Validation", "upload exceeds maxUploadSize", "size");
  }
  const limited = limitBody(
    body,
    cfg.maxUploadSize,
    "upload exceeds maxUploadSize"
  );
  let result: UploadResult;
  try {
    result = await cfg.files.upload(storageKey, limited.body, {
      signal: cfg.signal,
      ...(contentType && { contentType }),
    });
  } catch (error) {
    throw limited.getError() ?? FilesError.wrap(error);
  }
  return {
    body: {
      file: fileInfoToWire({ ...result, key: unscopedKey }, (key) => key),
      ok: true,
    },
    kind: "json",
    status: 200,
  };
};
