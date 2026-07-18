# site/ — landing + docs

The whatsacc marketing site, in the house product-repo mini-site format. Fully static,
zero external requests, fully separate from the application: fonts are vendored in
`fonts/`, the markdown renderer in `docs/vendor/`. Host it anywhere; it also syncs into
the Vulos console as the product mini-site.

- `index.html` — the one-file landing page. All asset paths are relative, so the same
  file serves standalone **and** synced into vulos-cloud at
  `/products/whatsacc/landing.html` (same-origin iframe safe).
- `docs.html` — a self-contained docs viewer at the site root (sidebar, search, TOC,
  hash routes like `docs.html#/self-host`). Theme persists via localStorage
  `whatsacc.theme`.
- `docs/` — markdown chapters + `manifest.json` in the Vulos DocsViewer schema, fetched
  by `docs.html` (so relative URLs inside chapters resolve from the site root).
- `screenshots/` + `screenshots/dark/` — PNGs land here from `npm run screenshotter`
  (portal-dashboard, portal-locations, portal-analytics, portal-limits, security,
  app-emergency, landing-hero, docs). The landing degrades gracefully if any are
  missing.
