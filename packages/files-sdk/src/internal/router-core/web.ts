// The ONLY seam that touches Web `Request`/`Response`. It parses a `Request`
// into a framework-free `ParsedRequest` and serializes a `ResultModel` back into
// a `Response`. Keeping this isolated lets the dispatch logic (`handler.ts`) be
// driven and asserted as plain data, and lets the streaming-download branch be
// modeled without constructing a real `Response`.

import type { JsonValue } from "../json.js";
import { RouterError } from "./envelope.js";

export interface ParsedRequest {
  method: string;
  /** The `?op=` query action for the byte paths (`download` / `upload` / `proxy`). */
  action: string | null;
  /** Origin derived from the request URL, used as the default CSRF allowlist. */
  requestOrigin: string;
  /** The request URL's path — the endpoint an upload token is bound to. */
  path: string;
  query: URLSearchParams;
  origin: string | null;
  rangeHeader: string | null;
  /** The `If-Range` validator guarding `rangeHeader`, if any. */
  ifRangeHeader: string | null;
  /** Parsed JSON body for a POST action; `undefined` otherwise. */
  json: JsonValue | undefined;
  /** Raw body stream for a byte-path PUT; `null` otherwise. */
  bodyStream: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  contentLength: number | undefined;
  signal: AbortSignal;
}

export type ResultModel =
  | {
      kind: "json";
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    }
  | { kind: "redirect"; status: number; location: string }
  | {
      kind: "stream";
      status: number;
      headers: Record<string, string>;
      stream: ReadableStream<Uint8Array>;
    };

/** Default cap on a JSON request body (1 MiB). */
export const DEFAULT_MAX_JSON_BODY_SIZE = 1024 * 1024;

const bodyTooLarge = (maxBytes: number): RouterError =>
  new RouterError(
    "Validation",
    `JSON request body exceeds ${maxBytes} bytes`,
    "size",
    413
  );

// Read a POST body as text, refusing (413) once it passes `maxBytes` — before
// buffering the rest — so an oversized body can't be streamed into memory.
const readBoundedText = async (
  req: Request,
  contentLength: number | undefined,
  maxBytes: number
): Promise<string> => {
  if (contentLength !== undefined && contentLength > maxBytes) {
    throw bodyTooLarge(maxBytes);
  }
  if (!req.body) {
    return "";
  }
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read chunk by chunk
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    total += value.byteLength;
    if (total > maxBytes) {
      // oxlint-disable-next-line no-await-in-loop -- release the stream before refusing it
      await reader.cancel();
      throw bodyTooLarge(maxBytes);
    }
    text += decoder.decode(value, { stream: true });
  }
};

export const parseRequest = async (
  req: Request,
  maxJsonBodySize: number = DEFAULT_MAX_JSON_BODY_SIZE
): Promise<ParsedRequest> => {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const action = url.searchParams.get("op");
  const contentType = req.headers.get("content-type");

  const lengthHeader = req.headers.get("content-length");
  const contentLength =
    lengthHeader === null ? undefined : Number(lengthHeader);
  const knownLength = Number.isNaN(contentLength) ? undefined : contentLength;

  let json: JsonValue | undefined;
  let bodyStream: ReadableStream<Uint8Array> | null = null;
  if (method === "POST") {
    const text = await readBoundedText(req, knownLength, maxJsonBodySize);
    try {
      json = JSON.parse(text);
    } catch {
      throw new RouterError("Validation", "invalid JSON request body");
    }
  } else if (method === "PUT") {
    bodyStream = req.body;
  }

  return {
    action,
    bodyStream,
    contentLength: knownLength,
    contentType,
    ifRangeHeader: req.headers.get("if-range"),
    json,
    method,
    origin: req.headers.get("origin"),
    path: url.pathname,
    query: url.searchParams,
    rangeHeader: req.headers.get("range"),
    requestOrigin: url.origin,
    signal: req.signal,
  };
};

export const buildResponse = (model: ResultModel): Response => {
  switch (model.kind) {
    case "json": {
      return Response.json(model.body, {
        headers: model.headers,
        status: model.status,
      });
    }
    case "redirect": {
      return new Response(null, {
        headers: {
          "cache-control": "private, no-store",
          location: model.location,
        },
        status: model.status,
      });
    }
    default: {
      return new Response(model.stream, {
        headers: model.headers,
        status: model.status,
      });
    }
  }
};
