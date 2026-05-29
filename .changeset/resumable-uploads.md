---
"files-sdk": minor
---

`upload` now accepts a `control` option for **pause-able and resumable uploads**. Construct an `UploadControl`, pass it in, and pause, resume, or abort the upload — or persist `control.toJSON()` and resume it later (even in a new process or after a page reload) with `UploadControl.from(token)`.

```ts
import { Files, UploadControl } from "files-sdk";

const control = new UploadControl();
const promise = files.upload("big.iso", file, {
  control,
  multipart: { partSize: 16 * 1024 * 1024 },
  onProgress: ({ loaded, total }) => bar.set(loaded, total),
});

control.pause(); // in-flight parts settle, the promise stays pending
save(control.toJSON()); // serializable session token — persist anywhere
control.resume(); // continue

// …or, after a crash / reload, in a new process:
const result = await files.upload("big.iso", file, {
  control: UploadControl.from(load()),
});
```
