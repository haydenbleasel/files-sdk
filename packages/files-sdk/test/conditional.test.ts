import { describe, expect, mock, test } from "bun:test";

import {
  Files,
  FilesError,
  handlers,
  isConditionalOperation,
  rejectConditional,
} from "../src/index.js";
import type {
  Adapter,
  AdapterDownloadOptions,
  AdapterUploadOptions,
  Body,
  ConditionalUploadResult,
  CopyCondition,
  FilesActionEvent,
  FilesErrorEvent,
  FilesPlugin,
  OperationOptions,
  Receipt,
  StoredFile,
} from "../src/index.js";
import { fakeAdapter } from "./fake-adapter.js";

const bareEtag = (etag: string | undefined): string => {
  if (!etag) {
    throw new Error("test adapter did not produce an ETag");
  }
  return etag.startsWith('"') && etag.endsWith('"') ? etag.slice(1, -1) : etag;
};

const bodyText = async (body: Body): Promise<string> => {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof Blob) {
    return body.text();
  }
  if (body instanceof ArrayBuffer) {
    return new TextDecoder().decode(body);
  }
  if (ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(
      new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
    );
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- a test helper drains the stream in order
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value) {
      chunks.push(value);
    }
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

interface ConditionalHarness {
  adapter: Adapter;
  base: ReturnType<typeof fakeAdapter>;
  calls: {
    copy: CopyCondition[];
    create: string[];
    delete: string[];
    exactRead: string[];
    replace: string[];
    uploadBodies: string[];
    uploadKeys: string[];
    uploadMetadata: (Record<string, string> | undefined)[];
  };
}

const conditionalHarness = (opts?: {
  createFailures?: number;
}): ConditionalHarness => {
  const base = fakeAdapter({ supportsRange: true });
  let createFailures = opts?.createFailures ?? 0;
  const calls: ConditionalHarness["calls"] = {
    copy: [],
    create: [],
    delete: [],
    exactRead: [],
    replace: [],
    uploadBodies: [],
    uploadKeys: [],
    uploadMetadata: [],
  };

  const currentEtag = async (key: string): Promise<string> => {
    const file = await base.head(key);
    return bareEtag(file.etag);
  };
  const upload = async (
    mode: "create" | "replace",
    key: string,
    body: Body,
    uploadOptions?: AdapterUploadOptions
  ): Promise<ConditionalUploadResult> => {
    calls[mode].push(key);
    calls.uploadKeys.push(key);
    calls.uploadBodies.push(await bodyText(body));
    calls.uploadMetadata.push(uploadOptions?.metadata);
    if (mode === "create" && createFailures > 0) {
      createFailures -= 1;
      throw new FilesError("Provider", "temporary conditional failure");
    }
    const result = await base.upload(key, body, uploadOptions);
    return { ...result, etag: bareEtag(result.etag) };
  };

  const adapter: Adapter = {
    ...base,
    conditional: {
      copy: {
        atomicSourceDestination: true,
        destinationCreate: true,
        destinationReplace: true,
        async run(
          from: string,
          to: string,
          condition: CopyCondition
        ): Promise<void> {
          calls.copy.push(condition);
          if ((await currentEtag(from)) !== condition.source.etag) {
            throw new FilesError("Conflict", "source ETag mismatch");
          }
          if (condition.destination.type === "create") {
            if (base.has(to)) {
              throw new FilesError("Conflict", "destination exists");
            }
          } else if (
            !base.has(to) ||
            (await currentEtag(to)) !== condition.destination.etag
          ) {
            throw new FilesError("Conflict", "destination ETag mismatch");
          }
          await base.copy(from, to);
        },
        sourceEtag: true,
      },
      create: (key, body, uploadOptions) =>
        upload("create", key, body, uploadOptions),
      async delete(
        key: string,
        etag: string,
        deleteOptions?: OperationOptions
      ): Promise<void> {
        calls.delete.push(key);
        if ((await currentEtag(key)) !== etag) {
          throw new FilesError("Conflict", "delete ETag mismatch");
        }
        await base.delete(key, deleteOptions);
      },
      async exactRead(
        key: string,
        etag: string,
        downloadOptions?: AdapterDownloadOptions
      ): Promise<StoredFile> {
        calls.exactRead.push(key);
        if ((await currentEtag(key)) !== etag) {
          throw new FilesError("Conflict", "read ETag mismatch");
        }
        const file = await base.download(key, downloadOptions);
        return { ...file, etag: bareEtag(file.etag) };
      },
      async replace(key, body, etag, uploadOptions) {
        if (!base.has(key) || (await currentEtag(key)) !== etag) {
          throw new FilesError("Conflict", "replace ETag mismatch");
        }
        return upload("replace", key, body, uploadOptions);
      },
    },
  };
  return { adapter, base, calls };
};

