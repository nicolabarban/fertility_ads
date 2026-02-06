# fertility_ads

A lightweight web app for viewing OCR text from `sample200.csv` and running two OpenAI-powered classification workflows:
- OCR cleanup + ADVERTISEMENT label
- ADS_REPRO vs ART vs OTHER classifier

## Requirements
- Node.js 18+
- An OpenAI API key

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file (see `.env.example`) and set `OPENAI_API_KEY`.
3. Start the server:
   ```bash
   npm run dev
   ```
4. Open `http://localhost:3000`.

## Configuration
- `OPENAI_MODEL` defaults to `gpt-4.1-mini` if not provided.
- `data/sample200.csv` is loaded at runtime.
- Prompts live in `prompts/` and are sent to the OpenAI Responses API.

## UI Notes
- The article list shows `year | json_path`.
- Matches from `matched_patterns` are highlighted in the article window.

## Render (Optional)
`render.yaml` is included to deploy the backend so OpenAI calls run server-side. Set `OPENAI_API_KEY` in Render's environment variables.
