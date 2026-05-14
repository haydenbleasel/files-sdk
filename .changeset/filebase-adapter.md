---
"files-sdk": minor
---

Add Filebase adapter at `files-sdk/filebase`, a thin S3 wrapper around Filebase's S3-compatible gateway in front of decentralized storage networks (IPFS, Sia, Storj — the backing network is chosen per-bucket in the dashboard). Uses the fixed `https://s3.filebase.com` endpoint with virtual-hosted-style addressing, defaults the SigV4 region to `"us-east-1"`, and auto-loads credentials from `FILEBASE_ACCESS_KEY_ID` / `FILEBASE_SECRET_ACCESS_KEY`. `publicBaseUrl` accepts an IPFS/Sia/Storj gateway prefix for skipping signing on public objects. Errors are relabelled as `Filebase error`.
