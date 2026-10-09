---
"files-sdk": patch
---

A plugin's `extend` surface can no longer replace a symbol-keyed `Files` member. The collision check only walked string keys, but `Object.assign` copies symbol keys as well, so an extension keyed by the internal event-folding symbol silently replaced that method and broke `prefix` scoping for `files-sdk/events` (one tenant's instance would deliver another tenant's events). Symbol keys are now checked like named ones: a symbol that collides with an existing member, or with another plugin's extension, throws `Invalid` at construction.
