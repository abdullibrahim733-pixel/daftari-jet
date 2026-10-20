---
kind: external_dependency
name: Vercel Blob for private media on Vercel deployments
slug: vercel-blob
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### Vercel Blob
- Role: Alternative private-media backend selected when `DAFTARI_STORAGE_PROVIDER=blob`; used by default on Vercel alongside the Vercel cron job defined in `vercel.json`.
- Auth protocol: authenticates via OIDC — pairs the `BLOB_STORE_ID` environment variable with a short-lived `VERCEL_OIDC_TOKEN` issued and rotated by Vercel; no static secret is required.
- Objects are stored with `access: 'private'` and accessed through the same signed-link contract as the S3/local adapters.
- Verify exact Blob SDK methods against the official docs.