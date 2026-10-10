---
"files-sdk": patch
---

`files-sdk/events` no longer reports a `deleted` event when only one version of an object was removed, since the key may still have a live version. That covers S3 `ObjectRemoved:Delete` and `LifecycleExpiration:Delete` carrying a version id (including `NoncurrentVersionExpiration` cleanups) and EventBridge `Permanently Deleted` events with a `version-id`, Backblaze B2 `b2:ObjectDeleted:*`, and GCS `OBJECT_DELETE` / Eventarc `deleted` events whose payload shows the generation was already noncurrent (`timeDeleted` more than a minute before the event). Delete markers, B2 hide markers, GCS archives and unversioned deletes are still reported, so cleanup handlers no longer delete live data when a lifecycle rule prunes old versions.
