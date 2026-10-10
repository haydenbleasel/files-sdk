// A header value can't carry control characters: CR/LF in a disposition that
// rides into a signed URL's `response-content-disposition` would ask storage
// to split the response headers. HTAB is the one control a header may hold.
const hasControlCharacter = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return true;
    }
  }
  return false;
};

// The disposition type is exactly the token `attachment`, then either the end
// of the value or the `;` that opens its parameters. A word boundary alone
// would also accept `attachment, inline`, `attachment inline`, or
// `attachment/x`, which browsers don't parse as an attachment: Chromium
// renders those inline.
const ATTACHMENT_TYPE = /^\s*attachment\s*(?:;|$)/iu;

export const isAttachmentDisposition = (value?: string): value is string =>
  value !== undefined &&
  ATTACHMENT_TYPE.test(value) &&
  !hasControlCharacter(value);

// RFC 8187 `attr-char`s beyond what `encodeURIComponent` already escapes:
// it leaves `'`, `(`, `)`, and `*` bare, which an ext-value may not carry.
const encodeExtValue = (value: string): string =>
  encodeURIComponent(value).replaceAll(
    /['()*]/gu,
    (char) => `%${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()}`
  );

// Printable ASCII, space through `~`.
const isPlainAscii = (char: string): boolean => {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x20 && code < 0x7f;
};

/**
 * `attachment` naming the file the browser should save, per RFC 6266: an ASCII
 * `filename` fallback (non-ASCII replaced by `_`, `"` and `\` escaped) plus a
 * UTF-8 `filename*` when the name isn't plain ASCII. Control characters are
 * replaced first, so the result is always a valid header value. An empty name
 * gives a bare `attachment`.
 */
export const attachmentDisposition = (filename: string): string => {
  const name = [...filename]
    .map((char) => (hasControlCharacter(char) ? "_" : char))
    .join("");
  if (name === "") {
    return "attachment";
  }
  const fallback = [...name]
    .map((char) => (isPlainAscii(char) ? char : "_"))
    .join("")
    .replaceAll(/["\\]/gu, (char) => `\\${char}`);
  const ascii = [...name].every(isPlainAscii);
  return ascii
    ? `attachment; filename="${fallback}"`
    : `attachment; filename="${fallback}"; filename*=UTF-8''${encodeExtValue(name)}`;
};
