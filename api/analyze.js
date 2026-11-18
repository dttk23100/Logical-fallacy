// Vercel function for POST /api/analyze. Locally, server.js serves the same route.
import { respond } from "../analyzer.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST" });
    return;
  }
  const { status, body } = await respond(req.body);
  res.status(status).json(body);
}
