---
kind: external_dependency
name: Twilio as the WhatsApp provider for inbound voice/text events
slug: twilio-whatsapp
category: external_dependency
category_hints:
    - vendor_identity
    - framework_behavior
scope:
    - '**'
---

### Twilio WhatsApp
- Role: Pluggable WhatsApp provider behind the `WhatsAppAdapter` port; handles webhook ingestion, signature verification, event parsing, and media download.
- Framework behavior: Twilio posts `application/x-www-form-urlencoded` bodies and authenticates via an HMAC-SHA1 signature over the full URL plus sorted form parameters (`X-Twilio-Signature`), NOT over the raw body. Voice notes arrive as `MediaUrl0` and must be downloaded with HTTP Basic auth using `accountSid:authToken`.
- Provider error mapping distinguishes transient failures (429, 5xx) from permanent ones for retry policy.
- Verify exact webhook payload fields and signature computation against the Twilio docs.