---
"files-sdk": patch
---

The `files-sdk/vultr` `region` docs and missing-region error now use Vultr's real cluster codes (`ewr1`, `sjc1`, `ams1`, `blr1`, `del1`, `sgp1`). The old examples (`ewr`, `sjc`, `ams`, …) produced hosts like `ewr.vultrobjects.com` that don't exist, and `lux` isn't a Vultr cluster.
