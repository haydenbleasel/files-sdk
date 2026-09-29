---
"files-sdk": patch
---

`files-sdk/sharepoint` now lets an explicit site or library option win over the `SHAREPOINT_*` env targets. `SHAREPOINT_DRIVE_ID` used to override an explicit `siteId`, `siteUrl`, `hostname`, `sitePath`, or `documentLibrary`. `SHAREPOINT_SITE_ID` overrode an explicit `siteUrl` or `hostname`, and `SHAREPOINT_SITE_URL` overrode an explicit `hostname`. In each case the adapter silently read and wrote a different site or library than the one passed. The env targets now apply only when no option names a site, and for the drive, no library either. An explicit `documentLibrary` still resolves against an env site, and `SHAREPOINT_HOSTNAME` still pairs with an explicit `sitePath`.
