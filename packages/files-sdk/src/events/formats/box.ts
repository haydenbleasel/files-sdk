// Box webhooks (v2). `files-sdk/box` keys are paths under the adapter's
// `rootFolderId`, so the key is rebuilt from the file's `path_collection`;
// files outside that folder are dropped. Signatures: base64(HMAC-SHA256(key,
// raw body ‖ BOX-DELIVERY-TIMESTAMP)) in BOX-SIGNATURE-PRIMARY (primary key)
// or BOX-SIGNATURE-SECONDARY (secondary key), at most ten minutes old.
//
// A trashed file's `path_collection` is the Trash folder alone (Box's
// Trashed File resource); only its immediate `parent` records where it was.
// So a `FILE.TRASHED` / `FILE.DELETED` event has a key only when its path
// still runs through the root folder, or when the file sat directly in it;
// a delete deeper down can't be placed and is dropped.
//
// Box can't attach a v2 webhook to the root folder `0`, so watch a real
// folder (and point the adapter's `rootFolderId` at it).

import { isString } from "../../internal/is.js";
import type { JsonObject } from "../../internal/json.js";
import { isJsonArray, isJsonObject } from "../../internal/json.js";
import {
  concatBytes,
  hmac,
  timingSafeEqual,
  toBase64,
  utf8,
} from "../crypto.js";
import type { EventParser, ParseContext, RawEvent } from "./types.js";
import { malformed, stampOf, toSize, toTime, unauthorized } from "./types.js";

const MAX_AGE_MS = 10 * 60 * 1000;
const ROOT = "0";

const typeOf = (trigger: string): "created" | "deleted" | undefined => {
  switch (trigger) {
    case "FILE.UPLOADED":
    case "FILE.RESTORED": {
      return "created";
    }
    case "FILE.TRASHED":
    case "FILE.DELETED": {
      return "deleted";
    }
    default: {
      // FILE.MOVED / FILE.RENAMED carry only the new location; COPIED doesn't
      // say which file `source` is; the rest don't add or remove a file.
      return undefined;
    }
  }
};

const rootOf = ({ adapter }: ParseContext): string =>
  adapter.name === "box" &&
  "rootFolderId" in adapter &&
  isString(adapter.rootFolderId)
    ? adapter.rootFolderId
    : ROOT;

/**
 * The file's key under `root`, or `undefined` when it lives elsewhere — or,
 * for a trashed file, when it wasn't directly in `root` (the Trash folder
 * replaces its path, so only its `parent` is known).
 */
const keyOf = (
  source: JsonObject,
  root: string,
  type: "created" | "deleted"
): string | undefined => {
  if (!isString(source.name)) {
    return undefined;
  }
  const collection = source.path_collection;
  const entries =
    isJsonObject(collection) && isJsonArray(collection.entries)
      ? collection.entries
      : [];
  const at = entries.findIndex(
    (entry) => isJsonObject(entry) && entry.id === root
  );
  if (at === -1) {
    const { parent } = source;
    return type === "deleted" && isJsonObject(parent) && parent.id === root
      ? source.name
      : undefined;
  }
  const folders = entries
    .slice(at + 1)
    .map((entry) => (isJsonObject(entry) ? String(entry.name) : ""));
  return [...folders, source.name].join("/");
};

const fromBody = (body: JsonObject, context: ParseContext): RawEvent[] => {
  const { source, trigger } = body;
  if (!(isString(trigger) && isJsonObject(source))) {
    throw malformed("box", "event without trigger or source");
  }
  const type = typeOf(trigger);
  if (!type || source.type !== "file") {
    return [];
  }
  const key = keyOf(source, rootOf(context), type);
  if (key === undefined) {
    return [];
  }
  const size = toSize(source.size);
  const version = isJsonObject(source.file_version)
    ? source.file_version.id
    : undefined;
  return [
    {
      id: isString(body.id)
        ? body.id
        : `${trigger}:${String(source.id)}@${stampOf(body, body.created_at)}`,
      key,
      raw: body,
      time: toTime(body.created_at, Date.now()),
      type,
      ...(type === "created" && size !== undefined && { size }),
      ...(isString(source.etag) && { etag: source.etag }),
      ...(isString(version) && { versionId: version }),
    },
  ];
};

export const boxParser: EventParser = {
  format: "box",
  parse: ({ body }, context) => fromBody(body, context),
  verifySignature: async ({ body, headers, now, secondarySecret, secret }) => {
    if (
      headers.get("box-signature-version") !== "1" ||
      headers.get("box-signature-algorithm") !== "HmacSHA256"
    ) {
      throw unauthorized("not a Box v1 HmacSHA256 signature");
    }
    const timestamp = headers.get("box-delivery-timestamp") ?? "";
    const sent = Date.parse(timestamp);
    if (Number.isNaN(sent) || Math.abs(now - sent) > MAX_AGE_MS) {
      throw unauthorized("Box delivery timestamp is missing or too old");
    }
    const data = concatBytes(utf8(body), utf8(timestamp));
    const matches = async (
      header: string,
      key: string | undefined
    ): Promise<boolean> => {
      const signature = headers.get(header);
      return (
        key !== undefined &&
        signature !== null &&
        timingSafeEqual(signature, toBase64(await hmac("SHA-256", key, data)))
      );
    };
    if (
      !(
        (await matches("box-signature-primary", secret)) ||
        (await matches("box-signature-secondary", secondarySecret))
      )
    ) {
      throw unauthorized("Box signature does not match");
    }
  },
};
