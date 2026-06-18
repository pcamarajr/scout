# Google (Gemini)

Set in `scout.config.json`: `"model": "gemini-2.0-flash"` (any `gemini…` / `google…` id). Runs on the **AI SDK** engine.

## Credentials (detection order, first match wins, all network-free)

1. **`GOOGLE_GENERATIVE_AI_API_KEY`**
2. **`GEMINI_API_KEY`**
3. **`GOOGLE_API_KEY`**
   — any of these selects the Gemini API (`@ai-sdk/google`).
4. **`GOOGLE_APPLICATION_CREDENTIALS`** — a service-account JSON path that exists.
5. **gcloud ADC** — `~/.config/gcloud/application_default_credentials.json`.
   — these last two select Vertex AI (`@ai-sdk/google-vertex`), keyless.

## Setup

**Gemini API key:**

```bash
# get one at https://aistudio.google.com/apikey
export GEMINI_API_KEY=...
scout doctor
```

**Or Vertex AI with Application Default Credentials (keyless):**

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=your-gcp-project   # required for Vertex
scout doctor
```
