---
"files-sdk": minor
---

Add a `prefix` option to the `Files` constructor. When set, every key is resolved relative to the prefix - reads, writes, copies, listings, URLs, and signed uploads - and the prefix is stripped back off the keys (and `name`) returned in results, so your application code works in its own namespace:

```ts
const users = new Files({
  adapter: s3({ bucket: "uploads" }),
  prefix: "users",
});

await users.upload("123/avatar.png", file); // writes users/123/avatar.png
const stored = await users.head("123/avatar.png");
stored.key; // "123/avatar.png" - prefix stripped
```

Leading and trailing slashes on the prefix are normalized (`"/users/"` and `"users"` behave identically), and `list()` scopes the underlying query on a path boundary so a `prefix: "users"` instance never matches the sibling `users-archive/`.
