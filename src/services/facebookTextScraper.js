import puppeteer from "puppeteer";
import fs from "fs";
import { execSync } from "child_process";
import path from "path";
import {
  FacebookAccessError,
  ScraperError,
  TextNotFoundError,
} from "../errors.js";
import { config } from "../config.js";
import { loadFacebookCookies } from "../utils/loadCookies.js";
import { persistDebugArtifacts } from "../utils/debugArtifacts.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SUPPORTED_HOSTS = ["facebook.com", "fb.watch", "fb.com"];

const BLOCKED_RESOURCE_TYPES = new Set(["stylesheet", "font", "media"]);

const OG_IMAGE_SELECTOR = 'meta[property="og:image"]';
const OG_TITLE_SELECTOR = 'meta[property="og:title"]';
const OG_DESCRIPTION_SELECTOR = 'meta[property="og:description"]';

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const normalizeFacebookUrl = (rawUrl) => {
  const url = new URL(rawUrl);
  const hostAllowed = SUPPORTED_HOSTS.some((host) => url.hostname.endsWith(host));
  if (!hostAllowed) {
    throw new ScraperError("Only Facebook URLs are supported.", {
      code: "UNSUPPORTED_HOST",
    });
  }
  if (url.protocol !== "https:") {
    url.protocol = "https:";
  }
  return url.toString();
};

// ---------------------------------------------------------------------------
// Chrome executable resolution (same as video-downloader-v4)
// ---------------------------------------------------------------------------

