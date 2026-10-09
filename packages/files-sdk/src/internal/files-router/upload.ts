// The `upload` byte paths. Keyless uploads use the secure 3-step protocol
// (`presign` mints a key + HMAC token → direct-to-storage or proxy →
// `complete` verifies via `head`); an explicit-key `upload(key, body)` streams
// straight through. The HMAC token binds the server-chosen key + size/type and
// the minting endpoint (path + query) so the server stays stateless and the
// client can't forge, relax, or redeem it anywhere else.

import type { Files, SignedUpload, UploadResult } from "../../index.js";
import { FilesError } from "../errors.js";
import { eventSinkOf, gatewayUploadEvent } from "../events.js";
import { RouterError } from "../router-core/envelope.js";
import type { TokenPayload } from "../router-core/sign-token.js";
import { signToken, verifyToken } from "../router-core/sign-token.js";
import type { ResultModel } from "../router-core/web.js";
import type { Scope } from "./authorize.js";
import { assertSafeKey } from "./keys.js";
import type {
  ClientFileInfo,
  ExplicitUploadResponse,
  PresignedUpload,
  WireBulkError,
  WireFileInfo,
  WireUploadedFile,
} from "./protocol.js";
import { bulkErrorToWire, fileInfoToWire } from "./serialize.js";
import type {
  UploadData,
  UploadLifecycle,
  UploadVia,
} from "./upload-complete.js";
import {
  discardRejected,
  rejectionToWire,
  uploadIdFor,
} from "./upload-complete.js";

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
  /** `onUploadComplete` and its options, when configured. */
  lifecycle?: UploadLifecycle;
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

  // A storage-signed target, or `undefined` when the adapter can't sign one
  // (the client is then handed the gateway's proxy PUT).
  const signedTarget = async (
    key: string,
    file: ClientFileInfo
  ): Promise<SignedUpload | undefined> => {
    if (!canPresign(file)) {
      return undefined;
    }
    try {
      return await cfg.files.signedUploadUrl(key, {
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
      return undefined;
    }
  };

  const presignOne = async (file: ClientFileInfo): Promise<PresignedUpload> => {
    const key = mintKey(scope.prefix, file.name);
    const signed = await signedTarget(key, file);
    const id = await signToken(
      {
        contentType: file.type || undefined,
        exp: cfg.now() + expires * 1000,
        key,
        maxSize: cfg.maxUploadSize,
        minSize: 0,
        path: cfg.boundPath,
        ...(cfg.boundQuery && { query: cfg.boundQuery }),
        ...(signed === undefined && { via: "proxy" as const }),
      },
      cfg.secret
    );
    return {
      id,
      key: unscope(key),
      target: signed ?? proxyTarget(cfg, id, file.type),
    };
  };

  const uploads = await Promise.all(files.map(presignOne));
  return { body: { uploads }, kind: "json", status: 200 };
};

const SCOPE_MISMATCH = "upload token was not issued for this caller";

const unauthorizedEntry = (message: string, key: string): WireBulkError => ({
  error: { aborted: false, code: "Unauthorized", message, timedOut: false },
  key,
});

const withData = (file: WireFileInfo, data: UploadData): WireUploadedFile =>
  data === undefined ? file : { ...file, data };

interface Accepted {
  ok: true;
  file: WireUploadedFile;
}
interface Rejected {
  ok: false;
  /** What the hook threw — reported to the client as the upload's error. */
  cause: unknown;
  /** Why discarding the rejected object failed, as a message suffix ("" when it didn't). */
  removal: string;
}

/**
 * Feed an accepted upload to `files-sdk/events` handlers when the plugin is
 * installed on the instance. Their failures are the plugin's to report (its
 * `onError`); the upload itself already succeeded.
 */
const announceUpload = async (
  cfg: UploadConfig,
  upload: { wire: WireFileInfo; storageKey: string; uploadId: string }
): Promise<void> => {
  const sink = eventSinkOf(cfg.files);
  if (!sink) {
    return;
  }
  const { wire } = upload;
  try {
    await sink.emit(
      gatewayUploadEvent(cfg.files.adapter.name, {
        contentType: wire.contentType,
        key: upload.storageKey,
        size: wire.size,
        uploadId: upload.uploadId,
        ...(wire.etag !== undefined && { etag: wire.etag }),
        ...(wire.lastModified !== undefined && {
          lastModified: wire.lastModified,
        }),
      })
    );
  } catch {
    // reported through the events plugin's `onError`
  }
};

/**
 * Run `onUploadComplete` for a landed object: its result rides back as `data`;
 * a throw rejects the upload, discarding the object (unless `onRejected:
 * "keep"`). Without a hook, every verified upload is accepted as-is. An
 * accepted upload is then announced to `files-sdk/events` handlers.
 */
const settleUpload = async (
  cfg: UploadConfig,
  upload: {
    wire: WireFileInfo;
    storageKey: string;
    uploadId: string;
    via: UploadVia;
  }
): Promise<Accepted | Rejected> => {
  const hook = cfg.lifecycle?.onUploadComplete;
  if (!(cfg.lifecycle && hook)) {
    await announceUpload(cfg, upload);
    return { file: upload.wire, ok: true };
  }
  const { wire } = upload;
  try {
    const data = await hook({
      context: cfg.lifecycle.context,
      file: {
        contentType: wire.contentType,
        key: wire.key,
        size: wire.size,
        ...(wire.etag !== undefined && { etag: wire.etag }),
        ...(wire.lastModified !== undefined && {
          lastModified: wire.lastModified,
        }),
        ...(wire.metadata !== undefined && { metadata: wire.metadata }),
      },
      files: cfg.files,
      req: cfg.lifecycle.req,
      storageKey: upload.storageKey,
      uploadId: upload.uploadId,
      via: upload.via,
    });
    await announceUpload(cfg, upload);
    return { file: withData(wire, data), ok: true };
  } catch (error) {
    const removal = await discardRejected(
      cfg.files,
      cfg.lifecycle,
      upload.storageKey,
      cfg.signal
    );
    return { cause: error, ok: false, removal };
  }
};

type CompletionOutcome =
  | { ok: true; file: WireUploadedFile }
  | { ok: false; error: WireBulkError };

// One completion: the stored file (with what `onUploadComplete` returned), or
// the per-key error entry explaining why it can't be completed by this request.
const completeOne = async (
  cfg: UploadConfig,
  completion: { id: string; key: string },
  scope: Scope,
  unscope: (key: string) => string
): Promise<CompletionOutcome> => {
  const verified = await redeem(completion.id, cfg);
  if (!verified.ok) {
    return {
      error: unauthorizedEntry(verified.message, completion.key),
      ok: false,
    };
  }
  const { exp, key, maxSize, via } = verified.payload;
  // The token is valid, but only for the caller whose `authorize` scope
  // minted it: another tenant presenting it must not learn the storage key or
  // metadata. Answer with the key the caller sent, never the token's.
  if (!key.startsWith(scope.prefix)) {
    return {
      error: unauthorizedEntry(SCOPE_MISMATCH, completion.key),
      ok: false,
    };
  }
  const store = cfg.lifecycle?.completions;
  const uploadId = await uploadIdFor(completion.id);
  try {
    // A replayed `complete` for an upload this store already settled gets the
    // recorded answer; the hook does not fire twice.
    const prior = await store?.get(uploadId);
    if (prior) {
      return { file: prior.file, ok: true };
    }
    const meta = await cfg.files.head(key, { signal: cfg.signal });
    if (maxSize !== undefined && meta.size > maxSize) {
      // The key was minted by this server for this upload alone, so removing
      // it can't touch anything else.
      const removal = await discardRejected(
        cfg.files,
        cfg.lifecycle,
        key,
        cfg.signal
      );
      return {
        error: {
          error: {
            aborted: false,
            code: "Provider",
            message: `uploaded object is ${meta.size} bytes, exceeds maxSize ${maxSize}${removal}`,
            timedOut: false,
          },
          key: unscope(key),
        },
        ok: false,
      };
    }
    const settled = await settleUpload(cfg, {
      storageKey: key,
      uploadId,
      via: via === "proxy" ? "proxy" : "presign",
      wire: fileInfoToWire(meta, unscope),
    });
    if (!settled.ok) {
      const error = rejectionToWire(settled.cause);
      return {
        error: {
          error: { ...error, message: `${error.message}${settled.removal}` },
          key: unscope(key),
        },
        ok: false,
      };
    }
    await store?.set(
      uploadId,
      { file: settled.file },
      Math.max(0, exp - cfg.now())
    );
    return settled;
  } catch (error) {
    return {
      error: bulkErrorToWire(FilesError.wrap(error), key, unscope),
      ok: false,
    };
  }
};

export const handleComplete = async (
  cfg: UploadConfig,
  completions: { id: string; key: string }[],
  scope: Scope,
  unscope: (key: string) => string
): Promise<ResultModel> => {
  const completed: WireUploadedFile[] = [];
  const errors: WireBulkError[] = [];

  for (const completion of completions) {
    // oxlint-disable-next-line no-await-in-loop, react-doctor/async-await-in-loop -- completions verified sequentially; small N
    const outcome = await completeOne(cfg, completion, scope, unscope);
    if (outcome.ok) {
      completed.push(outcome.file);
    } else {
      errors.push(outcome.error);
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
  const wire = fileInfoToWire({ ...result, key: unscopedKey }, (key) => key);
  const settled = await settleUpload(cfg, {
    storageKey,
    uploadId: crypto.randomUUID(),
    via: "keyed",
    wire,
  });
  if (!settled.ok) {
    throw settled.cause;
  }
  const response: ExplicitUploadResponse = { file: settled.file, ok: true };
  return { body: response, kind: "json", status: 200 };
};
