# Fallacy Detector

Listens to a conversation and flags, as it happens:

- **Logical fallacies** such as strawman, false dilemma and ad hominem
- **Pressure tactics** such as false urgency and guilt-tripping
- **Statistics red flags** such as numbers with no source or correlation presented as causation

Each flag shows the phrase, the formal name of the problem, and one sentence on why it is one. Borderline cases are shown too, marked as such.

Lines from the same speaker are joined into one turn. Press **End** to see every flag grouped by who said it.

The model also repairs words the speech recogniser mis-heard, using the surrounding conversation. A built-in dictionary lists every fallacy with a one-line meaning.

It does not fact-check: it judges how something is argued, not whether it is true.

## Run it

Needs Node 22 or newer and an Anthropic API key.

```bash
npm install
cp .env.example .env   # then put your key in .env
npm start
```

Open http://localhost:3000 in Chrome, Edge or Safari and tap the microphone.
Other browsers have no speech recognition, but you can still type or paste text.

## How it works

1. The browser's speech recognition turns microphone audio into text, phrase by phrase.
2. After each pause, the page sends the new phrases plus the last few for context to `POST /api/analyze`.
3. The server asks Claude for flags as structured JSON and the page highlights them in the transcript.

| File | Purpose |
|---|---|
| `server.js` | Local server: serves the page and the `/api/analyze` endpoint |
| `api/analyze.js` | The same endpoint as a Vercel function |
| `analyzer.js` | Prompt, output schema and the Claude call |
| `public/` | The page: speech capture, request queue, rendering |

## Deploy to Vercel

Import the repository in Vercel with no framework preset and set `ANTHROPIC_API_KEY` as an environment variable.
Vercel serves `public/` as the site and `api/analyze.js` as the endpoint.

Anyone who can open the deployed URL can run analyses on your key, so keep the URL private or turn on Vercel's deployment protection.

## Limits

- Speakers are worked out from the words, not the voices, so labels are a best guess. Click a label to correct it; later lines follow the correction.
- The browser's speech recognition can miss words, mostly when people talk over each other. Pick the spoken language in the bar; the wrong one garbles the transcript.
- A flag appears a few seconds after the phrase. Set `FALLACY_MODEL` to a smaller model to shorten that.
- Microphone access only works on `localhost` or over HTTPS.
- Chrome sends audio to Google for recognition, and the transcript text goes to Anthropic. Tell people before you record them; in many places you are required to.
