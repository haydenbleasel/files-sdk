---
"files-sdk": patch
---

`files-sdk/supabase` bulk deletes of more than 1000 keys now succeed. All keys went out in one request, which Supabase Storage refuses past 1000 objects, so every key was reported as failed. Keys are now deleted in batches of 1000, and a refused batch fails only its own keys.
