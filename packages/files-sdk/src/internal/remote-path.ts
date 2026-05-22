// Virtual-key ↔ remote-path translation for the network-filesystem adapters
// (FTP, SFTP). These protocols expose a real directory tree, so a key that
// resolves outside the configured root (e.g. `../../etc/passwd`) is a genuine
// exfiltration vector — the remote analog of the traversal guard in
// `src/fs/index.ts`'s `resolveKeyPath`. Unlike the host filesystem, there's no
// `path.resolve` to lean on, so we normalize the virtual key by hand and
// reject `..` segments outright rather than trying to collapse them.

import { FilesError } from "./errors.js";

/**
 * Strip leading and trailing slashes. `"/uploads/"`, `"uploads/"`, and
 * `"uploads"` all collapse to `"uploads"`; `"/"` collapses to `""`.
 */
export const trimSlashes = (s: string): string => {
  let start = 0;
  let end = s.length;
  while (start < end && s[start] === "/") {
    start += 1;
  }
  while (end > start && s[end - 1] === "/") {
    end -= 1;
  }
  return start === 0 && end === s.length ? s : s.slice(start, end);
};

/**
 * Split a virtual key into clean path segments. Drops empty and `.` segments,
 * and throws `Provider` on a `..` segment or an embedded null byte — those are
 * the shapes that would let a key escape the adapter root or break the
 * underlying protocol command. Pure string math: no host filesystem is touched.
 */
const normalizeKeySegments = (key: string): string[] => {
  if (key.includes("\0")) {
    throw new FilesError(
      "Provider",
      `key must not contain null bytes: ${JSON.stringify(key)}`
    );
  }
  const segments: string[] = [];
  for (const segment of key.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new FilesError(
        "Provider",
        `key escapes adapter root: ${JSON.stringify(key)}`
      );
    }
    segments.push(segment);
  }
  return segments;
};

/**
 * Join a configured remote `root` with a virtual `key`, returning the path the
 * adapter hands to its client. The traversal guard runs on `key` here, so
 * every method that maps a key to a path gets the check for free.
 *
 * `root` shape is preserved: an absolute root (`/uploads`) yields an absolute
 * path, an empty/`"."` root yields a path relative to the connection's login
 * directory (the common SFTP chroot/home case), and a relative root prefixes
 * verbatim.
 */
export const joinRemotePath = (root: string, key: string): string => {
  const absolute = root.startsWith("/");
  const rootInner = trimSlashes(root === "." ? "" : root);
  const inner = normalizeKeySegments(key).join("/");
  if (!rootInner) {
    return absolute ? `/${inner}` : inner;
  }
  return `${absolute ? "/" : ""}${rootInner}/${inner}`;
};
