import { createStoredFile } from "../src/index.js";
import type {
  Adapter,
  Body,
  DeleteManyOptions,
  DeleteManyResult,
  DownloadOptions,
  ListOptions,
  ListResult,
  SignUploadOptions,
  SignedUpload,
  StoredFile,
  UploadOptions,
  UploadResult,
  UrlOptions,
} from "../src/index.js";
import { FilesError } from "../src/internal/errors.js";

interface Entry {
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
  cacheControl?: string;
  etag: string;
  uploadedAt: number;
}

export interface FakeAdapter extends Adapter<Map<string, Entry>> {
  has(key: string): boolean;
}

const bytesOf = async (body: Body): Promise<Uint8Array> => {
  if (typeof body === "string") {
    return new TextEncoder().encode(body);
  }
  if (body instanceof Uint8Array) {
    return body;
  }
  if (body instanceof ArrayBuffer) {
    return new Uint8Array(body);
  }
  if (ArrayBuffer.isView(body)) {
    const v = body as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (body instanceof Blob) {
    return new Uint8Array(await body.arrayBuffer());
  }
  // ReadableStream
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
};

const compareKeys = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

export const fakeAdapter = (config?: {
  supportsRange?: boolean;
}): FakeAdapter => {
  const store = new Map<string, Entry>();
  let counter = 0;
  const nextEtag = () => {
    counter += 1;
    return `"etag-${counter}"`;
  };

  const toStored = (key: string, entry: Entry): StoredFile =>
    createStoredFile(
      {
        etag: entry.etag,
        key,
        lastModified: entry.uploadedAt,
        metadata: entry.metadata,
        size: entry.bytes.byteLength,
        type: entry.contentType,
      },
      { data: entry.bytes, kind: "buffer" }
    );

  return {
    copy(from: string, to: string): Promise<void> {
      const entry = store.get(from);
      if (!entry) {
        throw new FilesError("NotFound", `not found: ${from}`);
      }
      store.set(to, { ...entry, etag: nextEtag(), uploadedAt: Date.now() });
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    deleteMany(
      keys: string[],
      opts?: DeleteManyOptions
    ): Promise<DeleteManyResult> {
      const deleted: string[] = [];
      const errors: NonNullable<DeleteManyResult["errors"]> = [];
      for (const key of keys) {
        if (key.startsWith("fail/")) {
          errors.push({
            error: new FilesError("Provider", `delete failed: ${key}`),
            key,
          });
          if (opts?.stopOnError) {
            break;
          }
          continue;
        }
        store.delete(key);
        deleted.push(key);
      }
      if (errors.length === 0) {
        return Promise.resolve({ deleted });
      }
      return Promise.resolve({ deleted, errors });
    },
    download(key: string, downloadOpts?: DownloadOptions): Promise<StoredFile> {
      const entry = store.get(key);
      if (!entry) {
        throw new FilesError("NotFound", `not found: ${key}`);
      }
      const range = downloadOpts?.range;
      if (range) {
        const sliced = entry.bytes.subarray(
          range.start,
          range.end === undefined ? undefined : range.end + 1
        );
        return Promise.resolve(
          createStoredFile(
            {
              etag: entry.etag,
              key,
              lastModified: entry.uploadedAt,
              metadata: entry.metadata,
              size: sliced.byteLength,
              type: entry.contentType,
            },
            { data: sliced, kind: "buffer" }
          )
        );
      }
      return Promise.resolve(toStored(key, entry));
    },
    exists(key: string): Promise<boolean> {
      return Promise.resolve(store.has(key));
    },
    has(key) {
      return store.has(key);
    },
    head(key: string): Promise<StoredFile> {
      const entry = store.get(key);
      if (!entry) {
        throw new FilesError("NotFound", `not found: ${key}`);
      }
      return Promise.resolve(toStored(key, entry));
    },
    list(opts?: ListOptions): Promise<ListResult> {
      const prefix = opts?.prefix ?? "";
      const limit = opts?.limit ?? 1000;
      const cursor = opts?.cursor;
      const sorted = [...store.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .toSorted(([a], [b]) => compareKeys(a, b));
      const start = cursor ? sorted.findIndex(([k]) => k > cursor) : 0;
      const slice = sorted.slice(
        start === -1 ? sorted.length : start,
        (start === -1 ? sorted.length : start) + limit
      );
      const lastKey = slice.at(-1)?.[0];
      const more = start + slice.length < sorted.length;
      return Promise.resolve({
        cursor: more && lastKey ? lastKey : undefined,
        items: slice.map(([k, e]) => toStored(k, e)),
      });
    },
    name: "fake",
    raw: store,
    ...(config?.supportsRange && { supportsRange: true }),
    signedUploadUrl(
      key: string,
      _opts: SignUploadOptions
    ): Promise<SignedUpload> {
      return Promise.resolve({
        headers: { "Content-Type": "application/octet-stream" },
        method: "PUT",
        url: `https://fake.local/${encodeURIComponent(key)}`,
      });
    },
    async upload(
      key: string,
      body: Body,
      opts?: UploadOptions
    ): Promise<UploadResult> {
      const bytes = await bytesOf(body);
      const entry: Entry = {
        bytes,
        cacheControl: opts?.cacheControl,
        contentType: opts?.contentType ?? "application/octet-stream",
        etag: nextEtag(),
        metadata: opts?.metadata,
        uploadedAt: Date.now(),
      };
      store.set(key, entry);
      return {
        contentType: entry.contentType,
        etag: entry.etag,
        key,
        lastModified: entry.uploadedAt,
        size: bytes.byteLength,
      };
    },
    url(key: string, opts?: UrlOptions): Promise<string> {
      if (!store.has(key)) {
        throw new FilesError("NotFound", `not found: ${key}`);
      }
      const expires = opts?.expiresIn ?? 3600;
      return Promise.resolve(
        `https://fake.local/${encodeURIComponent(key)}?expires=${expires}`
      );
    },
  };
};
