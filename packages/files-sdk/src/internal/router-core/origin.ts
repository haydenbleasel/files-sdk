// CSRF/origin defense for state-changing actions. A same-origin request with no
// `Origin` header is allowed (browsers omit it for top-level same-origin
// navigations). When `Origin` is present and no explicit allowlist is
// configured, it must match the request URL's origin. When configured, the
// explicit allowlist/predicate wins.

export type AllowedOrigins = string[] | ((origin: string) => boolean);

export const isOriginAllowed = (
  origin: string | null,
  allowed: AllowedOrigins | undefined,
  requestOrigin: string
): boolean => {
  if (origin === null || origin === "") {
    return true;
  }
  if (!allowed) {
    return origin === requestOrigin;
  }
  if (typeof allowed === "function") {
    return allowed(origin);
  }
  return allowed.includes(origin);
};
