import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

// Node declares its own `ReadableStream` in `node:stream/web` — the same
// platform class the DOM lib types as the global `ReadableStream`, but the two
// declarations disagree on a few members (Node adds `blob()`/`text()`/...), so
// TS considers them unrelated in both directions and rejects a direct
// assertion. Both agree on the async-iterable surface, so these two seams
// route the value through that shared surface: the value is one class
// throughout and the single assertion only picks the declaration. Every
// Node-side adapter converts through here instead of repeating the dance.

/** View a Node `Readable` as the web `ReadableStream` the SDK's `Body` speaks. */
export const toWebStream = (readable: Readable): ReadableStream<Uint8Array> => {
  const stream: AsyncIterable<Uint8Array> = Readable.toWeb(readable);
  // SAFETY: `Readable.toWeb` returns the platform `ReadableStream` (see
  // above); only its declared type differs.
  return stream as ReadableStream<Uint8Array>;
};

/** Wrap a web `ReadableStream` as a Node `Readable` so it can be piped. */
export const toNodeReadable = (web: ReadableStream<Uint8Array>): Readable => {
  const stream: AsyncIterable<Uint8Array> = web;
  // SAFETY: `stream` is the platform `ReadableStream` `Readable.fromWeb`
  // consumes (see above); only its declared type differs.
  return Readable.fromWeb(stream as NodeReadableStream<Uint8Array>);
};
