// The single seam that touches the browser upload primitives. `xhrTransport`
// uses `XMLHttpRequest` because it is the only API that reports *upload*
// progress (`upload.onprogress`); `fetchTransport` is the no-XHR fallback (it
// loses progress, emitting start/finish). Both drive a presigned PUT (raw body)
// or POST (FormData with `fields` in order, then `file` last — the S3 rule), and
// the through-endpoint upload path which returns a JSON body.

import { FilesError } from "../internal/errors.js";
import { abortError } from "../internal/retry.js";

export interface SendRequest {
  url: string;
  method: "PUT" | "POST";
  headers?: Record<string, string>;
  /** Presigned-POST form fields, appended in order before the file. */
  fields?: Record<string, string>;
  /**
   * `Uint8Array` appears only on runtimes whose `Blob` cannot wrap raw bytes
   * (React Native); both XHR and fetch accept it as a request body directly.
   */
  body: Blob | Uint8Array | null;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export interface SendResult {
  status: number;
  text: string;
}

export type Transport = (req: SendRequest) => Promise<SendResult>;

const bodySize = (body: Blob | Uint8Array): number =>
  body instanceof Blob ? body.size : body.byteLength;

// The multipart `file` part must be a Blob. A raw-byte body only exists on
// runtimes whose Blob rejects byte parts (React Native), where presigned-POST
// multipart is unusable anyway — the wrap below throws there, accurately.
const asFilePart = (body: Blob | Uint8Array): Blob =>
  body instanceof Blob ? body : new Blob([body as BlobPart]);

const buildBody = (req: SendRequest): XMLHttpRequestBodyInit | null => {
  if (req.method === "POST" && req.fields) {
    const form = new FormData();
    for (const [key, value] of Object.entries(req.fields)) {
      form.append(key, value);
    }
    if (req.body) {
      form.append("file", asFilePart(req.body));
    }
    return form;
  }
  return req.body;
};

export const xhrTransport: Transport = (req) =>
  // oxlint-disable-next-line promise/avoid-new -- XHR is a callback API.
  new Promise<SendResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(req.method, req.url, true);
    // A presigned POST sets Content-Type via the multipart boundary; only set
    // explicit headers for the PUT / through-endpoint paths.
    if (req.headers && !(req.method === "POST" && req.fields)) {
      for (const [key, value] of Object.entries(req.headers)) {
        xhr.setRequestHeader(key, value);
      }
    }
    if (req.onProgress) {
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable) {
          req.onProgress?.(event.loaded, event.total);
        }
      });
    }
    xhr.addEventListener("load", () =>
      resolve({ status: xhr.status, text: xhr.responseText })
    );
    xhr.addEventListener("error", () =>
      reject(new FilesError("Provider", "network error during upload"))
    );
    xhr.addEventListener("abort", () => reject(abortError(req.signal?.reason)));

    if (req.signal) {
      if (req.signal.aborted) {
        xhr.abort();
        return;
      }
      req.signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(buildBody(req));
  });

export const fetchTransport =
  (fetchImpl: typeof fetch): Transport =>
  async (req) => {
    const total = req.body ? bodySize(req.body) : 0;
    req.onProgress?.(0, total);
    let body: BodyInit | null;
    if (req.method === "POST" && req.fields) {
      const form = new FormData();
      for (const [key, value] of Object.entries(req.fields)) {
        form.append(key, value);
      }
      if (req.body) {
        form.append("file", asFilePart(req.body));
      }
      body = form;
    } else {
      ({ body } = req);
    }
    const res = await fetchImpl(req.url, {
      body,
      headers: req.method === "POST" && req.fields ? undefined : req.headers,
      method: req.method,
      signal: req.signal,
    });
    req.onProgress?.(total, total);
    return { status: res.status, text: await res.text() };
  };

/** Default transport: XHR when available (real progress), else fetch. */
export const defaultTransport = (fetchImpl: typeof fetch): Transport =>
  typeof XMLHttpRequest === "undefined"
    ? fetchTransport(fetchImpl)
    : xhrTransport;
