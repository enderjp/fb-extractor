import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { extractTextPayloadSchema } from "./validators/extractTextSchema.js";
import { ScraperError, TextNotFoundError } from "./errors.js";
import { extractPostText } from "./services/facebookTextScraper.js";
import { promises as fs } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "1mb" }));

// Serve interactive API docs
const docsPath = path.join(__dirname, "public", "docs.html");
app.get("/", (_req, res) => res.sendFile(docsPath));
app.get("/docs", (_req, res) => res.sendFile(docsPath));

let activeExtractions = 0;

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    busy: activeExtractions > 0,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/extract-text", async (req, res) => {
  const parsed = extractTextPayloadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Invalid payload",
      details: parsed.error.errors,
    });
  }

  const { url, options } = parsed.data;

  activeExtractions += 1;
  try {
    const payload = await extractPostText(url, options);
    return res.json(payload);
  } catch (error) {
    const tryRemoveArtifacts = async (meta) => {
      try {
        const htmlPath = meta?.debugArtifacts?.htmlPath;
        const metaPath = meta?.debugArtifacts?.metaPath;
        if (htmlPath) {
          await fs.unlink(htmlPath).catch(() => {});
        }
        if (metaPath) {
          await fs.unlink(metaPath).catch(() => {});
        }
      } catch {
        // ignore removal errors
      }
    };

    if (error instanceof TextNotFoundError) {
      if (error.meta) await tryRemoveArtifacts(error.meta);
      return res.status(404).json({
        error: error.message,
        code: error.code,
        meta: error.meta ?? null,
      });
    }
    if (error instanceof ScraperError) {
      if (error.meta) await tryRemoveArtifacts(error.meta);
      return res.status(502).json({
        error: error.message,
        code: error.code,
        meta: error.meta ?? null,
      });
    }
    console.error("Unexpected error extracting text", error);
    return res.status(500).json({
      error: "Unexpected error extracting post text. Check the server logs.",
    });
  } finally {
    activeExtractions = Math.max(0, activeExtractions - 1);
  }
});

app.listen(config.port, () => {
  console.log(`Facebook text extractor listening on port ${config.port}`);
});
