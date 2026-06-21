"use client";

import { useFiles, useList } from "files-sdk/react";
import Image from "next/image";
import { useState } from "react";
import type { FormEvent } from "react";

const ENDPOINT = "/api/files";

export default function FilesDemoPage() {
  const files = useFiles({ endpoint: ENDPOINT });
  const list = useList({}, { endpoint: ENDPOINT });
  const [busy, setBusy] = useState(false);

  const onUpload = async (event: FormEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    setBusy(true);
    try {
      await files.upload(file);
      list.refetch();
    } finally {
      setBusy(false);
      input.value = "";
    }
  };

  const onDelete = async (key: string) => {
    await files.delete(key);
    list.refetch();
  };

  const items = list.data?.items ?? [];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <header>
        <h1 className="font-semibold text-2xl">useFiles demo</h1>
        <p className="text-fd-muted-foreground text-sm">
          One <code>useFiles({"{ endpoint }"})</code> hook, full Files-API
          parity over <code>{ENDPOINT}</code> (in-memory storage, scoped to{" "}
          <code>demo/</code>).
        </p>
      </header>

      <label className="flex flex-col gap-2">
        <span className="font-medium text-sm">Upload a file</span>
        <input
          aria-label="Upload a file"
          disabled={busy}
          onChange={onUpload}
          type="file"
        />
      </label>

      {files.isUploading && (
        <div className="h-2 w-full overflow-hidden rounded bg-fd-muted">
          <div
            className="h-full bg-fd-primary transition-all"
            style={{ width: `${Math.round(files.progress.fraction * 100)}%` }}
          />
        </div>
      )}

      {files.error && (
        <p className="text-red-500 text-sm">
          {files.error.code}: {files.error.message}
        </p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-medium text-sm">
          Files {list.isFetching ? "(refreshing…)" : `(${items.length})`}
        </h2>
        {items.length === 0 && (
          <p className="text-fd-muted-foreground text-sm">Nothing yet.</p>
        )}
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              className="flex items-center gap-3 rounded border border-fd-border p-2"
              key={item.key}
            >
              {item.type.startsWith("image/") && (
                // The download GET endpoint proxies the bytes, so this works
                // even for an adapter that can't mint a public URL. `unoptimized`
                // skips the Next image loader for the dynamic gateway URL.
                <Image
                  alt={item.key}
                  className="rounded object-cover"
                  height={48}
                  src={`${ENDPOINT}?op=download&key=${encodeURIComponent(item.key)}`}
                  unoptimized
                  width={48}
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{item.key}</p>
                <p className="text-fd-muted-foreground text-xs">
                  {item.size} bytes · {item.type}
                </p>
              </div>
              <button
                className="text-red-500 text-sm hover:underline"
                onClick={() => onDelete(item.key)}
                type="button"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
