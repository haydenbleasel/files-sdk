// Extension → MIME inference for adapters whose backing protocol stores no
// content type (Dropbox files, the FTP/SFTP filesystems). Approximate by
// extension on the way out so callers don't get `application/octet-stream`
// for everything. Kept deliberately small — this is a best-effort label, not
// a full media-type database; unknown extensions fall back to octet-stream.

export const TYPE_BY_EXT: Readonly<Record<string, string>> = {
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  gif: "image/gif",
  htm: "text/html; charset=utf-8",
  html: "text/html; charset=utf-8",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript; charset=utf-8",
  json: "application/json",
  mjs: "text/javascript; charset=utf-8",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  webp: "image/webp",
  xml: "application/xml",
  zip: "application/zip",
};

export const inferTypeFromName = (name: string): string => {
  const idx = name.lastIndexOf(".");
  if (idx === -1) {
    return "application/octet-stream";
  }
  const ext = name.slice(idx + 1).toLowerCase();
  return TYPE_BY_EXT[ext] ?? "application/octet-stream";
};
