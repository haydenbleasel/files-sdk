// Strict Content-Type parsing for checks that gate what a browser will render.
// Kept apart from `mime.ts` so the gateway and the plugins that import it don't
// pull the `mime` lookup table into their module graph.

// RFC 9110 `token` characters, the only ones a media type's type or subtype
// may use.
const MEDIA_TYPE_TOKEN = /^[\w!#$%&'*+.^`|~-]+$/u;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index) ?? 0;
    // Horizontal tab is legal optional whitespace in a header value.
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      return true;
    }
  }
  return false;
};

/**
 * The lowercased `type/subtype` essence of a Content-Type value, or `undefined`
 * when the value isn't exactly one well-formed media type. A comma is refused
 * outright: browsers resolve a comma-separated list to its *last* entry, so
 * `image/png, text/html` renders as HTML while a check that reads up to the
 * first `;` sees an image. Control characters are refused for the same reason
 * a header would be.
 */
export const mediaTypeEssence = (value: string): string | undefined => {
  if (value.includes(",") || hasControlCharacter(value)) {
    return undefined;
  }
  const semicolon = value.indexOf(";");
  const essence = (semicolon === -1 ? value : value.slice(0, semicolon)).trim();
  const slash = essence.indexOf("/");
  if (slash === -1) {
    return undefined;
  }
  const type = essence.slice(0, slash);
  const subtype = essence.slice(slash + 1);
  if (!MEDIA_TYPE_TOKEN.test(type) || !MEDIA_TYPE_TOKEN.test(subtype)) {
    return undefined;
  }
  return essence.toLowerCase();
};
