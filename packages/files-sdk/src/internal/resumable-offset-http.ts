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
  wrapErr: (err: unknown) => FilesError;
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
        throw new FilesError(
          "Provider",
          `resume status check failed (HTTP ${res.status}).`
        );
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
        const res = await fetch(requireUri(), {
          // A typed array's generic ArrayBufferLike backing doesn't satisfy the
          // DOM BodyInit type, though `fetch` accepts it at runtime.
          body: data as unknown as BodyInit,
          headers: { "Content-Range": contentRange },
          method: "PUT",
          ...(signal && { signal }),
        });
        if (isLast) {
          if (!res.ok) {
            throw new FilesError(
              "Provider",
              `upload failed (HTTP ${res.status}).`
            );
          }
          finalResult = await parseResult(res);
          return { nextOffset: total };
        }
        if (res.status !== 308) {
          throw new FilesError(
            "Provider",
            `chunk upload failed (HTTP ${res.status}).`
          );
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
