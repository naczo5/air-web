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

The host must support **HTTP byte-range requests** for seeking audio and for packed assets. Serve `.json` as `application/json`, `.wasm` if ever added with its proper MIME, `.ogg` as `audio/ogg`, `.wav` as `audio/wav`, and `.webmanifest` as `application/manifest+json`. Enable Brotli/gzip for JS/CSS/JSON. The unpacked story manifest is about 128 MB in the tested dataset; the packed layout below avoids downloading it at startup.

### Packed deployment (recommended)

Instead of publishing the 1.7 GB per-file tree, pack it into range-addressable archives:

```sh
npm run pack:air
npm run pack:air:check
```

`dist-pack/` contains a small bootstrap manifest, a gzipped manifest index, one gzipped JSON file per scene, image/voice archives, and the 42 large WAVs as individual streamed objects. The tested dataset becomes **537 objects / ~1.55 GiB** (from 26,170 objects / ~1.66 GiB): 390 archives, 96 scenes, 42 WAVs, 3 index/bootstrap files and 5 player-shell files. The first load fetches about **0.6 MB** instead of 128 MB. Archive names include a content hash.

Because the shell is part of the deployment, a rebuild must not accumulate old bundles: `pack:air --with-player` replaces `assets/` rather than merging into it, and `npm run build:player` skips the 1.6 GB media copy that the packed layout does not need.

Packed asset URLs look like `pack/<archive>#<start>-<end>:<codec>`. The player requests `Range: bytes=start-(end-1)`, validates a `206 Partial Content` and the byte count, and falls back to one full-chunk fetch if a host ignores `Range`. A host that ignores ranges still works, but a voice line may download a 2 MB chunk.

Upload rules:

- Set `Content-Type` per extension: `application/json`, `application/gzip` for `.json.gz`, `application/octet-stream` for `.pack`, `audio/wav`, `image/png`, `audio/ogg`.
- Use `Cache-Control: public, max-age=31536000, immutable` for hashed pack/scene/index names and `audio/` WAVs; use a short cache (`max-age=60`) for the stable `manifest.json` bootstrap.
- Do not set `Content-Encoding: gzip` on `.json.gz`; the player detects and decompresses gzip itself. (A host that adds the header also works.)
- If the assets are on a different origin, allow `Range` in CORS and expose `Content-Range`, `Content-Length`, and `Accept-Ranges`.
- Do not upload `report.json`, `.air-pack-output`, `.env`, `AIR_SE/`, or `.air-web-assets/`.

To assemble the player, run `npm run build:player` (a shell-only game build, ~2 s, no media copied) and then `npm run pack:air -- --with-player dist-game`. The packer copies only `index.html`, `assets/`, `manifest.webmanifest` and `sw.js`, and replaces those entries rather than merging, so stale hashed bundles cannot pile up. Never copy `dist-game/manifest.json` over the packed bootstrap.

The legacy `dist-game/` layout, which copies every media file individually, still works (`npm run build:game`).  Its media names are not content-hashed, so invalidate cached media when replacing datasets. Replace deployments consistently to avoid mixing manifests and assets from different versions. Check your hosting plan's limits before uploading.

The old cache-everything service worker is retired. `public/sw.js` only removes the project's legacy caches and unregisters itself. **Offline playback is not supported.** Do not restore the old worker from `.air-web-assets/`.

## Privacy and operations

- Do not serve `AIR_SE/`, `.air-web-assets/asset-report.json`, `.env`, project source roots, or logs.
- No uploads/authentication are implemented. A URL containing game assets makes them accessible to anyone allowed by your host's access controls. Use host-level access controls if needed; hiding a link is not protection.
- Vite development/preview servers bind to loopback by default and are not production servers. `AIR_LAN=1` exposes the local server to the LAN; use it only deliberately with trusted users. Raw `/air-source` serving has been removed.
- Browser saves remain on that origin. Give users advance notice before changing domains or clearing data; encourage save export.
- Bug reports, traces, screenshots, and save exports may contain copyrighted game text. Keep them private or redact them.
