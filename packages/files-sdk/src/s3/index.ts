import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { S3Adapter, S3AdapterOptions, S3Sdk } from "./core.js";
import { createS3Adapter } from "./core.js";

// This entry is the *static* wiring of the SDK-parameterized engine in
// core.ts: its consumers install the `@aws-sdk/*` peers anyway, so plain
// named imports (tree-shakeable) are right here. The r2 adapter instead
// fills the same `S3Sdk` bundle from dynamic imports — see `lazyS3` in
// ../r2/index.ts and the rationale on `S3Sdk`.
const sdk: S3Sdk = {
  clientS3: {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListPartsCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand,
  },
  presignedPost: { createPresignedPost },
  requestPresigner: { getSignedUrl },
};

export const s3 = (opts: S3AdapterOptions): S3Adapter =>
  createS3Adapter(sdk, opts);

export { mapS3Error } from "./core.js";
export type { S3Adapter, S3AdapterOptions, S3Sdk } from "./core.js";
