---
"files-sdk": minor
---

Add DigitalOcean Spaces adapter (`files-sdk/digitalocean-spaces`). Thin wrapper over the S3 adapter with Spaces defaults: endpoint derived from `region` (`https://${region}.digitaloceanspaces.com`), virtual-hosted addressing, `"Spaces error"` provider label, and `DO_SPACES_KEY` / `DO_SPACES_SECRET` env-var fallbacks. `publicBaseUrl` accepts a Spaces CDN host (`https://${bucket}.${region}.cdn.digitaloceanspaces.com`) or a custom CNAME.
