import { describe, expect, test } from "bun:test";

import {
  attachmentDisposition,
  isAttachmentDisposition,
} from "../src/internal/content-disposition.js";

describe("isAttachmentDisposition", () => {
  test("accepts exactly the attachment type, bare or with parameters", () => {
    for (const value of [
      "attachment",
      "ATTACHMENT",
      "  attachment  ",
      'attachment; filename="a.pdf"',
      "attachment ;filename=a.pdf",
      "attachment;\tfilename=a.pdf",
    ]) {
      expect(isAttachmentDisposition(value)).toBe(true);
    }
  });

  test("refuses a type that only starts with the word attachment", () => {
    // Chromium renders each of these inline: the type isn't `attachment`.
    for (const value of [
      "attachment, inline",
      "attachment inline",
      "attachment/x",
      "attachment-x",
      "attachments",
      "inline",
      "inline; filename=attachment",
      "",
    ]) {
      expect(isAttachmentDisposition(value)).toBe(false);
    }
    expect(isAttachmentDisposition()).toBe(false);
  });

  test("refuses control characters, which would split a header", () => {
    expect(isAttachmentDisposition("attachment;\r\nx-evil: 1")).toBe(false);
    expect(isAttachmentDisposition("attachment;\u007F")).toBe(false);
  });
});

describe("attachmentDisposition", () => {
  test("an ASCII name is a quoted filename", () => {
    expect(attachmentDisposition("report final.pdf")).toBe(
      'attachment; filename="report final.pdf"'
    );
  });

  test("quotes and backslashes are escaped in the quoted string", () => {
    expect(attachmentDisposition('a "b" \\ c.txt')).toBe(
      'attachment; filename="a \\"b\\" \\\\ c.txt"'
    );
  });

  test("a non-ASCII name gets an ASCII fallback and a UTF-8 filename*", () => {
    expect(attachmentDisposition("résumé (1)*'.pdf")).toBe(
      "attachment; filename=\"r_sum_ (1)*'.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29%2A%27.pdf"
    );
  });

  test("control characters are replaced, and an empty name is bare", () => {
    expect(attachmentDisposition("a\r\nb.txt")).toBe(
      'attachment; filename="a__b.txt"'
    );
    expect(attachmentDisposition("")).toBe("attachment");
  });
});
