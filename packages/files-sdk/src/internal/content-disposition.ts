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

export const isAttachmentDisposition = (
  value: string | undefined
): value is string =>
  value !== undefined &&
  /^\s*attachment\b/iu.test(value) &&
  !hasControlCharacter(value);
