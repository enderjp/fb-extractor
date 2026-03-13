# FB Text Extractor

A fast Express API to extract text descriptions, metadata, and thumbnails from Facebook posts using Puppeteer.

## Features
- **Interactive UI**: Swagger/FastAPI style docs available at `/docs`.
- **Headless Scraper**: Uses Puppeteer to evaluate dynamic Facebook content safely.
- **Multiple Strategies**: Extracts text from DOM, JSON-LD, or `og:description` tags.
- **Docker Ready**: Preconfigured with `Dockerfile` for easy deployment on Render and other robust hosts.

## Prerequisites
- Node.js >= 20
- A `cookies.txt` file (Netscape format) with a valid Facebook session to avoid login/captcha blocks.

## Running Locally

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
   
3. Export your Facebook session cookies in Netscape format and save them locally as `cookies.txt`.

4. Start the server:
   ```bash
   npm start
   # or
   npm run dev
   ```

5. Go to [http://localhost:3000/docs](http://localhost:3000/docs) in your browser.

## Deployment with Docker (Render)

This project contains a `Dockerfile` powered by the official `puppeteer` image and a `render.yaml` configuration for quick deployment on [Render](https://render.com).

1. Upload your code to GitHub.
2. Go to Render Dashboard -> **Blueprints** -> **New Blueprint Instance**.
3. Connect your repository. Render will automatically detect `render.yaml` and provision a Docker Web Service.
4. Go to the new Web Service's Environment Variables page, and create a **Secret File** named `cookies.txt` containing your actual Facebook session cookies.

## API Documentation

The server exposes an interactive documentation UI.
- `GET /health`: Health check endpoint.
- `POST /api/extract-text`: Send a JSON payload `{"url": "https://facebook.com/..."}` to extract post information.

## License
MIT
