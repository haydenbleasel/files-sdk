// The ONLY seam that touches Web `Request`/`Response`. It parses a `Request`
// into a framework-free `ParsedRequest` and serializes a `ResultModel` back into
// a `Response`. Keeping this isolated lets the dispatch logic (`handler.ts`) be
// driven and asserted as plain data, and lets the streaming-download branch be
// modeled without constructing a real `Response`.

import { RouterError } from "./envelope.js";

export interface ParsedRequest {
  method: string;
  /** The `?op=` query action for the byte paths (`download` / `upload` / `proxy`). */
  action: string | null;
  query: URLSearchParams;
  origin: string | null;
  rangeHeader: string | null;
  /** Parsed JSON body for a POST action; `undefined` otherwise. */
  json: unknown;
  /** Raw body stream for a byte-path PUT; `null` otherwise. */
  bodyStream: ReadableStream<Uint8Array> | null;
  contentType: string | null;
  contentLength: number | undefined;
  signal: AbortSignal;
}

export type ResultModel =
  | { kind: "json"; status: number; body: unknown }
  | { kind: "empty"; status: number; headers?: Record<string, string> }
  | { kind: "redirect"; status: number; location: string }
  | {
      kind: "stream";
      status: number;
      headers: Record<string, string>;
      stream: ReadableStream<Uint8Array>;
    };

export const parseRequest = async (req: Request): Promise<ParsedRequest> => {
  const url = new URL(req.url);
  const method = req.method.toUpperCase();
  const action = url.searchParams.get("op");
  const contentType = req.headers.get("content-type");

  let json: unknown;
  let bodyStream: ReadableStream<Uint8Array> | null = null;
  if (method === "POST") {
    try {
      json = await req.json();
    } catch {
      throw new RouterError("Validation", "invalid JSON request body");
    }
  } else if (method === "PUT") {
    bodyStream = req.body as ReadableStream<Uint8Array> | null;
  }

  const lengthHeader = req.headers.get("content-length");
  const contentLength =
    lengthHeader === null ? undefined : Number(lengthHeader);

  return {
    action,
    bodyStream,
    contentLength: Number.isNaN(contentLength) ? undefined : contentLength,
    contentType,
    json,
    method,
    origin: req.headers.get("origin"),
    query: url.searchParams,
    rangeHeader: req.headers.get("range"),
    signal: req.signal,
  };
};

export const buildResponse = (model: ResultModel): Response => {
  switch (model.kind) {
    case "json": {
      return Response.json(model.body, { status: model.status });
    }
    case "empty": {
      return new Response(null, {
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
