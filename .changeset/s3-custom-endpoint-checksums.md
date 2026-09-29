---
"files-sdk": patch
---

`files-sdk/s3` with an explicit `endpoint` (and every S3-compatible wrapper built on it) now sets `requestChecksumCalculation` and `responseChecksumValidation` to `"WHEN_REQUIRED"`. `@aws-sdk/client-s3` 3.729 and later add an `x-amz-checksum-crc32` header to every `PutObject` and `UploadPart`, plus a checksum parameter to presigned PUT URLs, and some S3-compatible services reject it (Backblaze B2 reported "Unsupported header 'x-amz-checksum-crc32'"). Checksums are now sent only where an operation requires one; `DeleteObjects` still carries one because S3 requires it. The `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION` env vars still override, and canonical AWS keeps the SDK default.
