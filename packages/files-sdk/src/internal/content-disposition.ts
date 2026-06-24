export const isAttachmentDisposition = (
  value: string | undefined
): value is string => value !== undefined && /^\s*attachment\b/iu.test(value);
