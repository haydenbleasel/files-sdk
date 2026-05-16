---
"files-sdk": minor
---

Add Yandex Object Storage adapter (`files-sdk/yandex`). Thin wrapper around the S3 adapter — fixed global endpoint (`storage.yandexcloud.net`), region defaults to `ru-central1` for signing, virtual-hosted-style addressing, errors relabelled as "Yandex Cloud error". Auto-loads from `YANDEX_ACCESS_KEY_ID` and `YANDEX_SECRET_ACCESS_KEY`.
