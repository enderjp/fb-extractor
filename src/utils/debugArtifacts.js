import { promises as fs } from "fs";
import path from "path";

/**
 * Persist a debug snapshot of the page HTML and extraction metadata
 * when the scraper fails to find post text. Useful for debugging
 * selector changes or Facebook layout updates.
 */
export const persistDebugArtifacts = async ({
  page,
  requestedUrl,
  extractedText,
  htmlContent,
  dir = "snapshots",
}) => {
  await fs.mkdir(dir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const htmlPath = path.join(dir, `${timestamp}.html`);
  const metaPath = path.join(dir, `${timestamp}.json`);

  const html = htmlContent ?? (await page.content());
  await fs.writeFile(htmlPath, html, "utf-8");

  const meta = {
    requestedUrl,
    extractedText: extractedText ?? null,
    timestamp: new Date().toISOString(),
    pageTitle: await page.title().catch(() => null),
    pageUrl: page.url(),
  };
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");

  return { htmlPath, metaPath };
};
