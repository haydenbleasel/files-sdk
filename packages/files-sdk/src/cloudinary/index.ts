import { Buffer } from "node:buffer";

import { v2 as cloudinary } from "cloudinary";
import type { UploadApiOptions, UploadApiResponse } from "cloudinary";

import type {
  Adapter,
  Body,
  ByteRange,
  ListOptions,
  ListResult,
  OffsetResumableDriver,
  ResumableUploadSession,
  SignUploadOptions,
  SignedUpload,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../index.js";
import {
  assertRangeHonored,
  collectStream,
  DEFAULT_URL_EXPIRES_IN,
  existsByProbe,
  makeErrorMapper,
  normalizeBody,
  rangeRequestHeaders,
} from "../internal/core.js";
import { readEnv } from "../internal/env.js";
import { FilesError } from "../internal/errors.js";
import { createStoredFile } from "../internal/stored-file.js";
import { compareKeys, paginateHierarchy } from "../internal/walk-paginate.js";

export type CloudinaryResourceType = "image" | "video" | "raw";
export type CloudinaryDeliveryType = "upload" | "private" | "authenticated";

export interface CloudinaryAdapterOptions {
  /**
   * Cloudinary cloud name. Falls back to `CLOUDINARY_CLOUD_NAME` or to the
   * `cloud_name` parsed out of `CLOUDINARY_URL`.
   */
  cloudName?: string;
  /**
   * Cloudinary API key. Falls back to `CLOUDINARY_API_KEY` or the value parsed
   * out of `CLOUDINARY_URL`.
   */
  apiKey?: string;
  /**
   * Cloudinary API secret. Falls back to `CLOUDINARY_API_SECRET` or the value
   * parsed out of `CLOUDINARY_URL`. Required for `signedUploadUrl()` and for
   * private/authenticated `url()` signing.
   */
  apiSecret?: string;
  /**
   * Cloudinary resource_type bucket. Defaults to `"raw"` — the closest match
   * to S3-style "arbitrary bytes" storage. Switch to `"image"`/`"video"` if
   * the bucket holds those types and you want transforms.
   */
  resourceType?: CloudinaryResourceType;
  /**
   * Delivery type. Defaults to `"upload"` (public CDN). Use `"private"` or
   * `"authenticated"` for access-controlled assets — `url()` then mints
   * short-lived signed URLs.
   */
  type?: CloudinaryDeliveryType;
  /**
   * Pre-configured `cloudinary.v2` namespace — escape hatch for callers that
   * have already called `cloudinary.config()` themselves and want the adapter
   * to skip its own configuration. When passed, `cloudName`/`apiKey`/
   * `apiSecret` are ignored for SDK calls but still needed for
   * `signedUploadUrl()` (the adapter computes the signature locally).
   */
  client?: typeof cloudinary;
  /**
   * Serve assets over HTTPS. Defaults to `true`.
   */
  secure?: boolean;
  /**
   * Default expiry, in seconds, for signed URLs returned by `url()` on
   * private/authenticated assets. Per-call `opts.expiresIn` overrides.
   * Defaults to 3600.
   */
  signedUrlExpiresIn?: number;
}

export type CloudinaryAdapter = Adapter<typeof cloudinary> & {
  readonly resourceType: CloudinaryResourceType;
  readonly type: CloudinaryDeliveryType;
  readonly cloudName: string;
};

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const CLOUDINARY_API_ROOT = "https://api.cloudinary.com/v1_1";

const EMPTY_CODES: ReadonlySet<string> = new Set();

// Cloudinary errors come in two shapes: the SDK throws an Error with
// `error.http_code` for admin/api calls, and `http_code` for upload errors.
// Both are classified purely by HTTP status; provider code strings are
// inconsistent enough that we don't bother matching on them.
export const mapCloudinaryError = makeErrorMapper({
  codes: {
    conflict: EMPTY_CODES,
    notFound: EMPTY_CODES,
    unauthorized: EMPTY_CODES,
  },
  extract: (err) => {
    const e = err as {
      http_code?: number;
      error?: { http_code?: number; message?: string };
      message?: string;
    };
    const status = e?.error?.http_code ?? e?.http_code;
    const message = e?.error?.message ?? e?.message;
    return {
      ...(typeof status === "number" && { status }),
      ...(message && { message }),
    };
  },
  providerLabel: "Cloudinary error",
});

const parseCloudinaryUrl = (
  url: string
): { cloudName?: string; apiKey?: string; apiSecret?: string } => {
  // Format: cloudinary://<api_key>:<api_secret>@<cloud_name>
  const match =
    /^cloudinary:\/\/(?<apiKey>[^:]+):(?<apiSecret>[^@]+)@(?<cloudName>.+)$/u.exec(
      url
    );
  if (!match) {
    return {};
  }
  return {
    apiKey: decodeURIComponent(match[1] ?? ""),
    apiSecret: decodeURIComponent(match[2] ?? ""),
    cloudName: decodeURIComponent(match[3] ?? ""),
  };
};

const resolveConfig = (
  opts: CloudinaryAdapterOptions
): { cloudName: string; apiKey?: string; apiSecret?: string } => {
  const envUrl = readEnv("CLOUDINARY_URL");
  const envParsed = envUrl ? parseCloudinaryUrl(envUrl) : {};
  const cloudName =
    opts.cloudName ?? readEnv("CLOUDINARY_CLOUD_NAME") ?? envParsed.cloudName;
  const apiKey =
    opts.apiKey ?? readEnv("CLOUDINARY_API_KEY") ?? envParsed.apiKey;
  const apiSecret =
    opts.apiSecret ?? readEnv("CLOUDINARY_API_SECRET") ?? envParsed.apiSecret;
  if (!cloudName) {
    throw new FilesError(
      "Provider",
      "cloudinary: missing cloudName. Pass `cloudName` (and `apiKey`/`apiSecret` for non-public ops) or set CLOUDINARY_CLOUD_NAME or CLOUDINARY_URL."
    );
  }
  return {
    cloudName,
    ...(apiKey && { apiKey }),
    ...(apiSecret && { apiSecret }),
  };
};

const toBuffer = async (body: Body): Promise<Buffer> => {
  const normalized = await normalizeBody(body);
  const bytes =
    normalized.data instanceof ReadableStream
      ? await collectStream(normalized.data)
      : normalized.data;
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

interface CloudinaryResource {
  public_id: string;
  bytes?: number;
  format?: string;
  resource_type?: string;
  etag?: string;
  created_at?: string;
}

const resolveContentType = (
  resource: { resource_type?: string; format?: string },
  hint?: string
): string => {
  if (hint) {
    return hint;
  }
  if (resource.resource_type === "image" && resource.format) {
    return `image/${resource.format}`;
  }
  if (resource.resource_type === "video" && resource.format) {
    return `video/${resource.format}`;
  }
  return "application/octet-stream";
};

export const cloudinaryAdapter = (
  opts: CloudinaryAdapterOptions = {}
): CloudinaryAdapter => {
  const resourceType: CloudinaryResourceType = opts.resourceType ?? "raw";
  const type: CloudinaryDeliveryType = opts.type ?? "upload";
  const secure = opts.secure ?? true;
  const signedUrlExpiresIn = opts.signedUrlExpiresIn ?? DEFAULT_URL_EXPIRES_IN;

  const { cloudName, apiKey, apiSecret } = resolveConfig(opts);

  const sdk = opts.client ?? cloudinary;

  // Cloudinary's SDK keeps configuration as module-level global state. When
  // the caller passes a pre-built `client`, we trust they configured it
  // already. Otherwise we set the config now — note this DOES mutate the
  // global namespace; mounting multiple cloudinary adapters in the same
  // process with different credentials will see only the last config win.
  // Documented as a limitation.
  if (!opts.client) {
    sdk.config({
      ...(apiKey && { api_key: apiKey }),
      ...(apiSecret && { api_secret: apiSecret }),
      cloud_name: cloudName,
      secure,
    });
  }

  const uploadBuffer = (
    buf: Buffer,
    uploadOpts: UploadApiOptions
  ): Promise<UploadApiResponse> =>
    // Cloudinary's upload_stream is a node Writable that delivers the
    // response via callback — there is no Promise-returning equivalent.
    // oxlint-disable-next-line promise/avoid-new
    new Promise((resolve, reject) => {
      // oxlint-disable-next-line promise/prefer-await-to-callbacks
      const stream = sdk.uploader.upload_stream(uploadOpts, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        if (!result) {
          reject(
            new FilesError(
              "Provider",
              "cloudinary: upload_stream returned no result"
            )
          );
          return;
        }
        resolve(result);
      });
      stream.end(buf);
    });

  const buildDeliveryUrl = (key: string): string =>
    sdk.url(key, {
      resource_type: resourceType,
      secure,
      type,
    });

  const buildSignedDeliveryUrl = (
    key: string,
    format: string,
    expiresIn: number
  ): string =>
    sdk.utils.private_download_url(key, format, {
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      resource_type: resourceType,
      type,
    });

  // `signal` is only threaded when `download()` calls this inline; the
  // head()/list() factories invoke it lazily (outside any operation scope) and
  // pass none, matching how the other adapters leave deferred bodies unsigned.
  const lazyDownload =
    (key: string, signal?: AbortSignal, range?: ByteRange) =>
    async (): Promise<Uint8Array> => {
      const url = buildDeliveryUrl(key);
      const res = await fetch(url, {
        ...(signal && { signal }),
        ...(range && { headers: rangeRequestHeaders(range) }),
      });
      if (!res.ok) {
        throw new FilesError(
          res.status === 404 ? "NotFound" : "Provider",
          `cloudinary: download failed for "${key}" (${res.status} ${res.statusText})`
        );
      }
      if (range) {
        assertRangeHonored(res.status, "cloudinary");
      }
      const buf = await res.arrayBuffer();
      return new Uint8Array(buf);
    };

  return {
    cloudName,
    async copy(from, to) {
      try {
        // Cloudinary has no native copy — `rename` is move-only. Re-upload
        // by URL: Cloudinary fetches `secure_url` and ingests it as a new
        // asset under `to`. Document: copies produce a new asset_id and a
        // new etag, not a byte-identical reference.
        const sourceUrl = buildDeliveryUrl(from);
        await sdk.uploader.upload(sourceUrl, {
          overwrite: true,
          public_id: to,
          resource_type: resourceType,
          type,
        });
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    async delete(key) {
      try {
        await sdk.uploader.destroy(key, {
          invalidate: true,
          resource_type: resourceType,
          type,
        });
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    async download(key, downloadOpts) {
      try {
        const range = downloadOpts?.range;
        const [resource, bytes] = await Promise.all([
          sdk.api.resource(key, {
            resource_type: resourceType,
            type,
          }) as Promise<{
            bytes?: number;
            format?: string;
            resource_type?: string;
            etag?: string;
            created_at?: string;
          }>,
          lazyDownload(key, downloadOpts?.signal, range)(),
        ]);
        return createStoredFile(
          {
            ...(resource.etag && { etag: resource.etag }),
            key,
            ...(resource.created_at && {
              lastModified: new Date(resource.created_at).getTime(),
            }),
            // `resource.bytes` is the full asset size — for a ranged read the
            // bytes we actually fetched are authoritative.
            size: range
              ? bytes.byteLength
              : (resource.bytes ?? bytes.byteLength),
            type: resolveContentType(resource),
          },
          { data: bytes, kind: "buffer" }
        );
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    exists(key) {
      return existsByProbe(
        () =>
          sdk.api.resource(key, {
            resource_type: resourceType,
            type,
          }),
        mapCloudinaryError
      );
    },
    async head(key) {
      try {
        const resource = (await sdk.api.resource(key, {
          resource_type: resourceType,
          type,
        })) as {
          bytes?: number;
          format?: string;
          resource_type?: string;
          etag?: string;
          created_at?: string;
        };
        return createStoredFile(
          {
            ...(resource.etag && { etag: resource.etag }),
            key,
            ...(resource.created_at && {
              lastModified: new Date(resource.created_at).getTime(),
            }),
            size: resource.bytes ?? 0,
            type: resolveContentType(resource),
          },
          { factory: lazyDownload(key), kind: "lazy" }
        );
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    async list(listOpts?: ListOptions): Promise<ListResult> {
      try {
        const toStored = (resource: CloudinaryResource): StoredFile =>
          createStoredFile(
            {
              ...(resource.etag && { etag: resource.etag }),
              key: resource.public_id,
              ...(resource.created_at && {
                lastModified: new Date(resource.created_at).getTime(),
              }),
              size: resource.bytes ?? 0,
              type: resolveContentType(resource),
            },
            { factory: lazyDownload(resource.public_id), kind: "lazy" }
          );
        // resources() lists every public_id under the prefix (recursively),
        // with no native folder mode that matches our API, so gather them all
        // and synthesize the common prefixes in memory. Nested so the flat
        // `list` stays simple.
        const listFolded = async (delimiter: string): Promise<ListResult> => {
          const byKey = new Map<string, CloudinaryResource>();
          let next: string | undefined;
          do {
            const apiOpts: Record<string, unknown> = {
              max_results: MAX_LIST_LIMIT,
              resource_type: resourceType,
              type,
            };
            if (listOpts?.prefix) {
              apiOpts.prefix = listOpts.prefix;
            }
            if (next) {
              apiOpts.next_cursor = next;
            }
            // eslint-disable-next-line no-await-in-loop -- pagination: each page uses the next_cursor from the previous response
            const resp = (await sdk.api.resources(apiOpts)) as {
              resources?: CloudinaryResource[];
              next_cursor?: string;
            };
            for (const r of resp.resources ?? []) {
              byKey.set(r.public_id, r);
            }
            next = resp.next_cursor;
          } while (next);
          const sortedKeys = [...byKey.keys()].toSorted(compareKeys);
          const page = paginateHierarchy(sortedKeys, {
            delimiter,
            ...(listOpts?.limit !== undefined && { limit: listOpts.limit }),
            ...(listOpts?.prefix !== undefined && { prefix: listOpts.prefix }),
            ...(listOpts?.cursor !== undefined && { cursor: listOpts.cursor }),
          });
          return {
            items: page.items.map((key) =>
              toStored(byKey.get(key) as CloudinaryResource)
            ),
            ...(page.cursor && { cursor: page.cursor }),
            ...(page.prefixes.length && { prefixes: page.prefixes }),
          };
        };
        if (listOpts?.delimiter) {
          return await listFolded(listOpts.delimiter);
        }
        const requested = listOpts?.limit ?? DEFAULT_LIST_LIMIT;
        const limit = Math.min(requested, MAX_LIST_LIMIT);
        const apiOpts: Record<string, unknown> = {
          max_results: limit,
          resource_type: resourceType,
          type,
        };
        if (listOpts?.prefix) {
          apiOpts.prefix = listOpts.prefix;
        }
        if (listOpts?.cursor) {
          apiOpts.next_cursor = listOpts.cursor;
        }
        const response = (await sdk.api.resources(apiOpts)) as {
          resources?: CloudinaryResource[];
          next_cursor?: string;
        };
        const items: StoredFile[] = (response.resources ?? []).map(toStored);
        return {
          ...(response.next_cursor && { cursor: response.next_cursor }),
          items,
        };
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    async move(from, to) {
      try {
        // Cloudinary's `rename` is a native, server-side move — no byte
        // round-trip, unlike copy()'s re-upload-by-URL. It keeps the same
        // asset_id, so this is a true rename rather than a fresh ingest.
        await sdk.uploader.rename(from, to, {
          invalidate: true,
          overwrite: true,
          resource_type: resourceType,
          type,
        });
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    name: "cloudinary",
    raw: sdk,
    resourceType,
    resumableUpload(key, resumableOpts): OffsetResumableDriver {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // before a resumable upload ever reaches here.
      if (!(apiKey && apiSecret)) {
        throw new FilesError(
          "Provider",
          "cloudinary: resumable uploads require both apiKey and apiSecret."
        );
      }
      const signingKey = apiKey;
      const signingSecret = apiSecret;
      let session:
        | Extract<ResumableUploadSession, { provider: "cloudinary" }>
        | undefined;
      let finalResponse:
        | {
            public_id: string;
            bytes?: number;
            etag?: string;
            created_at?: string;
          }
        | undefined;
      let contentType = "application/octet-stream";
      const requireSession = () => {
        if (!session) {
          throw new FilesError(
            "Provider",
            "cloudinary: resumable upload not started."
          );
        }
        return session;
      };
      return {
        adopt(adopted: ResumableUploadSession) {
          if (adopted.provider !== "cloudinary") {
            throw new FilesError(
              "Provider",
              `Cannot resume a ${adopted.provider} session on a cloudinary adapter.`
            );
          }
          if (adopted.key !== key) {
            throw new FilesError(
              "Provider",
              "Resume token does not match this upload's key."
            );
          }
          session = adopted;
          ({ contentType } = adopted);
        },
        begin(meta): Promise<ResumableUploadSession> {
          ({ contentType } = meta);
          session = {
            contentType,
            key,
            offset: 0,
            // Cloudinary ties a chunked upload together by this header value.
            provider: "cloudinary",
            // oxlint-disable-next-line sonarjs/pseudo-random -- non-crypto: just a unique-enough tag to correlate chunks of one upload.
            uploadId: `fls-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          };
          return Promise.resolve(session);
        },
        complete(): Promise<UploadResult> {
          if (!finalResponse) {
            throw new FilesError(
              "Provider",
              "cloudinary: upload did not finalize."
            );
          }
          return Promise.resolve({
            contentType: resolveContentType(
              finalResponse as UploadApiResponse,
              contentType
            ),
            ...(finalResponse.etag && { etag: finalResponse.etag }),
            key: finalResponse.public_id,
            ...(finalResponse.created_at && {
              lastModified: new Date(finalResponse.created_at).getTime(),
            }),
            size: finalResponse.bytes ?? requireSession().offset,
          });
        },
        discard() {
          // Cloudinary has no abort for an in-progress chunked upload; the
          // partial expires on its own.
          return Promise.resolve();
        },
        mode: "offset",
        partSize:
          typeof resumableOpts.multipart === "object" &&
          resumableOpts.multipart.partSize
            ? resumableOpts.multipart.partSize
            : 20 * 1024 * 1024,
        probe(): Promise<{ nextOffset: number }> {
          return Promise.resolve({ nextOffset: requireSession().offset });
        },
        async uploadAt({ offset, data, total, signal }): Promise<{
          nextOffset: number;
        }> {
          const current = requireSession();
          const timestamp = Math.floor(Date.now() / 1000);
          const signature = sdk.utils.api_sign_request(
            { public_id: key, timestamp },
            signingSecret
          );
          const form = new FormData();
          form.append("file", new Blob([data as unknown as BlobPart]), key);
          form.append("api_key", signingKey);
          form.append("timestamp", String(timestamp));
          form.append("signature", signature);
          form.append("public_id", key);
          const res = await fetch(
            `${CLOUDINARY_API_ROOT}/${cloudName}/${resourceType}/upload`,
            {
              body: form,
              headers: {
                "Content-Range": `bytes ${offset}-${offset + data.byteLength - 1}/${total}`,
                "X-Unique-Upload-Id": current.uploadId,
              },
              method: "POST",
              ...(signal && { signal }),
            }
          );
          if (!res.ok) {
            const text = await res.text();
            throw new FilesError(
              "Provider",
              `cloudinary: chunk upload failed (HTTP ${res.status}): ${text}`.trim()
            );
          }
          const json = (await res.json()) as { public_id?: string } & Record<
            string,
            unknown
          >;
          if (json.public_id) {
            finalResponse = json as typeof finalResponse;
          }
          const nextOffset = offset + data.byteLength;
          current.offset = nextOffset;
          return { nextOffset };
        },
      };
    },
    signedUploadUrl(
      key: string,
      signOpts: SignUploadOptions
    ): Promise<SignedUpload> {
      if (!apiKey || !apiSecret) {
        throw new FilesError(
          "Provider",
          "cloudinary: signedUploadUrl requires both apiKey and apiSecret. Pass them at construction or set CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET / CLOUDINARY_URL."
        );
      }
      if (signOpts.maxSize !== undefined) {
        throw new FilesError(
          "Provider",
          "cloudinary: `maxSize` is not supported for signed upload URLs. Cloudinary upload signatures do not expose a server-enforced content-length-range policy; enforce the limit through your application gateway or omit `maxSize` and accept the unbounded signed upload."
        );
      }
      // Cloudinary signatures are computed over a sorted, ampersand-joined
      // parameter set excluding `file`, `cloud_name`, `resource_type`, and
      // `api_key`. The SDK helper handles the sort+hash for us.
      const timestamp = Math.floor(Date.now() / 1000);
      const paramsToSign: Record<string, string | number> = {
        public_id: key,
        timestamp,
        ...(signOpts.contentType && { content_type: signOpts.contentType }),
      };
      const signature = sdk.utils.api_sign_request(paramsToSign, apiSecret);
      const url = `${CLOUDINARY_API_ROOT}/${cloudName}/${resourceType}/upload`;
      const fields: Record<string, string> = {
        api_key: apiKey,
        public_id: key,
        signature,
        timestamp: String(timestamp),
      };
      if (signOpts.contentType) {
        fields.content_type = signOpts.contentType;
      }
      return Promise.resolve({
        fields,
        method: "POST",
        url,
      });
    },
    // `private` / `authenticated` delivery types sign URLs; the default
    // `upload` (public) delivery type returns an unsigned, permanent CDN URL.
    signedUrl: { supported: type !== "upload" },
    supportsDelimiter: true,
    supportsRange: true,
    // No native copy — `copy()` re-uploads by URL into a new asset.
    supportsServerSideCopy: false,
    type,
    async upload(
      key: string,
      body: Body,
      uploadOpts?: UploadOptions
    ): Promise<UploadResult> {
      // `metadata` / `cacheControl` are rejected centrally by the Files wrapper
      // (this adapter advertises neither) — Cloudinary exposes no HTTP
      // cache-header or arbitrary-metadata field on asset content.
      try {
        const buf = await toBuffer(body);
        const response = await uploadBuffer(buf, {
          invalidate: true,
          overwrite: true,
          public_id: key,
          resource_type: resourceType,
          type,
        });
        return {
          contentType: resolveContentType(response, uploadOpts?.contentType),
          ...(response.etag && { etag: response.etag }),
          key: response.public_id,
          ...(response.created_at && {
            lastModified: new Date(response.created_at).getTime(),
          }),
          size: response.bytes,
        };
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
    async url(key: string, urlOpts?: UrlOptions): Promise<string> {
      if (urlOpts?.responseContentDisposition) {
        throw new FilesError(
          "Provider",
          "cloudinary: `responseContentDisposition` is not supported. Cloudinary has no per-request Content-Disposition override — set the `attachment` flag on the asset URL via `raw` if you need it."
        );
      }
      try {
        if (type === "upload") {
          return buildDeliveryUrl(key);
        }
        // private / authenticated — sign with expiry. private_download_url
        // needs the asset format, so do a HEAD to learn it.
        const expiresIn = urlOpts?.expiresIn ?? signedUrlExpiresIn;
        const resource = (await sdk.api.resource(key, {
          resource_type: resourceType,
          type,
        })) as { format?: string };
        if (!resource.format) {
          throw new FilesError(
            "Provider",
            `cloudinary: cannot mint signed URL for "${key}" — resource has no format. Raw assets must store their extension in the public_id.`
          );
        }
        return buildSignedDeliveryUrl(key, resource.format, expiresIn);
      } catch (error) {
        throw mapCloudinaryError(error);
      }
    },
  };
};

export { cloudinaryAdapter as cloudinary };
