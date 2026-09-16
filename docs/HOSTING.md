# Hosting

## Source-only demo (safe default)

Run `npm ci && npm run build` and deploy **only `dist/`** to any static HTTPS host. No server-side application, database, account, or secret is needed. Never point a web server at the project directory.

For GitHub project Pages or another subpath, build with the final path:

```sh
npm run build -- --base /your-repository/
```

Serve it at `/your-repository/` (trailing slash). The checked-in CI only tests and builds the demo; it does not deploy or upload game assets. GitHub Actions can build this without any game data or secrets.

## Authorized asset-bearing hosting

A volunteer can clone the source and build with their own compatible data, or receive your prepared data **only if you have the right to share it**. Owning AIR alone is not permission for public redistribution. A source MIT license grants no rights to the game content.

1. Install Node 24.15+ and run `npm ci`.
2. Put the authorized original data in `AIR_SE/`.
3. Run `npm run build:game`.
4. Deploy only `dist-game/` to an HTTPS static host. For a subpath, use `npm run build:game -- --base /air/` and serve `/air/`.
5. Test New Game, actual text advancement, choices, audio, and save/reload at the final URL.

The host must support **HTTP byte-range requests** for seeking audio. Serve `.json` as `application/json`, `.wasm` if ever added with its proper MIME, `.ogg` as `audio/ogg`, `.wav` as `audio/wav`, and `.webmanifest` as `application/manifest+json`. Enable Brotli/gzip for JS/CSS/JSON: the manifest is about 128 MB uncompressed in the tested dataset. Provide enough bandwidth and storage for ~1.7 GB of media plus the manifest; this is unsuitable for hosts with small single-file quotas. No CDN, remote asset URL, or account is required. A separate asset origin would need additional CORS/configuration not currently supplied.

Use short/no-cache policies for `index.html`, `manifest.json`, and `sw.js`; immutable caching is suitable for hashed Vite bundles. Media names are not content-hashed, so invalidate cached media when replacing datasets. Replace deployments consistently to avoid mixing manifests and assets from different versions. Check your hosting plan's limits before uploading.

The old cache-everything service worker is retired. `public/sw.js` only removes the project's legacy caches and unregisters itself. **Offline playback is not supported.** Do not restore the old worker from `.air-web-assets/`.

## Privacy and operations

- Do not serve `AIR_SE/`, `.air-web-assets/asset-report.json`, `.env`, project source roots, or logs.
- No uploads/authentication are implemented. A URL containing game assets makes them accessible to anyone allowed by your host's access controls. Use host-level access controls if needed; hiding a link is not protection.
- Vite development/preview servers bind to loopback by default and are not production servers. `AIR_LAN=1` exposes the local server to the LAN; use it only deliberately with trusted users. Raw `/air-source` serving has been removed.
- Browser saves remain on that origin. Give users advance notice before changing domains or clearing data; encourage save export.
- Bug reports, traces, screenshots, and save exports may contain copyrighted game text. Keep them private or redact them.
