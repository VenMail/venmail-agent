# Venmail Agent

Venmail Agent is a Chrome extension and ange that qualify individuals/companies quickly. It unifies SERP analysis and Google Maps reputation signals into a single, privacy-aware workflow.

---

## TL;DR

```bash
pnpm install                   # install workspace deps
pnpm --filter @venmail/shared build   # build shared package (required before extension bundle)
pnpm --filter @venmail/extension dev  # run extension in watch mode
pnpm --filter @venmail/webapp dev     # companion webapp
```

Load `packages/extension/dist` as an unpacked extension in Chrome (Developer Mode). Enable consent for the providers you want (SERP, Maps, etc) directly from the popup.

---

## Repository Layout

| Path | Description |
| ---- | ----------- |
| `packages/extension/` | Chrome extension (popup UI, background orchestrator, content scripts). |
| `packages/shared/` | Shared TypeScript types, reputation engine, Hunter mapping utilities. Built via `tsup`. |
| `packages/webapp/` | Planned web UI for future APIs. |
| `resources/` | Static assets (icons, screenshots, marketing collateral). |
| `scripts/` | Tooling and automation helpers. |

---

## Key Features

- **Smart lookup orchestration** – background service coordinates provider tasks with caching, debouncing, and error handling.
- **Agent-grade SERP insights** – DOM scrapers for Google/Bing plus DuckDuckGo provide scored highlights and social links.
- **Maps reputation scan** – extracts rating, review counts, hours/status information, and likely website for companies.
- **Recent lookup history** – performance analytics, manual refresh, debug logging toggle, and history clearing built into the popup.
- **ContactOut capture** – *Pending*.
- **Hunter verification** – *Pending*.

---

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or newer (LTS recommended).
- [pnpm](https://pnpm.io/) 8.x+ (workspace-enabled).
- Chrome (or Chromium) with Developer Mode enabled to load unpacked extensions.

---

## Setup & Development Workflow

1. **Install dependencies**
   ```bash
   pnpm install
   ```

2. **Build the shared package** (generates `dist/` used by the extension bundle).
   ```bash
   pnpm --filter @venmail/shared build
   ```

3. **Run the extension in watch mode**
   ```bash
   pnpm --filter @venmail/extension dev
   ```
   - Outputs to `packages/extension/dist` (auto-refresh via Vite).
   - Load the unpacked folder in Chrome → `chrome://extensions` → *Load unpacked*.

4. **Testing**
   ```bash
   pnpm --filter @venmail/extension test   # Vitest suite (content scripts, utils)
   pnpm --filter @venmail/shared test      # Shared-domain tests (coming soon)
   ```


---

## Building & Packaging

### Extension

```bash
pnpm --filter @venmail/shared build   # ensure exports are up to date
pnpm --filter @venmail/extension build
```

Artifacts are generated under `packages/extension/dist`. Zip the directory (without `.map` files if desired) for Chrome Web Store submission.

### Webapp

```bash
pnpm --filter @venmail/webapp build
```

Deploy the resulting `.next` output to Vercel, Netlify, or any Node-compatible host. Environment variables are documented below.

---

## Configuration & Environment

Duplicate the provided samples and fill in secrets.

| Location | Sample | Notes |
| -------- | ------ | ----- |
| `packages/extension/.env` | `env.sample` | Configure Hunter API key, proxy base URL, feature flags. |
| `packages/webapp/.env.local` | `env.sample` | Hunter API key, allowed origins, logging verbosity. |
| `packages/webapp/app/env.ts` | — | Validates env vars at runtime. |

Important variables:

- `VENMAIL_API_BASE_URL` – optional; when set, uses venmail to lookup the contact email.
- `SERP_DOM_DEBUG` – enables verbose SERP logging in the console (see popup debug toggle for user-facing control).

---

## Provider Overview

| Provider | Description | Consent Toggle | Key Files |
| -------- | ----------- | -------------- | --------- |
| `serp-scan` | Google/Bing DOM scraping + DuckDuckGo API fallback with highlight ranking. | **Search** | `packages/extension/src/background/providers/serpScan.ts`, `packages/extension/src/content/detection/index.ts` |
| `maps-scan` | Google Maps reputation extraction (ratings, reviews, hours, website). | **Maps** | `packages/extension/src/content/detection/index.ts` |
| `profile-scan` | Inline contact detection across arbitrary pages. | **Search** | `packages/extension/src/content/detection/index.ts` |
| `contact-page-scan` | Finds email/phone/contact forms on suspected contact pages. | **Search** | `packages/extension/src/background/providers/contactPage.ts` |

Consent settings live in `chrome.storage.sync` via the popup settings panel. Providers bail early when consent is missing.

---

## Popup Experience Highlights

- Manual lookup form with inferred LinkedIn + domain hints.
- Insight cards summarising search highlights, Maps reputation, and provider signals.
- Performance panel (recent lookup latency, cache hits) with **Refresh insights**, **Enable debug logging**, and **Clear history** controls.
- Detection snapshot streamlining “select text → enrich” workflows.

UI code: `packages/extension/src/popup/popupApp.tsx` and styles in `popupApp.css`.

---

## Contributing & Project Guardrails

- Follow existing TypeScript/React style (see `.eslintrc` and `tsconfig.base.json`).
- Resource folder names stay lowercase (`resources/` rule). Assets go under existing naming conventions.
- Use `pnpm` for all scripts so workspace dependencies remain deterministic.
- Run `pnpm --filter @venmail/shared build` before submitting PRs touching shared exports.
- Update tests and docs alongside feature work—especially when adjusting SERP/ContactOut heuristics.

---

## License

MIT
