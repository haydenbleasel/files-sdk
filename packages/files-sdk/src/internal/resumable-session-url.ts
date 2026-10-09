import { FilesError } from "./errors.js";

const parseSessionUrl = (value: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new FilesError("Invalid", `${label} must be an absolute URL`, error);
  }
  if (url.username || url.password) {
    throw new FilesError("Invalid", `${label} must not include credentials`);
  }
  return url;
};

const isHostOrSubdomain = (hostname: string, parent: string): boolean =>
  hostname === parent || hostname.endsWith(`.${parent}`);

export const trustedHttpsSessionUrl = (
  value: string,
  label: string,
  trustedHosts: readonly string[]
): string => {
  const url = parseSessionUrl(value, label);
  if (url.protocol !== "https:") {
    throw new FilesError("Invalid", `${label} must use HTTPS`);
  }
  if (!trustedHosts.some((host) => isHostOrSubdomain(url.hostname, host))) {
    throw new FilesError(
      "Invalid",
      `${label} host is not trusted for resumable uploads`
    );
  }
  return url.href;
};

export const sameOriginSessionUrl = (
  value: string,
  base: string,
  label: string
): string => {
  const baseUrl = parseSessionUrl(base, `${label} base`);
  const url = new URL(value, baseUrl);
  if (url.username || url.password) {
    throw new FilesError("Invalid", `${label} must not include credentials`);
  }
  if (url.origin !== baseUrl.origin) {
    throw new FilesError(
      "Invalid",
      `${label} origin does not match the configured resumable endpoint`
    );
  }
  if (!url.pathname.startsWith(baseUrl.pathname)) {
    throw new FilesError(
      "Invalid",
      `${label} path is outside the configured resumable endpoint`
    );
  }
  return url.href;
};
