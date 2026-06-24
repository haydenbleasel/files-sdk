export const resolveFilesApiSecret = (): string | undefined => {
  const secret = process.env.FILES_API_SECRET;
  if (secret) {
    return secret;
  }
  if (process.env.NODE_ENV !== "production") {
    return undefined;
  }
  throw new Error("FILES_API_SECRET is required for files-sdk demo routes");
};
