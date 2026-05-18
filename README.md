# JobHunt

Mobile PWA that aggregates remote jobs from RemoteOK, We Work Remotely, and Hacker News "Who is hiring" into one feed.

## Stack
- Vanilla HTML/CSS/JS — no framework
- Vercel serverless function at `/api/jobs` aggregates the 3 sources
- PWA — installable to iPhone home screen, runs standalone (no browser chrome)

## Local dev

You'll need the Vercel CLI for the API route to work locally:

```powershell
npm i -g vercel
vercel dev
```

Then open http://localhost:3000.

(If you only want to preview the static UI without the API, `npx serve` works but the feed will fail to load.)

## Deploy

Push to GitHub, then connect the repo in Vercel — auto-deploys on push. Same flow as SKATE.

## Install on iPhone

1. Open the deployed URL in Safari
2. Share → Add to Home Screen
3. Launch from the icon — opens full-screen, no browser chrome

## Structure

```
jobhunt/
├── index.html, styles.css, app.js   ← static frontend
├── manifest.json, service-worker.js ← PWA bits
├── icon.svg, icons/                 ← PWA icons
├── api/jobs.js                      ← Vercel serverless aggregator
└── package.json
```
