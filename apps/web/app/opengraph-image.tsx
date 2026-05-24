import { OG_CONTENT_TYPE, OG_SIZE, renderOgImage } from "@/lib/og/og-image";

export const alt = "Files SDK — write once, store anywhere";
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;

const Image = () =>
  renderOgImage({
    description:
      "A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client.",
    title: "Write once. Store anywhere.",
  });

export default Image;
