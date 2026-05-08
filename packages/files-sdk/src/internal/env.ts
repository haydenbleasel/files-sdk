// Safely read a `process.env` variable in environments where `process` may
// not exist at all — notably Cloudflare Workers without the `nodejs_compat`
// flag, where reading `process.env.X` throws `ReferenceError: process is
// not defined`. Adapters use this for env-var fallbacks so users on those
// runtimes can still construct adapters by passing values explicitly.
export const readEnv = (key: string): string | undefined => {
  if (typeof process === "undefined") {
    return;
  }
  // `process` exists but `process.env` may still be missing (some sandboxes
  // synthesize a minimal `process` shim with no `env`).
  const { env } = process as { env?: Record<string, string | undefined> };
  return env?.[key];
};
