---
"files-sdk": patch
---

FTP resumable uploads (`multipart: true` or an `UploadControl`) now create the destination's parent directory before the first chunk, matching plain `upload()` and `move()`. Previously `upload("videos/clip.mp4", body, { multipart: true })` with no `videos/` directory failed on the first `APPE` with a 550 that surfaced as `NotFound`.
