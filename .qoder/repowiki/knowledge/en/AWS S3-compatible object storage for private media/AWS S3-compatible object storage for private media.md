---
kind: external_dependency
name: AWS S3-compatible object storage for private media
slug: aws-s3
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### AWS S3
- Role: One of two pluggable backends for private audio/transcript/media storage, selected through the `MediaStorageAdapter` port. The adapter also works with any S3-compatible endpoint (Cloudflare R2, MinIO) via configurable `endpoint`/`forcePathStyle`.
- Client constraint: objects are never given public URLs; reads go through the app's own HMAC-signed short-lived links so switching storage providers does not change the download contract.
- SDK usage: `@aws-sdk/client-s3` is imported lazily so non-S3 processes stay free of the dependency.
- Verify exact S3 API parameters against the official docs.