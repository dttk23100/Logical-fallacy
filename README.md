# Fallacy Detector

Listens to a conversation and flags, as it happens:

- **Logical fallacies** such as strawman, false dilemma and ad hominem
- **Pressure tactics** such as false urgency and guilt-tripping
- **Statistics red flags** such as numbers with no source or correlation presented as causation

Each flag shows the phrase, one sentence on what is wrong with it, and something you could say next.

It does not fact-check: it judges how something is argued, not whether it is true.

## Run it

Needs Node 22 or newer and an Anthropic API key.

```bash
npm install
cp .env.example .env   # then put your key in .env
npm start
```

Open http://localhost:3000 in Chrome, Edge or Safari and press **Start listening**.
Other browsers have no speech recognition, but you can still type or paste text.

## How it works

1. The browser's speech recognition turns microphone audio into text, phrase by phrase.
2. After each pause, the page sends the new phrases plus the last few for context to `POST /api/analyze`.
3. The server asks Claude for flags as structured JSON and the page highlights them in the transcript.

| File | Purpose |
|---|---|
| `server.js` | Serves the page and the `/api/analyze` endpoint |
| `analyzer.js` | Prompt, output schema and the Claude call |
| `public/` | The page: speech capture, request queue, rendering |

## Limits

- Speech recognition has no speaker labels, so the tool can't tell who said what.
- A flag appears a few seconds after the phrase. Set `FALLACY_MODEL` to a smaller model to shorten that.
- Microphone access only works on `localhost` or over HTTPS.
- Chrome sends audio to Google for recognition, and the transcript text goes to Anthropic. Tell people before you record them; in many places you are required to.
