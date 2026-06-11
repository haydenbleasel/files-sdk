---
"files-sdk": minor
---

Add a `neon` adapter at `files-sdk/neon` for [Neon](https://neon.com) branchable object storage over its S3-compatible API. A thin wrapper around the S3 adapter — errors relabelled, with path-style addressing on by default because Neon requires it (the wildcard TLS cert covers a single subdomain level, occupied by the branch id, so the bucket name travels in the request path). It reads the standard `AWS_*` variables that `neon dev` / `neon env pull` inject for the linked branch — `endpoint` from `AWS_ENDPOINT_URL_S3`, region from `AWS_REGION` (then `NEON_STORAGE_REGION`, then `us-east-1`), and credentials through the AWS SDK chain (`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`) — so inside a Neon Function or after an env pull it works from env alone: `neon({ bucket: "images" })`. Catalogued in `files-sdk/providers` and exposed through the CLI.
