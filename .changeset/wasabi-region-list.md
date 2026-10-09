---
"files-sdk": patch
---

List every current Wasabi region in the `region` option's documentation for the Wasabi adapter (`files-sdk/wasabi`). The list was missing `us-west-2` (San Jose), `eu-west-3` (United Kingdom), and `eu-south-1` (Milan). The adapter already built the right endpoint for them, since every Wasabi region uses `https://s3.<region>.wasabisys.com`; only the editor hint was out of date.
