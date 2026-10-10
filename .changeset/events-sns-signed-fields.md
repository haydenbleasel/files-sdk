---
"files-sdk": patch
---

`files-sdk/events`: a webhook with `verify: { sns }` now parses only the fields of an SNS message that its signature covers. Before, the raw body was parsed after verification, so unsigned `EventSource`/`Sns` fields added beside a genuine signed message could feed forged S3 events (a delete, say) to your handlers. The `s3` format also refuses a body that is both an SNS notification and a Lambda SNS record.
