// Extension → MIME inference for adapters whose backing protocol stores no
// content type (Dropbox files, the FTP/SFTP filesystems). Approximate by
// extension on the way out so callers don't get `application/octet-stream`
// for everything. The lookup table is the `mime` package (~1000 types, zero
// deps); this wrapper keeps the SDK's conventions on top of it: text types
// carry an explicit UTF-8 charset, and anything unknown — including dotfiles
// and extension-less names — falls back to octet-stream rather than null.

import mime from "mime";

export const inferTypeFromName = (name: string): string => {
  // `mime` reads a root-level name with no dot as a bare extension (`"json"` →
  // `application/json`) and a root dotfile by its tail (`".html"` →
  // `text/html`), so only look it up when the last segment has an extension
  // after a non-leading dot — nested names already behave this way.
  const base = name.slice(name.lastIndexOf("/") + 1);
  const type = base.lastIndexOf(".") > 0 ? mime.getType(name) : null;
  if (!type) {
    return "application/octet-stream";
  }
  return type.startsWith("text/") ? `${type}; charset=utf-8` : type;
};
