---
kind: external_dependency
name: Vercel platform hosting and scheduled jobs
slug: vercel
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### Vercel
- Role: Deployment target for the Next.js app; `vercel.json` defines a cron job at `/api/cron/jobs` running daily at 03:00 UTC.
- Platform constraint: Vercel-hosted functions receive a rotating OIDC token (`VERCEL_OIDC_TOKEN`) used by the Vercel Blob adapter for authenticated blob access without static secrets.
- Verify exact cron syntax and runtime constraints against the Vercel docs.