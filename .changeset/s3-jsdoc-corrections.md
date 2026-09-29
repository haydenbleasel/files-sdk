---
"files-sdk": patch
---

Doc-comment and message fixes in `files-sdk/s3`. The `publicBaseUrl` JSDoc now says keys are URL-encoded per segment (it wrongly said they were embedded literally), the `mapS3Error` and internal `defaultProviderMessage` notes describe how the S3-compatible wrappers actually relabel errors, and the missing-`@aws-sdk/lib-storage` error now says it's also needed for `multipart` and for `ReadableStream` bodies of unknown length, not only `onProgress`.
