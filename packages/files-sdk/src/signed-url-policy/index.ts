import { handlers } from "../index.js";
import type { FilesPlugin, SignUploadOptions, UrlOptions } from "../index.js";
import { isAttachmentDisposition } from "../internal/content-disposition.js";

/** The disposition forced onto `url()` when none is configured. */
const DEFAULT_DISPOSITION = "attachment";

export interface SignedUrlPolicyOptions {
  /**
   * The `Content-Disposition` enforced on every `url()`. Defaults to
   * `"attachment"` — the safe default that makes a browser **download**
   * user-uploaded content instead of rendering it inline at your bucket's
   * origin, closing the stored-XSS hole the `url()` docs warn about (a
   * malicious `.html` or script-bearing SVG executing in your domain's trust
   * context).
   *
   * The policy only fills in or overrides an **unsafe** disposition: a call
   * that already asks for an `attachment` is left untouched, so a caller's
   * `'attachment; filename="report.pdf"'` keeps its filename. A call asking for
   * `inline` (or none) is forced to this value.
   *
   * Pass a full `'attachment; filename="..."'` string to set a default
   * filename, or `false` to disable the disposition guard entirely (you keep
   * only the expiry cap, and lose the XSS protection).
   */
  disposition?: string | false;
  /**
   * Cap the lifetime of both `url()` and `signedUploadUrl()` at this many
   * seconds. A request for a longer TTL is clamped down to the cap; a shorter
   * one is left as-is. To guarantee the ceiling, a `url()` with **no**
   * `expiresIn` is pinned to the cap rather than left to the adapter's own
   * default — so set this to the real ceiling you want, not higher.
   *
   * Omit to leave expiry uncapped.
   */
  maxExpiresIn?: number;
  /**
   * Require every `signedUploadUrl()` to carry a server-enforced size limit,
   * capped at this many bytes. A request with no `maxSize` is filled in with
   * this value; a request above it is clamped down — so a size limit is
   * **always present**. This closes the "anyone with the URL can upload an
   * arbitrarily large file" hole the `signedUploadUrl()` docs warn about.
   *
   * Adapters whose direct-upload primitive can't enforce a size limit already
   * **fail closed** (they throw rather than mint an unbounded URL), so a policy
   * that injects `maxSize` turns those into a hard error instead of a silent
   * gap — exactly what you want. Omit to leave upload size unconstrained.
   */
  maxUploadSize?: number;
}

/**
 * Clamp `requested` to `cap`, treating an absent request as the cap itself so
 * the ceiling is guaranteed rather than left to an adapter's own default.
 */
const clampToCap = (requested: number | undefined, cap: number): number =>
  requested === undefined ? cap : Math.min(requested, cap);

/**
 * A fail-safe guard that enforces safe defaults on the two URL-minting
 * operations — `url()` and `signedUploadUrl()` — turning the security caveats
 * those methods document into the default. It rewrites the request's options
 * before the adapter signs; it never throws of its own accord and never touches
 * the body, so reads, writes, and every other verb pass straight through.
 *
 * On `url()` it forces a download disposition (default `"attachment"`) so
 * user-uploaded HTML or script-bearing SVGs can't execute inline at your
 * origin, and clamps `expiresIn` to {@link SignedUrlPolicyOptions.maxExpiresIn}.
 * A call that already asks for an `attachment` keeps its disposition (and any
 * `filename`); only a missing or `inline` disposition is overridden.
 *
 * On `signedUploadUrl()` it clamps `expiresIn` to the same cap and, when
 * {@link SignedUrlPolicyOptions.maxUploadSize} is set, guarantees a
 * server-enforced `maxSize` is always present (injected when absent, clamped
 * when over). Because adapters that can't bind a size limit into a signed
 * upload already fail closed, a size policy turns an unenforceable provider
 * into a loud error rather than a silent hole.
 *
 * It writes **no metadata** and transforms **nothing on disk**, so a bucket
 * behind this policy is indistinguishable from one without it — safe to enable
 * or remove at any time. With no options set it still applies the headline
 * default: `url()` forces `attachment`.
 *
 * Place it **first** (outermost) so it sees the caller's original `url()` /
 * `signedUploadUrl()` request before anything downstream, and so its options
 * reach the adapter that actually signs.
 *
 * @param options `disposition`, `maxExpiresIn`, and/or `maxUploadSize` — any
 *   combination; `disposition` defaults to `"attachment"`.
 * @example
 * ```ts
 * import { createFiles } from "files-sdk";
 * import { s3 } from "files-sdk/s3";
 * import { signedUrlPolicy } from "files-sdk/signed-url-policy";
 *
 * const files = createFiles({
 *   adapter: s3({ bucket: "uploads" }),
 *   plugins: [
 *     signedUrlPolicy({
 *       maxExpiresIn: 15 * 60, // no URL lives longer than 15 minutes
 *       maxUploadSize: 10 * 1024 * 1024, // every signed upload caps at 10 MiB
 *     }),
 *   ],
 * });
 *
 * await files.url("user-upload.html"); // → forced `attachment`, ≤ 15 min
 * await files.signedUploadUrl("avatar.png", { expiresIn: 3600 }); // → ≤ 15 min, ≤ 10 MiB
 * ```
 */
export const signedUrlPolicy = (
  options: SignedUrlPolicyOptions = {}
): FilesPlugin => {
  const { maxExpiresIn, maxUploadSize } = options;
  const disposition = options.disposition ?? DEFAULT_DISPOSITION;

  return {
    name: "signed-url-policy",
    wrap: handlers({
      signedUploadUrl: (op, next) => {
        const opts = { ...op.options } as SignUploadOptions;
        if (maxExpiresIn !== undefined && typeof opts.expiresIn === "number") {
          opts.expiresIn = Math.min(opts.expiresIn, maxExpiresIn);
        }
        if (maxUploadSize !== undefined) {
          opts.maxSize = clampToCap(opts.maxSize, maxUploadSize);
        }
        return next({ ...op, options: opts });
      },
      url: (op, next) => {
        const opts: UrlOptions = { ...op.options };
        if (
          disposition !== false &&
          !isAttachmentDisposition(opts.responseContentDisposition)
        ) {
          opts.responseContentDisposition = disposition;
        }
        if (maxExpiresIn !== undefined) {
          opts.expiresIn = clampToCap(opts.expiresIn, maxExpiresIn);
        }
        return next({ ...op, options: opts });
      },
    }),
  };
};
