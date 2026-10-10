// Virtual-key ↔ remote-path translation for the network-filesystem adapters
// (FTP, SFTP). These protocols expose a real directory tree, so a key that
// resolves outside the configured root (e.g. `../../etc/passwd`) is a genuine
// exfiltration vector — the remote analog of the traversal guard in
// `src/fs/index.ts`'s `resolveKeyPath`. Unlike the host filesystem, there's no
// `path.resolve` to lean on, so we normalize the virtual key by hand and
// reject `..` segments outright rather than trying to collapse them.

import { FilesError } from "./errors.js";

/**
 * Suffix of the staging file an in-progress resumable upload appends to before
 * it is renamed over the target key (the fs adapter reserves the same one).
 * `list()` hides staging files, and writes refuse keys that would land on one,
 * so a paused or crashed upload never surfaces as a truncated object.
 */
export const RESUMABLE_STAGING_SUFFIX = ".fls-part";

/**
 * Whether a remote name or path is a resumable-upload staging file. Folded to
 * lower case because FTP/SFTP servers on Windows hosts match names
 * case-insensitively.
 */
export const isStagingPath = (path: string): boolean =>
  path.toLowerCase().endsWith(RESUMABLE_STAGING_SUFFIX);

/**
 * Throw `Invalid` when a write would land on a resumable-upload staging path.
 * Reads and deletes of such a path stay allowed, so a stray staging file can
 * still be inspected or cleaned up.
 */
export const assertNotStagingPath = (
  adapter: string,
  remote: string,
  key: string
): void => {
  if (isStagingPath(remote)) {
    throw new FilesError(
      "Invalid",
      `${adapter}: keys ending in ${RESUMABLE_STAGING_SUFFIX} are reserved for in-progress resumable uploads: ${JSON.stringify(key)}`
    );
  }
};

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

// A Windows drive designator: `C:` alone is the drive's root once joined to an
// empty root (`C:/Windows/win.ini`), and `C:name` is relative to that drive's
// current directory. Either way the path leaves the adapter root.
const DRIVE_LETTER = /^[A-Za-z]:/u;

/**
 * Split a virtual key into clean path segments. Drops empty and `.` segments,
 * and throws `Invalid` on a `..` segment or an embedded null byte — those are
 * the shapes that would let a key escape the adapter root or break the
 * underlying protocol command — and on a key with no segment left (`"/"`,
 * `"."`, `"./"`), which would address the root directory itself rather than
 * an object under it. Pure string math: no host filesystem is touched.
 *
 * Servers on Windows hosts (OpenSSH, IIS FTP and WebDAV) also treat `\` as a
 * separator and a leading drive letter as an absolute path, so a key with a
 * backslash (`..\..\x` would slip past the `..` check as one segment) or one
 * whose first segment starts with a drive letter is refused too.
 */
const normalizeKeySegments = (key: string): string[] => {
  if (key.includes("\0")) {
    throw new FilesError(
      "Invalid",
      `key must not contain null bytes: ${JSON.stringify(key)}`
    );
  }
  if (key.includes("\\")) {
    throw new FilesError(
      "Invalid",
      `key must not contain backslashes: ${JSON.stringify(key)}`
    );
  }
  const segments: string[] = [];
  for (const segment of key.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new FilesError(
        "Invalid",
        `key escapes adapter root: ${JSON.stringify(key)}`
      );
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    // Mapping such a key onto the root is never an object operation — and on
    // WebDAV a DELETE (or MOVE) of the root collection takes everything under
    // it, recursively.
    throw new FilesError(
      "Invalid",
      `key must name an object below the adapter root: ${JSON.stringify(key)}`
    );
  }
  if (DRIVE_LETTER.test(segments[0] ?? "")) {
    throw new FilesError(
      "Invalid",
      `key must not start with a drive letter: ${JSON.stringify(key)}`
    );
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
