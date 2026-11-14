---
"files-sdk": patch
---

The `files-sdk/api` gateway's `search` no longer pushes a glob's literal head down to the adapter as a list prefix when it isn't a safe prefix (`../other/*`, `/etc/*`). Joined to an `authorize` `keyPrefix`, such a head asked the adapter to list a path outside the caller's scope; the search now walks the caller's own prefix and matches nothing.
