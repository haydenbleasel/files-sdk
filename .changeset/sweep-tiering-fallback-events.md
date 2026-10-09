---
"files-sdk": patch
---

`files-sdk/tiering` with `fallback: true` now reports `capabilities.events` as `false`. Its `event` hook refuses provider events in that mode (a hot-tier delete may be a move to cold), but the capability still advertised the hot adapter's format, so `files-sdk/events` accepted the setup and `parse()` / `dispatch()` threw on the first delivery. Use gateway or `events({ sdk: true })` events with a discoverable tiering setup.
