---
"files-sdk": minor
---

Add Exoscale Object Storage (SOS) adapter at `files-sdk/exoscale`, a thin S3 wrapper that derives the endpoint from the zone code (`sos-<region>.exo.io` — `ch-gva-2`, `ch-dk-2`, `de-fra-1`, `de-muc-1`, `at-vie-1`, `at-vie-2`, `bg-sof-1`), defaults to virtual-hosted-style addressing, and auto-loads credentials from `EXOSCALE_API_KEY` / `EXOSCALE_API_SECRET`. Exoscale calls these zones but they fill the SigV4 region slot. Errors are relabelled as `Exoscale error`.
