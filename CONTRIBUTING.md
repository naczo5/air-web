# Contributing

Use Node 24.15+ and `npm ci`. Run `npm run check` and `npm run release:check` before a pull request. Default builds and CI must work without any AIR data. Add synthetic regression tests for changes; the real-manifest integration group is explicitly skipped when `.air-web-assets/manifest.json` is absent.

Browser checks: `npx playwright install chromium`, then `npm run test:e2e`. See docs/QA.md for asset-bearing checks. Never commit screenshots, traces, saves, generated manifests, archives, or game data. Keep issue reports to expected/actual behavior, browser/OS/Node versions, steps, and non-content diagnostics.

Verify you have the right to contribute code under the MIT license. Do not copy code from other interpreters without checking license compatibility and attribution. No game files or translation patches are accepted. Code provenance is the contributor's responsibility.