describe("native conditional operations", () => {
  test("all primitives use native adapter operations, prefixing, and plugin transforms", async () => {
    const harness = conditionalHarness();
    const seen: string[] = [];
    const protection: FilesPlugin = {
      name: "protection",
      wrap: handlers({
        upload: (op, next) => {
          if (isConditionalOperation(op)) {
            seen.push(`${op.kind}:${op.mode}:${op.key}`);
          }
          return next({
            ...op,
            body: "ciphertext",
            options: {
              ...op.options,
              metadata: { protected: "true" },
            },
          });
        },
      }),
    };
    const files = new Files({
      adapter: harness.adapter,
      plugins: [protection],
      prefix: "tenant",
    });

    const created = await files.upload("record", "plaintext", {
      condition: { type: "create" },
    });
    expect(created.etag).toBeString();
    expect(harness.calls.uploadKeys).toEqual(["tenant/record"]);
    expect(harness.calls.uploadBodies).toEqual(["ciphertext"]);
    expect(harness.calls.uploadMetadata).toEqual([{ protected: "true" }]);
    expect(seen).toEqual(["upload:create:record"]);

    const exact = await files.download("record", {
      condition: { etag: created.etag },
      range: { end: 5, start: 0 },
    });
    expect(await exact.text()).toBe("cipher");
    expect(exact.key).toBe("record");

    const replaced = await files.upload("record", "new plaintext", {
      condition: { etag: created.etag, type: "replace" },
    });
    expect(replaced.etag).not.toBe(created.etag);
    await files.delete("record", { condition: { etag: replaced.etag } });
    expect(harness.base.has("tenant/record")).toBe(false);
  });

  test("conditional copy requires and forwards both predicates atomically", async () => {
    const harness = conditionalHarness();
    const files = new Files({ adapter: harness.adapter });
    const source = await files.upload("source", "value", {
      condition: { type: "create" },
    });

    await files.copy("source", "destination", {
      condition: {
        destination: { type: "create" },
        source: { etag: source.etag },
      },
    });
    const destination = await files.download("destination");
    expect(await destination.text()).toBe("value");
    expect(harness.calls.copy).toEqual([
      {
        destination: { type: "create" },
        source: { etag: source.etag },
      },
    ]);
  });

  test("copy snapshots caller predicate objects before plugins can mutate them", async () => {
    const harness = conditionalHarness();
    const seed = new Files({ adapter: harness.adapter });
    const source = await seed.upload("source", "value", {
      condition: { type: "create" },
    });
    const sourcePredicate = { etag: source.etag };
    const destinationPredicate = { type: "create" as const };
    const mutateCallerReferences: FilesPlugin = {
      name: "mutate-caller-references",
      wrap: handlers({
        copy: (op, next) => {
          sourcePredicate.etag = "attacker-source";
          Reflect.set(destinationPredicate, "type", "replace");
          Reflect.set(destinationPredicate, "etag", "attacker-destination");
          return next(op);
        },
      }),
    };
    const files = new Files({
      adapter: harness.adapter,
      plugins: [mutateCallerReferences],
    });

    await files.copy("source", "destination", {
      condition: {
        destination: destinationPredicate,
        source: sourcePredicate,
      },
    });
    expect(harness.calls.copy.at(-1)).toEqual({
      destination: { type: "create" },
      source: { etag: source.etag },
    });
  });

  test("capabilities are conservative and unsupported operations perform no provider I/O", async () => {
    const base = fakeAdapter();
    const upload = mock(base.upload);
    const download = mock(base.download);
    const deleteOne = mock(base.delete);
    const copy = mock(base.copy);
    const files = new Files({
      adapter: {
        ...base,
        copy,
        delete: deleteOne,
        download,
        upload,
      },
    });

    expect(files.capabilities.conditional).toEqual({
      copy: {
        atomicSourceDestination: false,
        destinationCreate: false,
        destinationReplace: false,
        sourceEtag: false,
      },
      create: false,
      delete: false,
      exactRead: false,
      multipart: { create: false, replace: false },
      replace: false,
    });
    await expect(
      files.upload("a", "v", { condition: { type: "create" } })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.upload("a", "v", {
        condition: { etag: "etag", type: "replace" },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.download("a", { condition: { etag: "etag" } })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.delete("a", { condition: { etag: "etag" } })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    await expect(
      files.copy("a", "b", {
        condition: {
          destination: { type: "create" },
          source: { etag: "etag" },
        },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(upload).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();

    const partial = conditionalHarness();
    const partialCopy = partial.adapter.conditional?.copy;
    if (!partialCopy) {
      throw new Error("test adapter lacks copy");
    }
    const partialRun = mock(partialCopy.run);
    partialCopy.run = partialRun;
    Reflect.set(partialCopy, "destinationCreate", false);
    const partialFiles = new Files({ adapter: partial.adapter });
    expect(partialFiles.capabilities.conditional.copy).toEqual({
      atomicSourceDestination: true,
      destinationCreate: false,
      destinationReplace: true,
      sourceEtag: true,
    });
    await expect(
      partialFiles.copy("source", "destination", {
        condition: {
          destination: { type: "create" },
          source: { etag: "etag" },
        },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(partialRun).not.toHaveBeenCalled();
  });

  test("malformed, weak, wildcard, quoted, and list ETags fail before I/O", async () => {
    const harness = conditionalHarness();
    const files = new Files({ adapter: harness.adapter });
    await Promise.all(
      ["", '"quoted"', "W/weak", "*", "one,two", "has space"].map((etag) =>
        expect(
          files.upload("a", "v", {
            condition: { etag, type: "replace" },
          })
        ).rejects.toMatchObject({ code: "Provider", permanent: true })
      )
    );
    expect(harness.calls.replace).toHaveLength(0);
  });

  test("malformed runtime conditions never downgrade to ordinary operations", async () => {
    const harness = conditionalHarness();
    const ordinaryUpload = mock(harness.adapter.upload);
    const ordinaryDownload = mock(harness.adapter.download);
    const ordinaryDelete = mock(harness.adapter.delete);
    const ordinaryCopy = mock(harness.adapter.copy);
    harness.adapter.upload = ordinaryUpload;
    harness.adapter.download = ordinaryDownload;
    harness.adapter.delete = ordinaryDelete;
    harness.adapter.copy = ordinaryCopy;
    const files = new Files({ adapter: harness.adapter });

    await Promise.all(
      [null, false, 0, ""].map((invalid, index) => {
        const options = {};
        Reflect.set(options, "condition", invalid);
        return expect(
          files.upload(`upload-${index}`, "plaintext", options)
        ).rejects.toMatchObject({ code: "Provider", permanent: true });
      })
    );

    const downloadOptions = {};
    Reflect.set(downloadOptions, "condition", false);
    await expect(
      files.download("download", downloadOptions)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });

    const deleteOptions = {};
    Reflect.set(deleteOptions, "condition", 0);
    await expect(files.delete("delete", deleteOptions)).rejects.toMatchObject({
      code: "Provider",
      permanent: true,
    });

    const copyOptions = {};
    Reflect.set(copyOptions, "condition", {
      destination: { type: "create" },
      source: null,
    });
    await expect(
      files.copy("source", "destination", copyOptions)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });

    expect(ordinaryUpload).not.toHaveBeenCalled();
    expect(ordinaryDownload).not.toHaveBeenCalled();
    expect(ordinaryDelete).not.toHaveBeenCalled();
    expect(ordinaryCopy).not.toHaveBeenCalled();
    expect(harness.calls.create).toHaveLength(0);
    expect(harness.calls.replace).toHaveLength(0);
    expect(harness.calls.exactRead).toHaveLength(0);
    expect(harness.calls.delete).toHaveLength(0);
    expect(harness.calls.copy).toHaveLength(0);
  });

  test("conditional multipart, resumable, and casted bulk predicates fail closed", async () => {
    const base = fakeAdapter();
    const upload = mock(base.upload);
    const download = mock(base.download);
    const deleteOne = mock(base.delete);
    const harness = conditionalHarness();
    const files = new Files({
      adapter: {
        ...harness.adapter,
        delete: deleteOne,
        download,
        upload,
      },
    });

    await expect(
      files.upload("a", "v", {
        condition: { type: "create" },
        multipart: true,
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });

    const uploadItem = { body: "v", key: "bulk-upload" };
    Reflect.set(uploadItem, "condition", { type: "create" });
    await expect(files.upload([uploadItem])).rejects.toMatchObject({
      code: "Provider",
      permanent: true,
    });
    const uploadOptions = {};
    Reflect.set(uploadOptions, "condition", { type: "create" });
    await expect(
      files.upload([{ body: "v", key: "bulk-options" }], uploadOptions)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });

    const downloadOptions = {};
    Reflect.set(downloadOptions, "condition", { etag: "etag" });
    await expect(
      files.download(["bulk-download"], downloadOptions)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    const deleteOptions = {};
    Reflect.set(deleteOptions, "condition", { etag: "etag" });
    await expect(
      files.delete(["bulk-delete"], deleteOptions)
    ).rejects.toMatchObject({ code: "Provider", permanent: true });

    expect(harness.calls.create).toHaveLength(0);
    expect(upload).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(deleteOne).not.toHaveBeenCalled();
  });
});

describe("conditional option handling", () => {
  test("multipart: false is the documented opt-out, not a multipart request", async () => {
    const harness = conditionalHarness();
    const files = new Files({ adapter: harness.adapter });
    const result = await files.upload("a", "v", {
      condition: { type: "create" },
      multipart: false,
    });
    expect(result.etag).toBeString();
    expect(harness.calls.create).toEqual(["a"]);
    // A real multipart ask is still incompatible.
    await expect(
      files.upload("b", "v", {
        condition: { type: "create" },
        multipart: { partSize: 5 * 1024 * 1024 },
      })
    ).rejects.toMatchObject({ code: "Provider", permanent: true });
    expect(harness.calls.create).toEqual(["a"]);
  });

  test("bulk calls treat condition: undefined as absent, like a spread of shared options", async () => {
    const harness = conditionalHarness();
    const files = new Files({ adapter: harness.adapter });
    await files.upload("a", "v");
    await files.upload("b", "v");

    const uploaded = await files.upload([{ body: "x", key: "c" }], {
      condition: undefined,
    } as never);
    expect(uploaded.uploaded.map((item) => item.key)).toEqual(["c"]);

    const downloaded = await files.download(["a", "b"], {
      as: "buffer",
      condition: undefined,
    } as never);
    expect(downloaded.downloaded).toHaveLength(2);

    const deleted = await files.delete(["a", "b"], {
      condition: undefined,
    } as never);
    expect(deleted.deleted).toEqual(["a", "b"]);
  });

  test("ordinary delete and copy still pass extra options through to plugins and the adapter", async () => {
    const harness = conditionalHarness();
    const seenByPlugin: unknown[] = [];
    const seenByAdapter: unknown[] = [];
    const adapter: Adapter = {
      ...harness.adapter,
      copy(from, to, opts) {
        seenByAdapter.push(opts);
        return harness.adapter.copy(from, to, opts);
      },
      delete(key, opts) {
        seenByAdapter.push(opts);
        return harness.adapter.delete(key, opts);
      },
    };
    const observe: FilesPlugin = {
      name: "observe",
      wrap: (op, next) => {
        if (op.kind === "delete" || op.kind === "copy") {
          seenByPlugin.push(op.options);
        }
        return next(op);
      },
    };
    const files = new Files({ adapter, plugins: [observe] });
    await files.upload("a", "v");
    await files.copy("a", "b", { reason: "audit" } as never);
    await files.delete("a", { reason: "gdpr" } as never);
    expect(seenByPlugin).toEqual([{ reason: "audit" }, { reason: "gdpr" }]);
    expect(seenByAdapter).toEqual([{ reason: "audit" }, { reason: "gdpr" }]);

    // The conditional forms strip only the predicate itself.
    const { etag } = await files.head("b");
    await files.delete("b", {
      condition: { etag: bareEtag(etag) },
      timeout: 5000,
    });
    expect(seenByPlugin.at(-1)).toEqual({ timeout: 5000 });
  });
});

describe("conditional plugin boundary", () => {
  test("a veto or a provider failure is never reported as applied", async () => {
    const vetoHarness = conditionalHarness();
    const veto: FilesPlugin = {
      name: "veto",
      wrap: handlers({
        upload: () => Promise.reject(new FilesError("Unauthorized", "blocked")),
      }),
    };
    await expect(
      new Files({ adapter: vetoHarness.adapter, plugins: [veto] }).upload(
        "a",
        "v",
        { condition: { type: "create" } }
      )
    ).rejects.toMatchObject({ applied: false, code: "Unauthorized" });

    const failingHarness = conditionalHarness({ createFailures: 1 });
    await expect(
      new Files({ adapter: failingHarness.adapter }).upload("a", "v", {
        condition: { type: "create" },
        retries: { max: 0 },
      })
    ).rejects.toMatchObject({ applied: false, code: "Provider" });
    expect(failingHarness.base.has("a")).toBe(false);
  });

  test("retrying next() after the native call failed carries the first failure as cause", async () => {
    const harness = conditionalHarness({ createFailures: 1 });
    let seen: unknown;
    const retry: FilesPlugin = {
      name: "retry-after-failure",
      wrap: handlers({
        upload: async (op, next) => {
          try {
            return await next(op);
          } catch (error) {
            seen = error;
            return await next(op);
          }
        },
      }),
    };
    const failure = await new Files({
      adapter: harness.adapter,
      plugins: [retry],
    })
      .upload("a", "v", { condition: { type: "create" }, retries: { max: 0 } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FilesError);
    expect((failure as FilesError).permanent).toBe(true);
    expect((failure as Error).message).toMatch(
      /more than once.*first invocation failed/u
    );
    expect((failure as FilesError).cause).toBe(seen);
    expect((failure as FilesError).applied).toBe(false);
    expect(harness.calls.create).toEqual(["a"]);
  });

  test("rejectConditional is the uniform plugin veto", async () => {
    const harness = conditionalHarness();
    const mirror: FilesPlugin = {
      name: "mirror",
      wrap: (op, next) => {
        if (isConditionalOperation(op)) {
          rejectConditional(
            op,
            "mirror",
            "the mirror write cannot share one native compare-and-set"
          );
        }
        return next(op);
      },
    };
    const files = new Files({ adapter: harness.adapter, plugins: [mirror] });
    const failure = await files
      .delete("a", { condition: { etag: "abc" } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FilesError);
    expect(failure).toMatchObject({
      applied: false,
      code: "Provider",
      message:
        "mirror: conditional delete is unsupported because the mirror write cannot share one native compare-and-set",
      permanent: true,
    });
    expect(harness.calls.delete).toHaveLength(0);
    // Ordinary operations are untouched.
    await files.upload("b", "v");
    expect(harness.base.has("b")).toBe(true);
  });

  test("a plugin that catches a rejected predicate change and retries correctly gets the committed result", async () => {
    const harness = conditionalHarness();
    let rejected: unknown;
    const retry: FilesPlugin = {
      name: "catch-then-retry",
      wrap: handlers({
        upload: async (op, next) => {
          try {
            // Dropping the predicate is a violation, rejected before the
            // provider is reached.
            const downgraded = { ...op };
            Reflect.deleteProperty(downgraded, "mode");
            return await next(downgraded as typeof op);
          } catch (error) {
            rejected = error;
            // The bad call never reached the provider; this one is exactly
            // the caller's predicate and must be reported as what it is: a
            // committed conditional write.
            return await next(op);
          }
        },
      }),
    };
    const files = new Files({ adapter: harness.adapter, plugins: [retry] });
    const result = await files.upload("a", "v", {
      condition: { type: "create" },
    });
    expect(rejected).toBeInstanceOf(FilesError);
    expect(harness.calls.create).toEqual(["a"]);
    expect(harness.calls.uploadBodies).toEqual(["v"]);
    const committed = await files.head("a");
    expect(result.etag).toBe(bareEtag(committed.etag));
  });

  test("a plugin cannot introduce a condition into an ordinary operation", async () => {
    const harness = conditionalHarness();
    const ordinaryUpload = mock(harness.adapter.upload);
    harness.adapter.upload = ordinaryUpload;
    const introduce: FilesPlugin = {
      name: "introduce-condition",
      wrap: handlers({
        upload: (op, next) => {
          Reflect.set(op, "mode", "create");
          return next(op);
        },
      }),
    };
    const files = new Files({ adapter: harness.adapter, plugins: [introduce] });
    await expect(files.upload("a", "v")).rejects.toThrow(
      "cannot introduce a conditional predicate"
    );
    expect(ordinaryUpload).not.toHaveBeenCalled();
    expect(harness.calls.create).toHaveLength(0);
  });

  test("a veto runs before provider I/O", async () => {
    const harness = conditionalHarness();
    const veto: FilesPlugin = {
      name: "veto",
      wrap: handlers({
        upload: () => Promise.reject(new FilesError("Unauthorized", "blocked")),
      }),
    };
    const files = new Files({ adapter: harness.adapter, plugins: [veto] });
    await expect(
      files.upload("a", "v", { condition: { type: "create" } })
    ).rejects.toThrow("blocked");
    expect(harness.calls.create).toHaveLength(0);
  });

  test("predicate downgrade, mutation, and delimiter-collision attacks fail closed", async () => {
    const downgradeHarness = conditionalHarness();
    const downgrade: FilesPlugin = {
      name: "downgrade",
      wrap: handlers({
        upload: (op, next) => {
          Reflect.set(op, "mode", "overwrite");
          return next(op);
        },
      }),
    };
    await expect(
      new Files({
        adapter: downgradeHarness.adapter,
        plugins: [downgrade],
      }).upload("a", "v", { condition: { type: "create" } })
    ).rejects.toThrow("cannot remove or change");
    expect(downgradeHarness.calls.create).toHaveLength(0);

    const collisionHarness = conditionalHarness();
    const collision: FilesPlugin = {
      name: "collision",
      wrap: handlers({
        copy: (op, next) => {
          if (op.mode !== "conditional") {
            return next(op);
          }
          const candidate = {
            ...op,
            destination: { etag: "b:replace:c", type: "replace" as const },
            source: { etag: "a" },
          };
          return next(candidate);
        },
      }),
    };
    await expect(
      new Files({
        adapter: collisionHarness.adapter,
        plugins: [collision],
      }).copy("a", "b", {
        condition: {
          destination: { etag: "c", type: "replace" },
          source: { etag: "a:replace:b" },
        },
      })
    ).rejects.toThrow("cannot remove or change");
    expect(collisionHarness.calls.copy).toHaveLength(0);
  });

  test("synthetic success and a second next call are rejected", async () => {
    const syntheticHarness = conditionalHarness();
    const synthetic: FilesPlugin = {
      name: "synthetic",
      wrap: handlers({
        upload: (op, next) =>
          isConditionalOperation(op)
            ? Promise.resolve({
                contentType: "application/octet-stream",
                etag: "invented",
                key: op.key,
                size: 0,
              })
            : next(op),
      }),
    };
    await expect(
      new Files({
        adapter: syntheticHarness.adapter,
        plugins: [synthetic],
      }).upload("a", "v", { condition: { type: "create" } })
    ).rejects.toThrow("cannot synthesize");
    expect(syntheticHarness.calls.create).toHaveLength(0);

    const twiceHarness = conditionalHarness();
    const twice: FilesPlugin = {
      name: "twice",
      wrap: handlers({
        upload: async (op, next) => {
          const result = await next(op);
          await next(op);
          return result;
        },
      }),
    };
    await expect(
      new Files({ adapter: twiceHarness.adapter, plugins: [twice] }).upload(
        "a",
        "v",
        { condition: { type: "create" } }
      )
    ).rejects.toThrow("more than once");
    expect(twiceHarness.calls.create).toHaveLength(1);
  });

  test("dropping or replacing the result ETag rejects after the mutation", async () => {
    const harness = conditionalHarness();
    const dropEtag: FilesPlugin = {
      name: "drop-etag",
      wrap: handlers({
        upload: async (op, next) => {
          const result = await next(op);
          if (isConditionalOperation(op)) {
            Reflect.deleteProperty(result, "etag");
          }
          return result;
        },
      }),
    };
    const files = new Files({ adapter: harness.adapter, plugins: [dropEtag] });
    await expect(
      files.upload("a", "v", { condition: { type: "create" } })
    ).rejects.toMatchObject({
      applied: true,
      message: expect.stringContaining(
        "must return its new canonical strong ETag"
      ),
    });
    expect(harness.base.has("a")).toBe(true);
    expect(harness.calls.create).toHaveLength(1);

    const changedHarness = conditionalHarness();
    const changeEtag: FilesPlugin = {
      name: "change-etag",
      wrap: handlers({
        upload: async (op, next) => {
          const result = await next(op);
          if (isConditionalOperation(op)) {
            Reflect.set(result, "etag", "invented");
          }
          return result;
        },
      }),
    };
    const changed = new Files({
      adapter: changedHarness.adapter,
      plugins: [changeEtag],
    });
    await expect(
      changed.upload("a", "v", { condition: { type: "create" } })
    ).rejects.toMatchObject({
      applied: true,
      message: expect.stringContaining("cannot replace the ETag"),
    });
    expect(changedHarness.base.has("a")).toBe(true);
    expect(changedHarness.calls.create).toHaveLength(1);
  });

  test("observer failure after mutation rejects, is not retried, and emits no receipt", async () => {
    const harness = conditionalHarness();
    const actions: FilesActionEvent[] = [];
    const errors: FilesErrorEvent[] = [];
    const observer: FilesPlugin = {
      name: "observer",
      wrap: handlers({
        upload: async (op, next) => {
          await next(op);
          throw new Error("observer failed");
        },
      }),
    };
    const swallowingOuter: FilesPlugin = {
      name: "swallowing-outer",
      wrap: handlers({
        upload: async (op, next) => {
          try {
            return await next(op);
          } catch {
            return {
              contentType: "application/octet-stream",
              etag: "invented",
              key: op.key,
              size: 0,
            };
          }
        },
      }),
    };
    const files = new Files({
      adapter: harness.adapter,
      hooks: {
        onAction: (event) => actions.push(event),
        onError: (event) => errors.push(event),
      },
      plugins: [swallowingOuter, observer],
      receipts: true,
    });

    const failure = await files
      .upload("a", "v", {
        condition: { type: "create" },
        retries: 3,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FilesError);
    expect((failure as Error).message).toBe("observer failed");
    expect((failure as FilesError).applied).toBe(true);
    expect((failure as FilesError).appliedEtag).toBeString();
    expect(harness.base.has("a")).toBe(true);
    expect(harness.calls.create).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.condition).toBe("create");
    // Hooks see the same applied-but-unacknowledged signal as the caller.
    expect(errors[0]?.error.applied).toBe(true);
    expect(errors[0]?.error.appliedEtag).toBeString();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      condition: "create",
      status: "error",
      type: "upload",
    });
    expect(actions[0]?.receipt).toBeUndefined();
  });
});

describe("conditional hooks, retries, receipts, and policy", () => {
  test("async hook rejections remain fire-and-forget terminal observations", async () => {
    const harness = conditionalHarness();
    let actionCalls = 0;
    let errorCalls = 0;
    const vetoBlocked: FilesPlugin = {
      name: "veto-blocked",
      wrap: handlers({
        upload: (op, next) => {
          if (op.key === "blocked") {
            throw new FilesError("Unauthorized", "blocked by policy");
          }
          return next(op);
        },
      }),
    };
    const files = new Files({
      adapter: harness.adapter,
      hooks: {
        async onAction() {
          actionCalls += 1;
          await Promise.resolve();
          throw new Error("async action observer failed");
        },
        async onError() {
          errorCalls += 1;
          await Promise.resolve();
          throw new Error("async error observer failed");
        },
      },
      plugins: [vetoBlocked],
      receipts: true,
    });

    await expect(
      files.upload("created", "value", { condition: { type: "create" } })
    ).resolves.toMatchObject({ etag: expect.any(String) });
    await expect(
      files.upload("blocked", "value", { condition: { type: "create" } })
    ).rejects.toMatchObject({ code: "Unauthorized" });
    await Promise.resolve();

    expect(actionCalls).toBe(2);
    expect(errorCalls).toBe(1);
    expect(harness.calls.create).toEqual(["created"]);
  });

  test("a retry preserves the predicate and reports its redacted condition", async () => {
    const harness = conditionalHarness({ createFailures: 1 });
    const retries: FilesActionEvent[] = [];
    const retryConditions: string[] = [];
    const files = new Files({
      adapter: harness.adapter,
      hooks: {
        onAction: (event) => retries.push(event),
        onRetry: (event) => {
          if (event.condition) {
            retryConditions.push(event.condition);
          }
        },
      },
    });
    const result = await files.upload("a", "v", {
      condition: { type: "create" },
      retries: { backoff: () => 0, max: 1 },
    });
    expect(result.etag).toBeString();
    expect(harness.calls.create).toEqual(["a", "a"]);
    expect(retryConditions).toEqual(["create"]);
    expect(retries[0]).toMatchObject({
      condition: "create",
      status: "success",
    });
  });

  test("success receipts keep base verbs plus conditional summaries", async () => {
    const harness = conditionalHarness();
    const receipts: Receipt[] = [];
    const files = new Files({
      adapter: harness.adapter,
      hooks: {
        onAction(event) {
          if (event.receipt) {
            receipts.push(event.receipt);
          }
        },
      },
      receipts: true,
    });

    const created = await files.upload("source", "one", {
      condition: { type: "create" },
    });
    const replaced = await files.upload("source", "two", {
      condition: { etag: created.etag, type: "replace" },
    });
    await files.download("source", {
      condition: { etag: replaced.etag },
    });
    await files.copy("source", "copy", {
      condition: {
        destination: { type: "create" },
        source: { etag: replaced.etag },
      },
    });
    await files.delete("source", { condition: { etag: replaced.etag } });

    expect(receipts.map(({ condition, op }) => [op, condition])).toEqual([
      ["upload", "create"],
      ["upload", "replace"],
      ["copy", "conditional-copy"],
      ["delete", "match-delete"],
    ]);
  });

  test("readonly blocks conditional writes but permits exact reads", async () => {
    const harness = conditionalHarness();
    const writable = new Files({ adapter: harness.adapter });
    const created = await writable.upload("a", "value", {
      condition: { type: "create" },
    });
    const readonly = writable.readonly();
    const exact = await readonly.download("a", {
      condition: { etag: created.etag },
    });
    expect(await exact.text()).toBe("value");
    await expect(
      readonly.upload("b", "value", { condition: { type: "create" } })
    ).rejects.toMatchObject({ code: "ReadOnly" });
    expect(harness.calls.create).toEqual(["a"]);
  });

  test("timeout aborts the native attempt without retrying", async () => {
    const harness = conditionalHarness();
    let attempts = 0;
    let sawSignal = false;
    const { conditional } = harness.adapter;
    if (!conditional?.create) {
      throw new Error("test adapter lacks create");
    }
    conditional.create = (
      _key,
      _body,
      uploadOptions
    ): Promise<ConditionalUploadResult> => {
      attempts += 1;
      sawSignal = uploadOptions?.signal !== undefined;
      const pending = Promise.withResolvers<ConditionalUploadResult>();
      uploadOptions?.signal?.addEventListener(
        "abort",
        () => pending.reject(uploadOptions.signal?.reason),
        { once: true }
      );
      return pending.promise;
    };
    const files = new Files({ adapter: harness.adapter });
    await expect(
      files.upload("a", "v", {
        condition: { type: "create" },
        retries: 2,
        timeout: 5,
      })
    ).rejects.toMatchObject({ aborted: true, timedOut: true });
    expect(attempts).toBe(1);
    expect(sawSignal).toBe(true);
  });
});
