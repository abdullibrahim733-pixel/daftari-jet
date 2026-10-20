---
kind: external_dependency
name: OpenAI for speech transcription and structured extraction
slug: openai
category: external_dependency
category_hints:
    - vendor_identity
    - sdk_real_api
scope:
    - '**'
---

### OpenAI
- Role: Two separate integrations — Whisper for speech-to-text (`/audio/transcriptions` with `response_format=verbose_json`) and a chat-completions model for structured bookkeeping extraction (`/chat/completions` with `response_format=json_object`).
- SDK real API: both adapters call the REST endpoints directly via `fetch` rather than an SDK; authentication is `Authorization: Bearer <apiKey>`; models are supplied via config (`transcribeModel`, `extractionModel`, `baseUrl`).
- Error classification separates auth failures (401/403), rejected payloads (400/422), and transient/unavailable errors (408/409/425/429/500–504) for retry semantics.
- Verify exact request/response shapes against the OpenAI docs.