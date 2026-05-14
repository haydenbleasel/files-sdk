---
"files-sdk": minor
---

Add Oracle Cloud Infrastructure Object Storage adapter at `files-sdk/oracle-cloud`, a thin S3 wrapper around OCI's S3 compatibility layer. Requires both the tenancy `namespace` and a `region` to derive the endpoint (`<namespace>.compat.objectstorage.<region>.oraclecloud.com`); defaults to path-style addressing since OCI's wildcard TLS cert doesn't cover bucket subdomains under the namespace-prefixed host. Auth uses OCI's HMAC _Customer Secret Keys_ (distinct from regular API signing keys); credentials auto-load from `OCI_ACCESS_KEY_ID` / `OCI_SECRET_ACCESS_KEY`. Errors are relabelled as `Oracle Cloud error`.
