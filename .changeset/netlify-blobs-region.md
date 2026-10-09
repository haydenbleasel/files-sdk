---
"files-sdk": minor
---

Add a `region` option to the Netlify Blobs adapter (`files-sdk/netlify-blobs`). Site-wide stores don't read a region from the environment, so until now they always used the Netlify API's default region rather than the site's Functions region. Pass `region: "eu-central-1"` (or any region `@netlify/blobs` supports) to keep a store's data next to the functions that read it. Deploy-scoped stores keep defaulting to the deploy's region, and changing `region` later doesn't move data a store already holds. No peer range change: every supported `@netlify/blobs` version forwards the option.
