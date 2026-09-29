// Shared offset-mode resumable driver for providers that speak the same
// "PUT byte ranges to a session URL" protocol: GCS, Firebase Storage, and
// Google Drive all hand back a pre-authorized session URI, then accept chunks
// via `Content-Range` PUTs — `308` (with a `Range` header) means "more
// please", `200`/`201` carries the finished object. Only how the session is
// opened and how the final response is parsed differ per provider, so those
// are injected.

import type {
  OffsetResumableDriver,
  ResumableUploadSession,
  UploadResult,
} from "../index.js";
import { FilesError } from "./errors.js";

// `Range: bytes=0-262143` → the next byte the server expects (262144).
const nextFromRange = (range: string | null, fallback: number): number =>
  range ? Number(range.slice(range.indexOf("-") + 1)) + 1 : fallback;

/**
 * Classify a failed session response with the standard status buckets
 * `makeErrorMapper` uses — 404/410 → `NotFound` (an unknown or expired session
 * URI: GCS answers 404, Drive 410), 401/403 → `Unauthorized`, 409/412 →
 * `Conflict`, anything else → `Provider`. The classified 4xx answers are
 * deterministic for this session — re-sending the same chunk can only fail the
 * same way — so they're flagged `permanent`; only a `Provider` failure (5xx,
 * 408, 429, …) stays retryable. Shared with the hand-rolled offset drivers
 * (Supabase TUS, Cloudinary chunked uploads); `detail` appends the response
 * body where a provider explains the failure there.
 */
export const statusError = (
  status: number,
  message: string,
  detail?: string
): FilesError => {
  const text = detail
    ? `${message} (HTTP ${status}): ${detail}`
    : `${message} (HTTP ${status}).`;
  if (status === 404 || status === 410) {
    return new FilesError("NotFound", text, undefined, { permanent: true });
  }
  if (status === 401 || status === 403) {
    return new FilesError("Unauthorized", text, undefined, {
      permanent: true,
    });
  }
  if (status === 409 || status === 412) {
    return new FilesError("Conflict", text, undefined, { permanent: true });
  }
  return new FilesError("Provider", text);
};

export const createOffsetHttpDriver = (params: {
  partSize: number;
  /** Open the provider session; return the token plus the URL to PUT chunks to. */
  open: (meta: {
    total: number;
    contentType: string;
  }) => Promise<{ session: ResumableUploadSession; uri: string }>;
  /** Validate a resume token and return its session URL. Throws on a mismatch. */
  resume: (session: ResumableUploadSession) => string;
  /** Parse a `200`/`201` completion response into an {@link UploadResult}. */
  parseResult: (res: Response) => Promise<UploadResult>;
  wrapErr: (cause: unknown) => FilesError;
}): OffsetResumableDriver => {
  const { partSize, open, resume, parseResult, wrapErr } = params;
  let uri: string | undefined;
  let finalResult: UploadResult | undefined;
  const requireUri = (): string => {
    if (!uri) {
      throw new FilesError("Provider", "resumable upload has no session.");
    }
    return uri;
  };
  return {
    adopt(session: ResumableUploadSession) {
      uri = resume(session);
    },
    async begin(meta): Promise<ResumableUploadSession> {
      try {
        const opened = await open(meta);
        ({ uri } = opened);
        return opened.session;
      } catch (error) {
        throw wrapErr(error);
      }
    },
    complete(): Promise<UploadResult> {
      if (!finalResult) {
        throw new FilesError("Provider", "resumable upload did not finalize.");
      }
      return Promise.resolve(finalResult);
    },
    async discard() {
      if (!uri) {
        return;
      }
      try {
        await fetch(uri, { method: "DELETE" });
      } catch (error) {
        throw wrapErr(error);
      }
    },
    mode: "offset",
    partSize,
    async probe(): Promise<{ nextOffset: number }> {
      try {
        const res = await fetch(requireUri(), {
          headers: { "Content-Range": "bytes */*" },
          method: "PUT",
        });
        if (res.status === 308) {
          return { nextOffset: nextFromRange(res.headers.get("range"), 0) };
        }
        if (res.ok) {
          // The session already finalized server-side — nothing left to send.
          finalResult = await parseResult(res);
          return { nextOffset: Number.MAX_SAFE_INTEGER };
        }
        throw statusError(res.status, "resume status check failed");
      } catch (error) {
        throw wrapErr(error);
      }
    },
    async uploadAt({ offset, data, isLast, total, signal }): Promise<{
      nextOffset: number;
    }> {
      try {
        const rangeTotal = isLast ? total : "*";
        const contentRange =
          data.byteLength === 0
            ? `bytes */${total}`
            : `bytes ${offset}-${offset + data.byteLength - 1}/${rangeTotal}`;
        // SAFETY: `data` is a chunk sliced by `toByteSource`, always backed by
        // a plain `ArrayBuffer` (never shared memory); DOM's `BodyInit` only
        // pins the backing type, and `fetch` accepts the view at runtime.
        const res = await fetch(requireUri(), {
          body: data as BodyInit,
          headers: { "Content-Range": contentRange },
          method: "PUT",
          ...(signal && { signal }),
        });
        if (isLast) {
          if (!res.ok) {
            throw statusError(res.status, "upload failed");
          }
          finalResult = await parseResult(res);
          return { nextOffset: total };
        }
        if (res.status !== 308) {
          throw statusError(res.status, "chunk upload failed");
        }
        const range = res.headers.get("range");
        if (range === null) {
          // In this protocol a 308 *without* a Range header means the server
          // has persisted no bytes (it's the same answer probe() maps to
          // offset 0). Optimistically advancing past the chunk here would
          // silently skip its bytes; throw instead — the per-chunk retry
          // re-sends it, and a token resume re-probes the true offset.
          throw new FilesError(
            "Provider",
            "chunk acknowledged without a Range header — the server reports no bytes persisted."
          );
        }
        return {
          nextOffset: nextFromRange(range, offset + data.byteLength),
        };
      } catch (error) {
        throw wrapErr(error);
      }
    },
  };
};
