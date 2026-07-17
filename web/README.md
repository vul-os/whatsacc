# web/ — whatsacc.com

The whatsacc landing page and docs platform. Fully static, zero external requests:
fonts are vendored in `fonts/`, the markdown renderer in `docs/vendor/`.

- `landing.html` — the one-file landing page. All asset paths are relative, so the same
  file serves at whatsacc.com **and** synced into vulos-cloud at
  `/products/whatsacc/landing.html` (same-origin iframe safe).
- `docs/` — markdown chapters + `manifest.json` in the Vulos DocsViewer schema, plus
  `docs/index.html`, a self-contained viewer for whatsacc.com (sidebar, search, TOC,
  hash routes like `docs/#/self-host`). Theme persists via localStorage `whatsacc.theme`.
- `screenshots/` + `screenshots/dark/` — PNGs land here from `npm run screenshotter`
  (portal-dashboard, portal-locations, portal-analytics, app-emergency, landing-hero,
  docs). The landing degrades gracefully if any are missing.