const resolveExecutable = () => {
  const envPath = process.env.PUPPETEER_EXECUTABLE_PATH;
  console.warn("PUPPETEER_EXECUTABLE_PATH:", envPath ?? "(not set)");
  if (envPath && fs.existsSync(envPath)) return envPath;

  const cacheDir =
    process.env.PUPPETEER_CACHE_DIR ||
    process.env.PUPPETEER_CACHE ||
    "/opt/render/.cache/puppeteer";
  console.warn("PUPPETEER_CACHE_DIR resolving to:", cacheDir);

  const candidates = [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    path.join(cacheDir, "chrome-linux", "chrome"),
    path.join(cacheDir, "chrome-linux-127.0.6533.88", "chrome"),
    path.join(cacheDir, "chrome-linux-127.0.6533-88", "chrome"),
    path.join(cacheDir, "chromium", "chrome"),
    path.join("/opt/render/.cache/puppeteer", "chrome-linux", "chrome"),
  ];

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        console.warn(`Found Chrome at ${p}`);
        return p;
      }
    } catch {
      // ignore
    }
  }

  // Attempt runtime install
  try {
    if (!process.env.SKIP_PUPPETEER_INSTALL && cacheDir) {
      console.warn(`Attempting runtime puppeteer install into: ${cacheDir}`);
      const installEnv = { ...process.env, PUPPETEER_CACHE_DIR: cacheDir };
      try {
        execSync("npx puppeteer@latest install chrome", {
          env: installEnv,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 10 * 60 * 1000,
          maxBuffer: 10 * 1024 * 1024,
        });
      } catch (installErr) {
        console.warn("puppeteer runtime install failed:", installErr?.message ?? installErr);
      }

      for (const p of candidates) {
        try {
          if (p && fs.existsSync(p)) return p;
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    console.warn("error during runtime puppeteer install:", err?.message ?? err);
  }

  return null;
};

// ---------------------------------------------------------------------------
// Metadata extraction (og: tags)
// ---------------------------------------------------------------------------

const extractMetadata = async (page) =>
  page.evaluate(
    (imageSelector, titleSelector, descriptionSelector, requestedUrl) => {
      const safeContent = (selector) =>
        document.querySelector(selector)?.getAttribute("content") ?? null;

      return {
        title: safeContent(titleSelector),
        description: safeContent(descriptionSelector),
        thumbnail: safeContent(imageSelector),
        permalink: requestedUrl,
      };
    },
    OG_IMAGE_SELECTOR,
    OG_TITLE_SELECTOR,
    OG_DESCRIPTION_SELECTOR,
    page.url(),
  );

// ---------------------------------------------------------------------------
// Post text extraction — multiple strategies
// ---------------------------------------------------------------------------

/**
 * Strategy 1: Extract from og:description meta tag.
 */
const extractFromOgDescription = async (page) =>
  page.evaluate(() => {
    const meta = document.querySelector('meta[property="og:description"]');
    return meta?.getAttribute("content")?.trim() || null;
  });

/**
 * Strategy 2: Extract from the main post body via DOM selectors.
 *
 * Facebook renders the post description inside specific `div[dir="auto"]`
 * elements, often with `data-ad-preview="message"` on a parent or inside
 * the post content container.  We try several selector paths, from most
 * specific to least specific.
 */
const extractFromDom = async (page) =>
  page.evaluate(() => {
    // Helper: collect all non-empty text from a list of elements
    const collectText = (elements) => {
      const texts = [];
      for (const el of elements) {
        const text = el.innerText?.trim();
        if (text && text.length > 1) {
          texts.push(text);
        }
      }
      return texts.length ? texts.join("\n") : null;
    };

    // --- Attempt A: data-ad-preview="message" ---
    const adPreview = document.querySelector('[data-ad-preview="message"]');
    if (adPreview) {
      const text = adPreview.innerText?.trim();
      if (text) return text;
    }

    // --- Attempt B: the first large div[dir="auto"] that is likely the post text ---
    // Facebook wraps the post message in divs with dir="auto".
    // We look for the first one with substantial text.
    const dirAutos = document.querySelectorAll('div[dir="auto"]');
    for (const el of dirAutos) {
      const text = el.innerText?.trim();
      // Skip short strings that are likely UI labels
      if (text && text.length > 15) {
        // Make sure this element is not inside a comment or sidebar
        const parent = el.closest('[role="article"]');
        if (parent) {
          return text;
        }
      }
    }

    // --- Attempt C: role="article" first occurrence ---
    const articles = document.querySelectorAll('[role="article"]');
    if (articles.length) {
      const firstArticle = articles[0];
      // Collect dir="auto" inside the first article
      const innerDirAutos = firstArticle.querySelectorAll('div[dir="auto"]');
      const result = collectText(innerDirAutos);
      if (result) return result;
    }

    // --- Attempt D: userContentWrapper (older Facebook layout) ---
    const userContent = document.querySelector(".userContentWrapper");
    if (userContent) {
      const paragraphs = userContent.querySelectorAll("p");
      const result = collectText(paragraphs);
      if (result) return result;
    }

    return null;
  });

/**
 * Strategy 3: Search for post text inside inline <script> JSON payloads.
 *
 * Facebook embeds post data in JSON-LD or relay payloads inside script tags.
 * We look for "message" or "text" fields that contain the post text.
 */
const extractFromScripts = async (page) =>
  page.evaluate(() => {
    // Look in JSON-LD structured data
    const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
      try {
        const data = JSON.parse(script.textContent);
        // Could be an Article, SocialMediaPosting, etc.
        const text =
          data?.articleBody ||
          data?.description ||
          data?.text ||
          data?.name;
        if (text && typeof text === "string" && text.trim().length > 5) {
          return text.trim();
        }
      } catch {
        // ignore parse errors
      }
    }

    // Search generic script contents for "message":{"text":"..."} patterns
    const messageTextRegex = /"message"\s*:\s*\{\s*"text"\s*:\s*"([^"]{5,})"/g;
    for (const script of document.scripts) {
      const content = script.textContent;
      if (!content) continue;
      const match = messageTextRegex.exec(content);
      if (match?.[1]) {
        // Decode unicode escapes
        try {
          const decoded = JSON.parse(`"${match[1]}"`);
          return decoded;
        } catch {
          return match[1];
        }
      }
      messageTextRegex.lastIndex = 0;
    }

    return null;
  });

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export const extractPostText = async (rawUrl, options = {}) => {
  const targetUrl = normalizeFacebookUrl(rawUrl);
  const executablePath = resolveExecutable();

  const launchOptions = {
    headless: config.headless,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  };
  if (executablePath) {
    launchOptions.executablePath = executablePath;
    console.warn(`Using Chrome executable at ${executablePath}`);
  }

  const browser = await puppeteer.launch(launchOptions);
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(options.timeoutMs ?? config.navigationTimeoutMs);

  await page.setUserAgent(config.userAgent);
  await page.setExtraHTTPHeaders({
    "Accept-Language": options.locale ?? config.defaultLocale,
  });

  // Block heavy assets but allow images (we might need og:image)
  if (config.blockHeavyAssets) {
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        request.abort();
        return;
      }
      request.continue();
    });
  }

  try {
    const cookies = await loadFacebookCookies(config.cookiesFilePath);
    if (cookies.length) {
      await page.setCookie(...cookies);
    }

    await page.goto(targetUrl, { waitUntil: "networkidle2" });
    // Give time for dynamic content to render
    await delay(3000);

    // ---- Try multiple extraction strategies in order ----
    const ogText = await extractFromOgDescription(page);
    const domText = await extractFromDom(page);
    const scriptText = await extractFromScripts(page);

    // Prefer DOM text (most accurate) > script text > og:description
    const postText = domText || scriptText || ogText || null;

    const metadata = await extractMetadata(page);

    let debugArtifacts = null;
    if (!postText) {
      if (config.enableDebugSnapshots) {
        try {
          const pageHtml = await page.content();
          debugArtifacts = await persistDebugArtifacts({
            page,
            requestedUrl: targetUrl,
            extractedText: null,
            htmlContent: pageHtml,
            dir: config.debugSnapshotsDir,
          });
          console.warn(
            `Saved debug snapshot to ${debugArtifacts.htmlPath} and ${debugArtifacts.metaPath}`,
          );
        } catch (snapshotError) {
          console.error("Failed to persist debug snapshot", snapshotError);
        }
      }
      throw new TextNotFoundError(undefined, {
        debugArtifacts,
        metadata,
      });
    }

    return {
      requestedUrl: targetUrl,
      text: postText,
      metadata,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof ScraperError) {
      throw error;
    }
    if (error.message?.includes("ERR_BLOCKED_BY_RESPONSE")) {
      throw new FacebookAccessError("Facebook blocked the automated request.");
    }
    if (error.name === "TimeoutError") {
      throw new FacebookAccessError("Timed out while loading the Facebook post.");
    }
    throw new ScraperError(error.message);
  } finally {
    await browser.close();
  }
};
