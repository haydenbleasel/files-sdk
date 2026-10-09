---
"files-sdk": patch
---

Stop presigned PUT URLs from the S3 adapter (`files-sdk/s3`) carrying a checksum of an empty body. On canonical AWS (no `endpoint`), the AWS SDK's default `requestChecksumCalculation: "WHEN_SUPPORTED"` computed a CRC32 of the presign request's empty body and signed it into the URL as `x-amz-checksum-crc32=AAAAAA==` (with `x-amz-sdk-checksum-algorithm=CRC32`), so S3 checked every upload through the URL against that checksum and rejected any real file. `signedUploadUrl()` now presigns its PutObject without request checksum parameters, whatever the client's checksum setting or `AWS_REQUEST_CHECKSUM_CALCULATION`. Only the presign command changes: ordinary uploads through the client (and `files.raw`) keep the SDK's checksum behavior. The same fix reaches every S3-compatible adapter built on `s3()` and R2, MinIO, and RustFS on `client: "aws-sdk"`.
