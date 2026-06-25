// The `upload` byte paths. Keyless uploads use the secure 3-step protocol
// (`presign` mints a key + HMAC token → direct-to-storage or proxy →
// `complete` verifies via `head`); an explicit-key `upload(key, body)` streams
// straight through. The HMAC token binds the server-chosen key + size/type so
// the server stays stateless and the client can't forge or relax it.

import type { Files, SignedUpload } from "../../index.js";
import { FilesError } from "../errors.js";
import { RouterError } from "../router-core/envelope.js";
import { signToken, verifyToken } from "../router-core/sign-token.js";
import type { ResultModel } from "../router-core/web.js";
import type { Scope } from "./authorize.js";
import { assertSafeKey } from "./keys.js";
import type {
  ClientFileInfo,
  PresignedUpload,
  WireBulkError,
  WireStoredFile,
} from "./protocol.js";
import { bulkErrorToWire, storedFileToWire } from "./serialize.js";

export interface UploadConfig {
  files: Files;
  secret: string;
  defaultExpiresIn: number;
  maxUploadSize?: number;
  proxyUrl: (token: string) => string;
  now: () => number;
}

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

const limitBody = (
  body: ReadableStream<Uint8Array>,
  maxSize: number | undefined,
  message: string
): {
  body: ReadableStream<Uint8Array>;
  getError: () => RouterError | undefined;
} => {
  if (maxSize === undefined) {
    return { body, getError: () => void 0 };
  }
  let total = 0;
  let limitError: RouterError | undefined;
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
    getError: () => limitError,
  };
};

export const handlePresign = async (
  cfg: UploadConfig,
  files: ClientFileInfo[],
  requestedExpiresIn: number | undefined,
  scope: Scope,
  unscope: (key: string) => string
): Promise<ResultModel> => {
  const caps = cfg.files.capabilities;
  const expires = clampExpiry(
    requestedExpiresIn ?? cfg.defaultExpiresIn,
    scope.maxExpiresIn,
    caps.signedUrl.maxExpiresIn
  );

  const presignOne = async (file: ClientFileInfo): Promise<PresignedUpload> => {
    const key = mintKey(scope.prefix, file.name);
    const id = await signToken(
      {
        contentType: file.type || undefined,
        exp: cfg.now() + expires * 1000,
        key,
        maxSize: cfg.maxUploadSize,
        minSize: 0,
      },
      cfg.secret
    );

    let target: SignedUpload;
    if (caps.signedUrl.supported) {
      try {
        target = await cfg.files.signedUploadUrl(key, {
          contentType: file.type || undefined,
          expiresIn: expires,
          minSize: 0,
          ...(cfg.maxUploadSize ? { maxSize: cfg.maxUploadSize } : {}),
        });
      } catch {
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

export const handleComplete = async (
  cfg: UploadConfig,
  completions: { id: string; key: string }[],
  unscope: (key: string) => string
): Promise<ResultModel> => {
  const completed: WireStoredFile[] = [];
  const errors: WireBulkError[] = [];

  for (const completion of completions) {
    // oxlint-disable-next-line no-await-in-loop -- completions verified sequentially; small N.
    const verified = await verifyToken(completion.id, cfg.secret, cfg.now());
    if (!verified.ok) {
      errors.push({
        error: {
          aborted: false,
          code: "Unauthorized",
          message: `upload token ${verified.failure}`,
          timedOut: false,
        },
        key: completion.key,
      });
      continue;
    }
    const { key, maxSize } = verified.payload;
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential head per completion.
      const meta = await cfg.files.head(key);
      if (maxSize !== undefined && meta.size > maxSize) {
        errors.push({
          error: {
            aborted: false,
            code: "Provider",
            message: `uploaded object is ${meta.size} bytes, exceeds maxSize ${maxSize}`,
            timedOut: false,
          },
          key: unscope(key),
        });
        continue;
      }
      completed.push(storedFileToWire(meta, unscope));
    } catch (error) {
      errors.push(bulkErrorToWire(FilesError.wrap(error), key, unscope));
    }
  }

  return {
    body: { files: completed, ...(errors.length ? { errors } : {}) },
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
  const verified = await verifyToken(token, cfg.secret, cfg.now());
  if (!verified.ok) {
    throw new RouterError("Unauthorized", `upload token ${verified.failure}`);
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
    await cfg.files.upload(
      key,
      limited.body,
      contentType ? { contentType } : {}
    );
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
  const result = await cfg.files
    .upload(storageKey, limited.body, contentType ? { contentType } : {})
    .catch((error: unknown) => {
      throw limited.getError() ?? FilesError.wrap(error);
    });
  return {
    body: {
      file: {
        etag: result.etag,
        key: unscopedKey,
        lastModified: result.lastModified,
        name: unscopedKey,
        size: result.size,
        type: result.contentType,
      },
      ok: true,
    },
    kind: "json",
    status: 200,
  };
};
