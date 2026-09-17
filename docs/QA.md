# QA status — 2026-09-17

This is an experimental prerelease, **not a claim of perfect engine compatibility**.

## Verified locally

- TypeScript typecheck passes (re-verified 2026-09-17).
- 71 unit/component/integration tests pass with the local real manifest (re-verified 2026-09-17). Coverage includes bytecode/format helpers, UI text advancement, settings hydration, malformed save rejection, runtime concurrency/cancellation, and selected real-game scenes.
- The production Playwright regression passes on system Edge with the synthetic demo, served at `/qa/` to exercise subpath deployment (re-verified 2026-09-17; the environment's Playwright Chromium 1243 headless shell was not fully downloaded, so Edge was used via `AIR_BROWSER_CHANNEL=msedge` as documented). It asserts actual dialogue advancement, two History entries, save/reload/Continue, title/menu cleanup, and flowchart opening. The demo also asserts choice selection. Console errors fail this test.
- Earlier exploratory browser checks reached and selected a real story choice without console/network errors. Those checks were less rigorous than the checked-in regression and are not full route coverage.
- Dependency audit shows zero known vulnerabilities (re-verified 2026-09-17).
- Default builds exclude generated game data even when it exists locally. The source exporter copies only reviewed source roots and generates SHA-256 inventory.

## Reproduce

Use Node 24.15+ (the preinstalled Node 22.17 is below current jsdom's supported minimum).

```sh
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
npm run release:check
```

For local real-data checks: `npm run prepare:air && npm run test:e2e:game`. Tests without assets explicitly skip seven real-manifest cases and four original-file decoder cases; the remaining 60 tests must pass. Browser commands rebuild at `/qa/` and start a preview server on port 4186. To use installed Microsoft Edge instead of downloading Chromium, set `AIR_BROWSER_CHANNEL=msedge` in your shell. Run `npm run build` afterwards for a root-path demo, or `npm run build:game` for a root-path game build.

## Fixed during preparation

- Click-to-reveal ref deadlock: the next click now advances instead of repeatedly revealing the same line.
- Stale menu after Return to title/Continue.
- Settings defaults overwriting hydrated preferences; missing runtime cleanup.
- Concurrent runtime advance loops and stale loops after load/new-game/dispose; stopping skip and skip-read command text.
- Malformed/imported saves crashing the UI; errors now shown.
- Autoplay running before reveal or behind menus; Control skip on controls and after focus loss.
- Gallery preview audio cleanup.
- Default build copying private game data; raw original-file development endpoint removed.
- Cache-everything service worker retired (no invalid range-response caching).

## Not established / limitations

- Complete route playthroughs, every ending/choice permutation, original-engine fidelity, mobile/Safari/Firefox rendering, screen-reader/focus-trap accessibility, and audible correctness for every track have not been exhaustively verified.
- Runtime implements only a subset of RealLive. Some commands are ignored/simplified; timer queries and transition effects are approximations. A passing scene smoke test does not prove full compatibility.
- Flowchart route structure is partly curated/hard-coded. Jumps may lack required flags and can spoil the story. Demo flowchart is not a full synthetic route editor.
- Large manifests require substantial RAM/bandwidth; preparation and media copies need disk space. No streaming manifest loading or offline playback.
- Real-game tests depend on the compatible local dataset. Different editions/translations may fail and require decoder/runtime work.
- Assets, traces, screenshots, saves and manifests must remain private unless sharing is authorized. CI is source/demo-only; a GitHub Actions run cannot be claimed until pushed and executed there.
