---
"files-sdk": patch
---

Replace the zip plugin's hand-rolled ZIP record assembly with fflate's streaming writer. Local headers, data descriptors, the central directory, DOS timestamps, and write-side CRC accounting now come from fflate; archives still stream entry by entry with flat memory. Extraction is unchanged and stays hand-rolled on purpose — fflate's unzip does not verify CRC-32 or reject encrypted entries, and the plugin promises fail-closed extraction. Only visible wire change: the UTF-8 name flag is now set per entry (only when the name needs it) instead of always.
