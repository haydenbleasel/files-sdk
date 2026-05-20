import pkg from "../../../packages/files-sdk/package.json";

export const getLatestVersion = (): string => pkg.version;
