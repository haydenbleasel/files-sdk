// CSRF/origin defense for the state-changing actions. Opt-in: when no
// `allowedOrigins` is configured the check passes (the gateway leans on the
// `authorize` hook + cookies-only-inside-`authorize` posture). When configured,
// a same-origin request with no `Origin` header is allowed (browsers omit it for
// top-level same-origin navigations); a present `Origin` must match.

export type AllowedOrigins = string[] | ((origin: string) => boolean);

export const isOriginAllowed = (
  origin: string | null,
  allowed: AllowedOrigins | undefined
): boolean => {
  if (!allowed) {
    return true;
  }
  if (origin === null || origin === "") {
    return true;
  }
  if (typeof allowed === "function") {
    return allowed(origin);
  }
  return allowed.includes(origin);
};
