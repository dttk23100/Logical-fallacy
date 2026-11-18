import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { respond } from "./analyzer.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "public");
const port = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 64 * 1024;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleAnalyze(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch (error) {
    sendJson(res, error.status ?? 400, { error: "Invalid request body" });
    return;
  }
  const { status, body } = await respond(payload);
  sendJson(res, status, body);
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.join(publicDir, relative);
  if (!filePath.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/analyze") {
    handleAnalyze(req, res);
  } else if (req.method === "GET") {
    serveStatic(req, res);
  } else {
    res.writeHead(405).end();
  }
});

server.listen(port, () => {
  console.log(`Fallacy detector running at http://localhost:${port}`);
});
