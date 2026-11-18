// Vercel function for /api/transcribe. Locally, server.js serves the same route.
// GET reports whether Whisper is set up; POST takes one audio clip as the raw request body.
import { transcribe, whisperAvailable } from "../transcriber.js";

export const config = { maxDuration: 60 };

async function rawBody(req) {
  if (Buffer.isBuffer(req.body)) return req.body; // Vercel parses application/octet-stream into a Buffer
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    res.status(200).json({ available: whisperAvailable() });
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use GET or POST" });
    return;
  }
  const { status, body } = await transcribe(await rawBody(req), req.query.type, req.query.prompt);
  res.status(status).json(body);
}
