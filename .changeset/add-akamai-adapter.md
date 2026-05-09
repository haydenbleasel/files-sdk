---
"files-sdk": minor
---

Add Akamai Cloud Object Storage adapter (`files-sdk/akamai`), formerly Linode Object Storage. Thin wrapper over the S3 adapter with Akamai defaults: endpoint derived from the `region` cluster code (`us-iad-1`, `nl-ams-1`, `fr-par-1`, the older `us-east-1`/`eu-central-1`/`ap-south-1` clusters, etc.) as `https://<region>.linodeobjects.com` and overridable, virtual-hosted-style addressing, `"Akamai error"` provider label, and `AKAMAI_ACCESS_KEY_ID` / `AKAMAI_SECRET_ACCESS_KEY` env-var fallbacks. `publicBaseUrl` accepts a public-bucket origin (`https://<bucket>.<region>.linodeobjects.com`) or a custom CNAME for unsigned URLs; otherwise `url()` returns a presigned GetObject (1-hour default).
