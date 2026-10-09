// Appwrite project webhooks for storage files. The body is the File document;
// what happened is in the `X-Appwrite-Webhook-Events` header
// (`buckets.<bucket>.files.<id>.create` / `.delete`), so a delivery must be
// parsed from the request, headers and all. The key is the file's `$id` —
// `files-sdk/appwrite` uses the key as the file id. Deliveries are signed:
// base64(HMAC-SHA1(signature key, webhook URL as configured + raw body)).

import { isString } from "../../internal/is.js";
import { hmac, timingSafeEqual, toBase64, utf8 } from "../crypto.js";
import type { Delivery, EventParser, RawEvent } from "./types.js";
import { malformed, toSize, toTime, unauthorized } from "./types.js";

const verbOf = (
  header: string,
  bucketId: string,
  fileId: string
): string | undefined => {
  const prefix = `buckets.${bucketId}.files.${fileId}.`;
  const match = header
    .split(",")
    .map((event) => event.trim())
    .find((event) => event.startsWith(prefix));
  return match?.slice(prefix.length);
};

const fromDelivery = ({ body, headers }: Delivery): RawEvent[] => {
  const events = headers?.get("x-appwrite-webhook-events");
  if (!events) {
    throw malformed(
      "appwrite",
      "missing X-Appwrite-Webhook-Events; pass the webhook Request, not just its body"
    );
  }
  const fileId = body.$id;
  const { bucketId } = body;
  if (!(isString(fileId) && isString(bucketId))) {
    // Not a file document: another resource's event (users, databases, …).
    return [];
  }
  const verb = verbOf(events, bucketId, fileId);
  if (verb !== "create" && verb !== "delete") {
    // `update` renames or re-permissions a file; its contents are immutable.
    return [];
  }
  const type = verb === "create" ? "created" : "deleted";
  const deliveryId = headers?.get("x-appwrite-webhook-delivery-id");
  const time =
    type === "created" ? toTime(body.$createdAt, Date.now()) : Date.now();
  const size = toSize(body.sizeOriginal);
  return [
    {
      bucket: bucketId,
      id: deliveryId || `${verb}:${fileId}:${String(body.$updatedAt)}`,
      key: fileId,
      raw: body,
      time,
      type,
      ...(type === "created" && size !== undefined && { size }),
      ...(isString(body.signature) && { etag: body.signature }),
      ...(isString(body.mimeType) && { contentType: body.mimeType }),
    },
  ];
};

export const appwriteParser: EventParser = {
  format: "appwrite",
  parse: (delivery) => fromDelivery(delivery),
  verifySignature: async ({ body, headers, secret, url }) => {
    const signature = headers.get("x-appwrite-webhook-signature");
    if (!signature) {
      throw unauthorized("missing X-Appwrite-Webhook-Signature");
    }
    const expected = toBase64(
      await hmac("SHA-1", secret, utf8(`${url ?? ""}${body}`))
    );
    if (!timingSafeEqual(signature, expected)) {
      throw unauthorized("Appwrite signature does not match");
    }
  },
};
