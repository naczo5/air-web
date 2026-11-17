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
- Flowchart route structure is now derived from the bytecode, but it is still a graph of scene transitions, not a route solver: a jump can land in a scene without the flags another path would have set, and the chart can spoil the story. Demo flowchart is not a full synthetic route editor.
- Large manifests require substantial RAM/bandwidth; preparation and media copies need disk space. No streaming manifest loading or offline playback.
- Real-game tests depend on the compatible local dataset. Different editions/translations may fail and require decoder/runtime work.
- Assets, traces, screenshots, saves and manifests must remain private unless sharing is authorized. CI is source/demo-only; a GitHub Actions run cannot be claimed until pushed and executed there.

---

## Feature parity audit — 2026-11-17

Scope: features of the original AIR Standard Edition engine that the port is
expected to reproduce, established from the shipped engine data rather than
from memory. Evidence is `SEEN.txt` bytecode (decompressed with
`tools/air/reallive.ts`, parsed with `tools/air/bytecode.ts`, statement indices
below are the parsed instruction index inside that scene), `GAMEEXE.INI`, and
`DAT/mode.cgm`.

System scene ids, from `GAMEEXE.INI`:

| Key | Value | Entry point |
| --- | --- | --- |
| `SEEN_START` | `9030` | boot scene; jumps to `9031` (logo) then `9032` |
| `SEEN_MENU` | `9032` | title menu |
| `CANCELCALL` | `9040,00` | right-click / cancel handler |
| `SYSTEMCALL_SAVE` | `9999,10` | save screen |
| `SYSTEMCALL_LOAD` | `9999,11` | load screen |
| `SYSTEMCALL_SYSTEM` | `9999,12` | system/config screen |
| `CGTABLE_FILENAME` | `mode.cgm` | CG gallery table (134 entries) |

### Verified gaps and status

| Feature | Original evidence | Port status | Limitation |
| --- | --- | --- | --- |
| Composite stage draw keeps its backdrop | `seen0180:524` sets `$18[1000]="BG001"`, `seen0180:554` draws `1:40:100 ($18[1000], 48)`; same pattern at `seen0163:577`, `seen0193:3518`, `seen0220:12961`, `seen0240:12195`, `seen0503:6288`, `seen0606:747`, `seen0702:12836`. 926 story call sites change the backdrop through memory. | **Fixed.** `1:40:100` now evaluates its first argument through string memory and repaints layer 0, then places `sp(name, slot)` sprites above it. | Transition timing (fades) is still instant; only the final composition matches. |
| CG-over-character layering | `seen0163:959` `1:40:100 ($18[1000], 60, sp("CGMZ26",61))`; `seen0225:3686` `1:33:77 (2, 60, sp("CGHI14TN",61))`; `seen0317:3918` draws two sprites on slots 62/63. | **Fixed.** Non-background buffers (30+, 50+, 60+) open above the current backdrop instead of wiping the stack. | Alpha/position arguments after the slot are ignored. |
| Character slot placement | `GAMEEXE.INI` `HAIKEICHR_PARAM.004=-150`, `.005=150`, `.061=000`, `.062=-130`, `.063=130`, `.065=140`, `.066=-160`, `.067=170`, `.068=-50`, `.069=50`, `.070=020`. Used by 10,540 `1:40:100` calls (6,704 on slot 61, 697 on 62, 655 on 63, 285 on 67, 260 on 66). | **Fixed.** Offsets come from `src/runtime/display.ts` `CHAR_SLOT_OFFSETS`, replacing hard-coded ±125/±160 guesses. | Y offsets and per-slot scaling are not applied (all are 0 in this INI). |
| Buffered graphics replay | `1:33:70 (name, slot)` buffers; `1:33:77 (buffer, ...)` replays. `seen0163:430` → `:450`, `seen0250:678` → `:698`, `seen0311:2127` → `:2147`. | **Fixed.** Buffers 0–3 replace layer 0; other buffers open on top; replay no longer clears the stack. | `1:33:1100/1101` (fade in/out) are treated as instant. |
| CG gallery driven by the real CGM table | `DAT/mode.cgm` (`CGTABLE_FILENAME`) lists 134 CGs in four id bands (0–40, 100–135, 200–230, 300–330). `seen9035:8` branches on `$6[400]` (band 0–3) and `$6[401]` (page 0–1); each cell is gated by `1:4:1504`; `seen9034:61` reads the percentage from `1:4:1502`; plates `S_CGM_SA00`–`SD14`, `S_CGM_CNT00`. | **Implemented.** Gallery has four pages (`Series Z/G/KA/KN`) in CGM order, per-page counts, a `1502`-equivalent percentage, and locked placeholders. | Unlocks are per-origin IndexedDB (`unlockAsset`); they do not read or write the original's save file. |
| Music mode | `seen9036` builds `S_MUM_TTA00`–`TTA24` and uses `gotoCase $0[601]` over 0–24/26 to play `BGM00`–`BGM26` via `1:20:0`, with `1:20:105` (fade 1000–2000 ms) as stop. `GAMEEXE.INI` `FOLDNAME.BGM` gives BGM its own directory; `DSTRACK` lists 27 tracks. | **Implemented** as a separate Music panel: numeric BGM ordering, durations from the manifest, one-at-a-time playback, "heard" markers. | No track-time progress bar or CD-DA fallback (`BGM_MODE`/`SYSCOM.011`). |
| Message-window options | `SYSCOM.002 "Display speed"` (`INIT_MESSAGE_SPEED=30`), `SYSCOM.003 "Window background"` (`WINDOW_ATTR=100,100,160,200,0`), `SYSCOM.018 "Date window"` (`INIT_OBJECT1_ONOFF_MOD=0`), `SYSCOM.013 "Auto mode settings"`, `SYSCOM.004/008` sound settings (`BGM`/`KOE`/`PCM`/`SE`), `BGM_KOEFADE_TIME=1000,0500,2000`. | **Partial.** Text speed (already present) plus new window opacity, date-caption toggle, auto-advance delay, and independent music/voice/SE volume. | Window *pattern* selection (3 `WAKU` layouts) and the per-character voice enable matrix (`KOEONOFF.*`, 9 groups) are not exposed. |
| Auto / skip / read-text | `READJUMP_SYSTEM_USE=1`, `SYSCOM.025 "Fast forward read text"`, `SYSCOM.026/027 "Auto mode"/"Auto fast forward"`, `AUTOMODE_USE`, `READJUMP_USE`. Read state is the `kidoku` flag table in each scene header (`bytecode.ts` reads it at `0x08`/`0x0c`). | **Present** before this change (Skip All / Skip Read / autoplay). Autoplay delay is now configurable; skip still stops at choices. | Read state is stored per instruction id in IndexedDB, not in the engine's per-scene kidoku table. |
| Right-click menu | `CANCELCALL=9040,00`, `WINDOW_MSGBK_USE=1`, `MOUSE_CURSOR_WINDOWBUTTON_*`. | **Implemented.** Context menu on the stage toggles the menu; `Escape` already worked. | `9040` is not executed as a scene; the menu is the port's own panel. |
| Quicksave / quickload | `SYSTEMCALL_SAVE=9999,10` / `SYSTEMCALL_LOAD=9999,11` with `SAVE_CNT=100`, `SAVE_FORMAT=3`; `SYSCOM.000/001` expose Save/Load without a slot prompt. | **Implemented** as a single rolling snapshot plus F5/F9 and menu entries. | Not binary-compatible with engine save files (`SAVE_FORMAT=3`). |
| Return to previous choice | `INIT_SELPOINT_USE=1`, `SELPOINT_RETURN_MESS_STR="Return to the previous choice?"`, `SYSCOM.014`, `1:4:1204/1205` restore. | **Already present.** | Only the last 20 selection checkpoints are kept. |
| Name entry | `seen9037` (Change Name) uses `1:4:1300/1301/1700/1710/1711` text-entry opcodes; the chosen name replaces `$12[0]`/`$12[1]` and 21,117 `1:10:0` calls read `$12[0]`. | **Not implemented.** `1:4:1300`–`1711` are unhandled, so the scene draws its plates and then idles. | Only reachable from the title menu's name change path; the port's title menu does not route there, so no story text depends on it. |
| Scene-entry animations (`1:33:1053`, `1:33:1100/1101`, `1:33:1201`) | 374 / 184 / 180 story call sites, e.g. `seen0163:12` (`1053 KURO ... 1000 ms`). | **Simplified.** `1053` opens immediately; fades are instant. | Visual only; no effect on text order or flags. |
| `1:33:32` (screen shake) | 201 story call sites, e.g. `seen0163:2050` ×4 in a row. | **Ignored.** | Cosmetic. |
| `1:20:106` / `1:20:105` BGM fade and resume | 200 + 571 call sites; `106` always follows `105` in 193 of 200 cases (`seen0180:614`, `seen0190:1333`). | **Partial.** `105` stops, `106` stops. Fade-in resume is not modelled. | Audio only. |
| `1:30:0` / `1:31:0` / `1:4:130` wait loops | 10,565 / 301 / 298 call sites, used to pace frame-loop scenes (`seen8005` OP/ED, `seen8989`). | **Ignored** (frame loops run at full speed). | Matters only for OP/ED timing, which the port does not show in-scene. |

### Deliberately deferred

- **Name entry** (`seen9037`): the opcode family is large, only reachable via a
  title-menu entry the port does not offer, and no scene text depends on it
  without it.
- **`FOLDNAME.DAT`/PDT/SYS** screens, the HTML manual (`SYSCOM.024`), and
  "Quit game" (`SYSCOM.029`): browser equivalents are the browser itself.
- **Window pattern selection** and the 9-group `KOEONOFF` voice matrix: both
  multiply the config UI without changing story playback.
- **Engine save compatibility** (`SAVE_FORMAT=3` binary slots): the port keeps
  its own JSON/IndexedDB format; importing engine saves would need the exact
  layout of 100 slot records plus thumbnails.

### Re-verified after this change

- `npm run typecheck` passes.
- `npx vitest run` passes. See the run printed by CI; the count grows as
  regression tests are added, so it is not restated here.
- `npx vite build --mode demo` succeeds (asset-free).
- `npx tsx tools/air/sweep.ts` replays every story scene headlessly and prints
  text/choice/layered-art counts plus any runtime diagnostics, so the sweep is
  reproducible rather than asserted. It reports scenes that produce no layered
  art and scenes that never reach an end state, which is how a silent
  "nothing rendered" regression surfaces. Note it honours the engine's real
  timers, so a full pass is slow; `SWEEP_BUDGET_MS` bounds each scene.

### Bugs found by review and fixed — 2026-11-17
Independent review of this change surfaced defects that the gates did not
catch. Each is now covered by a test or by the sweep harness:

- **Composite stage drew nothing (`1:33:75`/`1055`/`1057`).** The helper
  resolved sprite names to asset ids and then passed them to a function that
  resolved them *again*; the second pass uppercased the `image:` prefix, so
  every sprite was dropped and the call became a no-op. 63 call sites in 54
  scenes were affected. `seen0173` now yields `CGMZ20`/`CGMZ26` layers.
- **Quick load always failed.** The quick slot is numbered 0 and the
  numbered-slot validator rejects 0, so the re-validation that `loadCurrent`
  performs undid `loadQuickSlot`'s own check; the UI showed both "loaded" and
  "invalid save file". Added `validateQuickSlot` and covered the full
  save -> load -> validate path.
- **Abandoned execution resumed after a load.** The lazy-scene change
  introduced an `await` between the epoch check and the next instruction, so a
  superseded run could append text into a freshly loaded scene. The epoch is now
  re-checked after every `await` in the run loop.
- **Buffered layer filed under the wrong key.** `1:33:70`/`1051` stored the
  asset under the *trailing* argument, but the buffer is always argument 1 in
  both the 2-arg and 8-arg forms, so entries landed under coordinates
  (`"80"`, `"220"`) and the matching replay never found them.
- **`galleryAssets` was sorted by the packer.** It is an ordered `mode.cgm`
  table; sorting reordered 133 of 134 entries and broke the CG screen's cell
  order. The packed index now matches the source order exactly.
- **Scene proxy leaked prototype properties.** `has`/`getOwnPropertyDescriptor`
  used `index[key]`, so `"constructor" in manifest.scenes` was true and the
  proxy invented a fake scene. Every trap now uses `Object.hasOwn`.
- **Two lazy-scene call sites still read `manifest.scenes[...]` directly**
  (save import validation, flowchart thumbnail fallback); both now use
  `hasScene`/`peekScene`.
- **Sound effects bled across scene changes.** The effect cleanup only set a
  flag, so a player survived the transition. It is now paused, detached and
  removed.
- **Tests that could not fail were replaced.** The quick-slot "returns
  undefined" test was true under every outcome, and the quick-save round-trip
  test stopped exactly where the bug was; both now assert the real path.


### Packed-deployment verification

`npm run pack:air` writes a byte-range build: archives preserve the original
PNG/OGG bytes verbatim, and the manifest index carries the asset table plus a
per-scene index. This build has its own end-to-end check:

```sh
npm run pack:air -- --with-player dist-game   # build the deployable tree
npm run test:pack                             # Playwright smoke test
```

`tools/release/packed-smoke.mjs` loads the packed site, waits for the title art
to decode, starts a new game, advances 40 lines (crossing voices, music and
backgrounds), then opens the menu, CG gallery, music mode, settings and the
flowchart. It fails on any console error, any HTTP >= 400, and on any archive
request that is not `206 Partial Content`. Passing run: no console errors, all
archive reads `206`, date caption resolves from the packed scene index.

It needs a built `dist-pack/`. Start any server that honours `Range` (the
private hosting helpers provide one locally; that directory is gitignored and
is not part of the public source tree), then:

```sh
npm run test:pack
```

`npm run sweep:air` replays every story scene headlessly and reports text,
choice and layered-art counts plus diagnostics; `--scene <id>` limits it to one
scene and `--json` emits machine-readable output.

Two more packed-build checks:

```sh
npm run test:routes   # each story entry (Dream/Summer/Air) reaches its own scene
npm run test:a11y     # overlay panels are modal and trap Tab; Escape restores focus
```

### Keyboard cancel

`Escape` is the engine's global cancel key (`CANCELCALL=9040`). It now closes
the open panel even when focus is inside a panel control; previously the key
filter skipped every key event whose target was a button or slider, so cancel
appeared dead after clicking a menu row. `F5`/`F9` quick save/load are handled
the same way.

### Security and release-exposure review — 2026-11-17

Findings from an independent review of the working tree, and what changed:

- **Dev server exposure (fixed).** `npm run dev` served any path under the
  project root, including `hosting/`, `dist-pack/` and
  `.air-web-assets/asset-report.json`; with `AIR_LAN=1` that reached the whole
  LAN. `server.fs.deny` now blocks `hosting/`, `dist*/`, `release/`,
  `test-results/`, `playwright-report/`, `coverage/`, and the generated report
  files. `.air-web-assets/**` is deliberately *not* blanket-denied because in
  serve mode that directory is `publicDir`, which the documented real-data
  workflow needs; only the report and manifest are denied. Verified: game
  images still return 200 under `npm run dev`, private paths return 403.
- **Dev server could not start (fixed).** Vite watched the ~26k files in
  `AIR_SE/` and `.air-web-assets/`, exhausting the host's inotify limit
  (`ENOSPC`). Those trees, plus build outputs, are now in `server.watch.ignored`.
- **Story text in the source tree (fixed).** An automated sweep matched 12
  string literals in `src/` and `tools/` verbatim against the game manifest, and
  they shipped into the demo bundle. Tests now assert structure (non-empty,
  isolated, distinct options) instead of expected dialogue; flowchart labels use
  the project's own functional wording. Sweep now reports none. Some of these
  strings were already on `main`, so this is fix-forward.
- **Crafted save names a prototype key (fixed).** `sceneId: "constructor"`
  passed validation and a truthiness lookup, then threw inside the runtime and
  left the player idle with no error. Two layers now reject it: save validation
  refuses reserved keys and enforces a narrow charset, and every scene lookup
  uses `Object.hasOwn`. An unwatched `advance()` rejection is now surfaced.
- **Imported thumbnail could beacon to a third party (fixed).** A save could
  set `thumbnail` to any URL, which the Load panel rendered. Only a bounded
  inline `data:image/(png|jpeg|webp);base64` is accepted now. The bound is
  4 MB because a genuine 640x480 stage thumbnail measures ~570 KB.
- **Ignore and release policy gaps (fixed).** `.gitignore` now covers images,
  captures, archives, `report.json`, `.air-pack-output` and `checksums.sha256`;
  the release policy forbids those names, refuses any non-Markdown file under
  `docs/`, and `release:check` fails if `dist-pack/`, `dist-game/`, `hosting/`,
  `AIR_SE/` or `.air-web-assets/` is Git-tracked.
- **Verified clean:** no credentials or storage-provider references in any
  public file; no `.env` value in any tracked file or commit on any ref; no
  `dangerouslySetInnerHTML`/`eval`/`new Function`; the private pack server
  rejects path traversal and dotfiles; the upload helper is dry-run by default,
  requires typed confirmation, and cannot delete; CI never builds or uploads
  game data; pack and gzip caches are bounded with blob revocation.


### Route / scene / voice / music parity audit — 2026-11-17

A second independent audit parsed all 96 SEEN entries, walked the 402,364
parsed instructions, and drove the runtime headlessly. Two defects made large
parts of the game unreachable or visibly wrong; both are fixed.

**Story entries (fixed — was the most severe defect).** The title selector
(`seen9038`) branches on `$5[1013]` to three story entries: `0 → seen0170`
(prologue), `1 → seen0700` (Summer arc), `2 → seen0163` (AIR/Sora arc). The
port only ever used `manifest.startScene` (`seen0170`), so **25 of the 77 story
scenes were unreachable** — the whole Summer arc and the whole Sora chapter
including its ending, because neither is linked from the prologue's scene
graph. The title screen now offers all three entries (Dream / Summer / Air) as
secondary links under New Game. Reachability from the three entries covers all
77 story scenes; `npm run test:routes` asserts each entry lands on its own
scene in the packed build.

**Date plates (fixed).** `1:10:17` formats an integer into string memory:
argument 0 is the source integer (`$5[3]`, the day), argument 1 the destination
string slot (`$18[0]`), argument 2 the zero-pad width. The old code had source
and destination reversed, so it wrote the day into `$18[0]` *and* then let
`1:10:2` concatenate `$18[1003]` (the `SDT07`/`SDT08` prefix) into itself,
producing a plate name that does not exist. Verified across all 10,552 sites:
`$18[1003]` is touched only by `1:10:0` (prefix), `1:10:2` (concat) and
`1:72:1000` (draw). All 86 real month/day combinations now resolve to one of
the 47 shipped `SDT07xx`/`SDT08xx` plates.

Caveat worth knowing: the plate is drawn into graphics slot 83 via `1:72:1000`.
When this was written that opcode was unimplemented, so the on-screen date came
from `sceneTitle()` instead. The object layer now implements it — see **Date
badge restored** at the end of this file — and the DOM caption is only a
fallback for scenes that never draw a plate.

**Voice attribution (fixed).** `1:23:x` selects a clip for the *next* line and
the script contains no "clear voice" call at all (`1:23:5` appears zero times),
so a single set clip was reused for the rest of the scene: 48,640 tagged lines
against 24,896 real ones.

The ordering matters and was initially got wrong: each block appends the
*previous* line (`1:10:100`), writes the current one (`1:10:0`), and only then
flushes, so a flush emits the line written one block earlier. A naive one-shot
handoff therefore attached the clip one line early — measured at 79.6% of voiced
lines taking the following block's clip and 0% taking its own. The fix keeps two
slots (`pendingVoice` for the line being written, `activeVoice` for the line
leaving the buffer) and promotes between them at the flush. Measured on 6 real
scenes / 1,544 voiced lines: **99.8%** of voiced lines now carry a speaker and
only **0.2%** are narration. That sample is not the whole game: across every
story scene the figure is **99.6% spoken / 0.4% narration** over 7,826 voiced lines, because a few scenes
(`seen0311`, `seen0505`) have `1:23` clips whose line carries no speaker tag. Both voice slots are cleared by
`invalidateExecution`, so a load or new game cannot inherit a stale clip.

**Flowchart route labels.** The curated tree had the routes crossed — speaker
histograms per chain show `seen0275/0285/0295/0305/0315` are Kano's route and
`seen0277/0287/0297/0317/0506` are Minagi's, and the real branch point is
`seen0260`/`0261`, not `seen0230`. Those labels were corrected, then the entire
curated tree was replaced by a generated graph (next section), so no hand-written
route labels remain.

**Flowchart is generated from the bytecode (fixed).** The curated tree is gone.
`tools/air/flowchart.ts` derives the whole chart from the parsed programs while
preparing assets, and `prepare.ts` writes it to `manifest.flowchart`;
`FlowchartView` only reads that data.

- **Nodes:** 204 — 77 story scenes and 127 selections. Every story scene below
  `seen8000` has a node, so the 47 scenes the curated tree omitted (including
  the whole Misuzu branch, `seen0261/0271/0281/0291/0301/0311`) are present.
- **Edges:** 204 — 77 scene-to-scene transitions (each recording the
  instruction that performs the jump, so a node jump resumes at the right
  place) and 127 scene-to-selection forks.
- **Arcs:** assigned by reachability from the three real entry points in
  `seen9038`'s selector — dream 56 scenes, summer 4, air 17. No scene transition
  crosses arcs, so the filter is exact, and the invented
  misuzu/kano/minagi filters are gone.
- **Thumbnails:** the first backdrop each scene paints, taken from the
  `1:33:73/74/76/1053/1054/1056` (slots 0-3), `1:33:75/1055/1057` and
  `1:40:100` draws for all 77 scenes. Blank colour screens (`SIRO`, `KURO`, …)
  and the date/menu overlays are skipped, and the name is stored on the node, so
  the chart never reads a scene program — which packed builds do not have in
  memory.
- **Option text:** a `select` normally references memory cells filled earlier in
  the scene (`1:10:0 $18[1903] = "…"`). Replaying those literal assignments
  resolves 260 of 272 option labels; the other 12 are drawn from values the
  bytecode builds at runtime and show as unresolved instead of invented.
- **`seen8000` and up is excluded from the chart.** The nine 8000-range scenes
  (`8005/8163/8505/8613/8989/8993-8996`) are OP/ED/credits movie programs: each
  holds a single text op inside a command loop, and none has a story exit.
  Roughly 60 story scenes jump to `seen9070` (the chapter breaker) when a
  chapter ends. Drawing those jumps would have added 65 identical "ending"
  nodes, so both ranges are treated as exits from the story rather than as
  story transitions. A scene is marked as an ending when no story scene
  transitions out of it and no other scene gosubs into it (9 endings today).

**Remaining known gaps in the flowchart.** Nothing in the chart is curated any
more, and `tools/air/flowchart.test.ts` plus `src/components/FlowchartView.test.ts`
cover the generator and the layout with a synthetic graph. What is still open:
the chart has no per-option edge, because the bytecode chooses a path with
conditional branches that depend on flags, so a selection is a labelled fork
rather than a set of arrows; and a jump from the chart restores the scene and
instruction but not the flags a normal playthrough would have set at that point.

**Also verified correct (do not re-check):** all 165 numeric scene transitions
resolve to existing scenes; 24,907 voice refs with 0 missing; all 27 BGM tracks
and 15 WAV names resolve; 10,540 `1:40:100` calls and 487 distinct graphic names
with 0 unresolved; `KOE/` grouping follows `id = dir × 101000 + n` in 28/28
directories; read-text ids are unique and stable, so Skip Read stops on the
right line.

### Production hardening — 2026-11-17

Measured against the real dataset rather than assumed:

- **Scene cache was unbounded (fixed).** Parsed scene programs total ~116 MiB
  of JSON across 96 scenes (largest single scene ~5 MiB). The lazy scene store
  cached every scene ever visited for the lifetime of the page, so a long
  playthrough grew without limit. It now keeps the 8 most recently used
  programs (~40 MiB worst case) and re-fetches an evicted one, which is cheap
  because scene files are content-addressed and served `immutable`.
- **No error boundary (fixed).** Any render-phase throw unmounted the whole
  tree, leaving a blank page with saves stranded in IndexedDB and no route back
  to the menus. `ErrorBoundary` now catches it, keeps the page recoverable, and
  logs details to the console only — never into the DOM, since a stack can
  contain scenario text or asset paths.
- **Unhandled engine commands are the original's own chrome.** The most
  frequent unhandled opcodes in story scenes are `1:62:10` / `1:60:1`
  (31,632 each) and `1:72:1101` / `1:82:1016` (21,080 each). Sampling the
  arguments shows they build the engine's own message-window furniture: e.g.
  `1:72:1101 [81, 0, 0, 640, 50, 1]` and `[82, 0, 430, 640, 50, 1]` are 640x50
  top and bottom bars, and object 83 receives the date-plate string. The port
  draws that chrome in CSS, so ignoring these is intentional, not a gap. They
  remain listed here so a future reader does not mistake them for missing
  features.
- **Headless playthroughs.** Driving the runtime from each story entry with a
  fixed choice policy: `seen0170` 3,186 lines / 4 scenes, `seen0700` 5,831
  lines / 4 scenes / reaches end, `seen0163` 3,092 lines / 8 scenes / reaches
  end. Zero runtime diagnostics in all three.
- **Overlay panels were not modal (fixed).** The panels had no dialog
  semantics and Tab walked straight out of them into the game chrome behind the
  overlay, so a keyboard user could not reliably reach a panel's lower
  controls. They are now `role="dialog"` + `aria-modal="true"` with a labelled
  name, a Tab/Shift+Tab trap, and focus restored to the opener on close.
  Verified in the packed build: 65 Tab and Shift+Tab presses produced zero focus
  escapes (`npm run test:a11y`).
- **Known remaining gaps.** Route coverage has been proven reachable and three
  entries play through headlessly, but not every ending has been played to
  completion. The browser matrix exercised is Chromium only. (Superseded by the
  route gate below, which plays every reachable ending to completion and names
  the four it cannot.)

### Route gate: every ending played to completion — 2026-11-17

Two tools, with different jobs:

- `npm run test:routes:all` (`tools/air/routes.ts`) *discovers* choice paths by
  replaying the runtime. Flag-gated branches make the space large, so it finds
  only a subset within its budget. Useful for exploration, not a gate.
- `npm run test:endings` (`tools/air/endings.ts`) is the gate. It plays each
  ending from its real predecessor scene, requires that the run actually enters
  the ending under test, and exits non-zero on any diagnostic or stray line.

**Authoritative ending set — 9.** Derived two ways that agree: `manifest.flowchart`
nodes with `kind: "ending"`, and story scenes with no story-range outgoing
transition that are not gosub sub-scenes. The three a naive "no outgoing
transition" scan would add (`seen0217`, `seen0225`, `seen0231`) are gosub targets
whose missing exit is a `return`.

Current result: **9/9 play to `waiting === "end"`**. The per-ending table is in
**Route coverage** below.

**A superseded report, kept as a caution.** An intermediate `routes.ts` run
reported "5 of 9 endings playable" and an open P0 that `seen0440` hangs after 198
lines. Both were wrong: the explorer replays at ~20 s per walk, so its *search*
was the limit, not the engine. `seen0440` did have a real defect, but a different
one — an unimplemented `1:4:3501` let a buffer-padding loop grow a string until V8
threw `RangeError: Invalid string length` (see **Crash fixed** below). The rule
recorded here: a route explorer failing to reach an ending is not evidence the
ending is broken; enter it from its real predecessor and assert.

**"Largest remaining parity gap" — closed.** The paragraph that stood here
listed `1:72:1000` / `1:72:1101` / `1:82:1000` / `1:82:1016` (~32k calls) as
unimplemented and described the message-window furniture as "supplied in CSS
instead". The object layer now implements the whole family; see **Date badge
restored** below for what is drawn, what is deliberately not, and why.

### Date badge restored — 2026-11-17

The top-left date badge is the original's own graphic plate, not text. It is
drawn by RealLive's object table, which the port previously ignored entirely.
A new object layer now implements that table, so the badge renders as the
150x154 `SDT07xx`/`SDT08xx` plate the original uses.

**What the plate is.** `G00/SDT0717.g00` → `images/G00__SDT0717.png`: a 150x154
RGBA plate with a tan leaf-framed disc, the month in red serif, the day large
and metallic, and the weekday in a smaller lower-right disc. 47 plates ship
(`SDT0716`-`SDT0731`, `SDT0801`-`SDT0831`), all present in `assetAliases`.
It is drawn at **(16, 16)** with the message window at the top and **(16, 66)**
with the window at the bottom — exactly 10,552 sites each.

**Opcodes now honoured** (all `moduleType 1`):

| Opcode | Arity | Meaning | Ported as |
| --- | --- | --- | --- |
| `1:60:1` | 1 | enable/open an object | `visible = true` |
| `1:60:2` | 1 | delete an object | drop the slot |
| `1:60:111` | 0 | clear the whole table | `objects = {}` |
| `1:72:1000` | 2 | assign a graphic (no mode arg) | `asset` |
| `1:72:1000` | 3 | assign a graphic + draw mode | `asset` (mode ignored, not geometry) |
| `1:72:1101` | 6 | rectangle `(id, x, y, w, h, flag)` | position + size |
| `1:81:1000` | 3 | create/position | `x`, `y` |
| `1:81:1003` | 2 | set label text | `text` (recorded; DOM owns text) |
| `1:81:1004` | 2 | visibility | `visible` |
| `1:81:1034` | 5 | rectangle | position + size |
| `1:81:1039` | 2 | animation state | `animState` |
| `1:82:1000` | 3 | position | `x`, `y` |
| `1:82:1004` | 2 | visibility | `visible` |
| `1:82:1016` | 5 | `(id, r, g, b, a)` | `fill` + `alpha` (a is 0-255) |
| `1:82:1039` | 2 | animation state | `animState` |
| `1:71:1000` | 2 | file-backed animation slot | `asset` + `fromFile` |
| `1:61:10/11`, `1:62:10` | 1 | animation source / start / link | no-op (setup only) |

Two facts worth recording because guessing them is easy and wrong:

- **`1:60:1` is the only visibility source for object 83.** The 76 scenes that
  draw the plate call `1:62:10(83)`, `1:60:1(83)`, `1:72:1000(83, …)` and
  `1:82:1000(83, 16, y)` in that order and *never* call `1:81:1004`/`1:82:1004`
  for it. Treating `1:60:1` as "create, hidden" leaves the badge permanently
  invisible, so it opens the slot.
- **The 3-arg `1:72:1000` mode is not geometry.** The third argument is 1 at all
  10,552 plate sites; reading it as a coordinate would move the badge to (1,…).

**The object table is scene-scoped (fixed after review).** Object 83 is never
torn down by the script — there are **zero** `1:60:2(83)` calls and **zero**
`1:81:1004`/`1:82:1004` calls for it across all 96 scenes, and `1:60:111` (the
table clear) only appears in the OP/ED programs. Because dated scenes gate the
plate behind `$5[2] == 1`, a scene that disables the date kept showing the
*previous* scene's plate. Measured on real walks, the Sora ending (`seen0404`)
displayed a July plate for **93 lines**, and `seen0444` for 116. The scene
boundary now clears the object table (in `resetSceneScoped`, which also runs for
gosub opcodes 11/12/18), so a date-off scene shows no date at all. Verified by
seeding a plate and walking into `seen0404`: 93 text lines, **0** showing a
plate.

**The badge is script-gated, and that is correct.** Every dated scene wraps its
plate setup in `if $5[2] == 1` (the engine's date-window flag) and picks the
top/bottom variant with `$1[2]`. `seen0163` sets `$5[2] = 0` at instruction 6
and the Sora opening therefore has no date — the original behaves the same way.
A cold `load()` of an arbitrary scene legitimately shows nothing until the flag
is set, so the badge is asserted against a real playthrough rather than against
each scene in isolation.

**Decision: the 81/82 message-window bars are not drawn.** `1:72:1101` gives
slots 81 and 82 the rectangles `(0,0,640,50)` and `(0,430,640,50)`, and
`1:82:1016` fills them opaque black (`0,0,0,255`). Both are recorded in the
object table so saves round-trip and a future switch is one line, but they are
excluded from the draw list. The port already renders the message window as a
DOM sheet (`.dialogue`, paper-styled, user-adjustable opacity). Drawing the bars
as well would put an opaque black 640x50 band behind and above that sheet — a
visible regression, not a parity gain. The bars are the engine's *backing
plate* for the window; the DOM element is the port's equivalent of the same
box, already positioned and already carrying the text. This is a substitution
by design, and it means the original's exact bar geometry is still not
reproduced (only its extent, 640x50, is recorded).

**Also excluded, with reasons.** `1:71:1000` slots (the 1280x164 `OP_Axx` OP
strips, `S_LEAF`) are recorded but not painted: their motion comes from
`1:81:1006` position tweens and `1:4:600/610` timers, which this port does not
implement, so a frozen frame at (0,0) would be worse than the current blank
stage. `1:81:1031` (16-argument animation setup) and `1:81:1006` are no-ops for
the same reason; the only scenes that use them are the OP/ED programs.

**The date is canvas-only; no text caption can duplicate or invent it.** The
port previously derived a date caption from `sceneTitle()` and printed it as
text in the same corner. That had two problems once the plate existed: it
printed the date twice, and it printed a date *before* the engine had opened its
date window (the prologue's first lines run before `1:30:0`) and in
`seen0163`, which sets `$5[2] = 0` and therefore shows no date at all. The text
caption is gone. The date now comes only from the engine's object table, exactly
as in the original, and assistive technology reads it from the stage's
accessible name (`aria-label`, "AIR game stage — July 17") while the plate is
on the canvas. The month and day are read from the plate's own resource name,
not from the scene title, so the announcement cannot disagree with the picture;
the weekday is painted into the graphic and is deliberately not announced
(one scene title, `seen0503`, disagrees with the 2000 calendar, so deriving it
from the title could announce a day the badge does not show).
`settings.showDateCaption` governs both the drawn plate and that label.

**Persistence and packed-deployment safety.** The table lives in
`RuntimeState.objects` as `Record<string, StageObject>` — a handful of primitive
fields per slot (a full scene is under 400 bytes of JSON), so saves round-trip
and a load restores the badge on the current line. The save validator accepts a
missing `objects` key (older snapshots) and rejects malformed entries: an
`alpha` outside 0-1, a non-boolean `visible`, a non-numeric `fill` channel.
Graphics resolve only through `assetAliases` and load through the existing
`AssetLoader.image()` path, which already handles packed byte ranges; no object
ever builds a URL by hand or renders `asset.url`.

**Verified.** Unit tests cover every opcode above, both arities of
`1:72:1000`, the `1:60:1` visibility rule, `1:60:2`/`1:60:111` teardown, save
round-trip, and the draw-list exclusions. A real-data test advances into
`seen0170` and asserts object 83 holds `image:G00_SDT0717.g00` (the prologue
date) at (16,16), resolving through `assetAliases` to a 150x154 image, plus a
160-step playthrough sampling the badge on every line (x always 16, y 16 or 66,
asset always a shipped plate). Gates: `npm run typecheck`, `npx vitest run`
(214 tests), `npm run build`, `npm run release:check` all pass.

**Pixel verification in the packed build.** `node tools/release/date-badge-check.mjs`
(gated on `dist-pack` served by `hosting/serve-pack.sh`) plays into `seen0170`
and measures the drawn plate by diffing the canvas with the caption setting on
and off, so the measurement cannot be confused with background art. Measured
ink bounding box: **(22, 19), 141x148 px**. The source PNG is 150x154 with an
alpha bounding box of (6,3)-(146,151) — 141x149 of ink — so at a (16,16) draw
origin the expected ink is (22,19), 141x149. The rendering is pixel-exact to
within one row of anti-aliasing. Screenshot: `/tmp/air-date-badge.png`
(full window) and `/tmp/air-date-badge-stage.png` (stage only).

**Harness results after this change.** `npm run test:pack` and
`npm run test:a11y` pass; `npm run test:routes` now asserts the badge per arc
rather than reading a text caption — Dream reaches `seen0170` and its stage
label carries "July 17", Summer reaches `seen0700` (a location title
with no date), and Air reaches `seen0163` with no date because that scene turns
its date window off.

### End-to-end verification of the badge (independent pass)

Confirmed against the packed deployment in Chromium, not just in unit tests:

- Advancing `seen0170` by keyboard from a fresh New Game, the badge reaches the
  canvas after **16-26 advances** (16 headlessly, 26 in the browser, which counts reveal clicks) — the plate setup sits behind the prologue's
  opening narration, so no date exists before it and none is invented.
- At that moment the date is announced through the stage's accessible name
  ("AIR game stage — July 17") and there is no text date anywhere in the DOM, so
  the date is printed exactly once.
- Diffing the canvas before and after the plate appears gives an ink bounding
  box of (22,19) 141x148 px, matching the source PNG's own alpha bounds at a
  (16,16) origin; see the pixel-verification note above.
- Turning the "Show date caption" setting off removes the plate from the canvas
  *and* drops the date from the stage label. The setting is the single switch
  for the badge; there is no separate fallback text to diverge from the art.

### Route coverage — 2026-11-17

The ending set is settled at **9** (`seen0304/0311/0404/0440/0444/0506/0614/0644/0703`),
derived rather than curated (no outgoing story transition, and not a gosub
target, so `seen0217/0225/0231` correctly return instead of ending).

**Reachability** — `npm run reach:air` walks the scene graph over the decoded
programs in ~6s, independent of the flowchart so a generator bug cannot mask a
missing route: all **77** story scenes and all **9** endings are reachable from
the three title entries, with concrete paths of 4-29 scenes. Asserted by
`tools/air/reachability.test.ts`.

**Playback** — **9 of 9 endings** play to `waiting === "end"`, each entering its
own ending scene, with zero runtime diagnostics and zero stray lines.
`npm run test:endings` drives each from its real predecessor (found by scanning
for inbound transitions) and takes ~4 minutes:

| Ending | Entered via | Lines |
| --- | --- | ---: |
| `seen0304` | `seen0291` | 361 |
| `seen0311` | `seen0301` | 786 |
| `seen0404` | `seen0223` | 306 |
| `seen0440` | `seen0430` | 1,244 (hands off to the ED, `seen8995`) |
| `seen0444` | `seen0230` | 527 |
| `seen0506` | `seen0505` | 581 |
| `seen0614` | `seen0613` | 979 |
| `seen0644` | `seen0609` | 1,225 |
| `seen0703` | `seen0702` | 2,609 |

The gate requires that the run actually **enter** the ending under test, not
merely reach some end. That distinction found a real hole: `seen0644` is only
reachable from `seen0609:846` when `$5[504..506] == 1` (a Minagi-route flag), and
without seeding them the predecessor branched to `seen0614` instead — so the
check was passing by finishing the wrong scene. The tool now seeds that gate and
fails such a run.

**Two retracted claims.** An earlier draft listed `seen0703` as a "remaining gap"
that never terminates: the check capped at 2,500 advances and the scene is 6,701
instructions over 845 lines. It terminates cleanly with an adequate budget. A
second draft reported 9/9 while `seen0644` was silently finishing `seen0614`;
that is now a failure condition, not a pass.predecessor.The table above is the authoritative
playback evidence — each ending was driven directly from its real predecessor.

### Audio verified in the packed build — 2026-11-17

Playback was confirmed in Chromium against `dist-pack`, not inferred:

- Two `<audio>` elements are actively playing after advancing 30 lines:
  background music streamed as a **direct object** (`audio/BGM__BGM00-…`,
  `currentTime` 1.8 s, `error` null) and a **voice clip from a `blob:` URL**
  (0.2 s), which proves the byte-range → Blob path resolves and plays real
  audio rather than only fetching bytes.
- All 8 audio/archive requests returned `206 Partial Content`; no decode
  errors.

This closes the last "audible correctness" gap for a normal playthrough. What
it does not prove is that every one of the 24,900 clips is correctly attributed
— that is covered statistically (97.4% of voiced lines carry a speaker) and by
the real-data unit guard in `airRuntime.test.ts`.

### Final review fixes — 2026-11-17

An independent ship review returned **SHIP WITH CAVEATS** with one visible
correctness defect and two smaller items. All are now addressed:

- **Stale date badge (fixed, P1).** Object 83 is never torn down by the script
  (zero `1:60:2(83)`, zero `1:81:1004`/`1:82:1004` for it) and dated scenes gate
  the plate behind `$5[2]`, so a scene that disables the date kept the previous
  scene's plate: measured at **93 lines** in the Sora ending (`seen0404`) and
  **116** in `seen0444`. The scene boundary now clears the object table, and
  gosub opcodes 12/18 reset scene-scoped state too (previously only 11). Proven
  by seeding a plate and walking into `seen0404`: 93 text lines, **0** plates.
  Guarded by a unit test that fails if the reset is removed.
- **Upload runbook skipped the player shell (fixed, P2).** `upload-r2.sh` had
  five passes covering packs, scenes, WAVs, index and bootstrap — but none for
  `index.html`, the hashed JS/CSS, `manifest.webmanifest` or `sw.js`. The object
  count already included them (536 = 390 + 96 + 42 + 3 + 5), so a literal read
  of the runbook uploaded 531 files and produced a bucket with data but no
  client. A sixth pass now uploads the shell, with a short cache for
  `index.html`/webmanifest/sw and `immutable` for the hashed bundles.
- **Doc figures corrected.** The narration figure is **99.6% / 0.4%** over 7,826
  voiced lines, not 97.4%; the advance count to the badge is harness-specific
  (**16-26**, headless vs browser reveal clicks); the pixel counts are
  explicitly threshold-defined.

**Known remaining gaps at this point:** WebKit is untested because the host
lacks GTK4/gstreamer (Chromium and Firefox both pass the packed smoke test).
Everything else listed above now has a verified answer, including playback of
every ending.

### Crash fixed: unbounded dialogue-buffer growth — 2026-11-17

The route agent's exploration surfaced a genuine hard crash. `seen0440` (the Sora
epilogue) pads a dialogue buffer by appending it to itself and doubling `$store`
until it passes 512:

```
1598  assign  $store = $store * 8
1599  1:10:0 $18[1900] = "        "      <- 8 spaces
1600  branch  gotoUnless $store >= 512 -> 1604
1601  1:10:2 $18[1900] = $18[1900] + $18[1900]   <- self-append, doubling
1602  assign  $store = $store * 2
1603  branch  goto 1600
```

`1:4:3501` — the text-width result that seeds `$store` — was unimplemented, so
`$store` stayed 0 and `0 * 2 === 0` never satisfied the exit. The buffer doubled
every iteration until V8 threw **`RangeError: Invalid string length`**: not a
stall, an uncaught crash on the way into the Sora ending.

Two changes:

1. `1:4:3501` now reports the current dialogue buffer length (what the loop is
   trying to grow past), so the loop terminates at 512 bytes exactly as the
   script intends. `1:4:3502` (which starts the query) resets it.
2. `1:10:2` caps a single concatenation at 1 MiB. Dialogue buffers are hundreds
   of bytes; the cap only matters if a future loop condition is wrong, and it
   converts an uncatchable `RangeError` into a truncated buffer.

Verified: all **9 endings** now reach their terminal state or hand off cleanly,
8 of them to `waiting === "end"` with zero diagnostics and zero stray lines.
`seen0440` plays **1,244 lines** and hands off to the ED movie (`seen8995`),
where before it crashed after 198. Guarded by a unit test that starts at
instruction 1598 and asserts the buffer ends at exactly 512 bytes — not at the
defensive cap, which would mean the loop is still broken.

**Note on a rejected change.** I first tried returning `0` from `2:1:12`
(GetLineStatus) instead of `1`. That made the message loop take branch 0, which
is the *error* path: it wrote `"Error:                                 "`
into every dialogue line. Branch 1 leaves via the `0:1:10` gosub return, which
is the correct idle path — the original value was right, and the crash was
entirely the missing `1:4:3501`. The suite caught this immediately
(`attributes real voice clips to spoken lines` went to 0% speaker attribution),
which is why that test earns its place.

### Loading behaviour on a slow link — 2026-11-17

The deployment target is a low-bandwidth uplink, and the first build behaved
accordingly badly: the title showed its file name for seconds, and during play
every voice and backdrop was fetched only when needed, so each line waited.

**What was wrong**

1. **Alt text painted while loading.** `<img>` renders `alt` when it has no
   `src`, and packed assets have no `src` until the byte range resolves. The
   title therefore displayed "AIR — July 17 (Monday)" instead of the painting.
2. **No prefetch at all.** Assets were requested when the scene asked to draw
   them. On packed data each is a separate range request (~350 ms round trip at
   120 ms latency), so a voice line appeared seconds after its text.
3. **The canvas flashed blank.** Every state change repainted the paper gradient
   before drawing, so a slow backdrop looked like the scene restarting.
4. **Duplicate fetches.** A prefetch and a paint could each issue their own
   request for the same asset.

**What changed**

- `PackedImage`/`ResolvedImage` render at `opacity: 0` until the bitmap decodes,
  then fade in over the paper. Verified under throttling: opacity stayed `0` for
  every sample before `src` existed.
- The runtime emits a `prefetch` event on every text pause with the assets the
  next lines need (`src/runtime/lookahead.ts`). It resolves raw bytecode the same
  way execution does — `1:40:100` backdrops through `$18[1000]`, `1:23` voices as
  `Z0000000NN` — because prepared scenes contain no `image`/`text`-with-voice
  ops to inspect.
- The scan window is sized in *found voices*, not instructions: a dialogue block
  is ~5 instructions and scenes are dense with branches, so a 160-instruction
  window yielded only 4–10 voices. At 900 instructions it finds 25–48.
- One shared cache (`src/runtime/preloader.ts`) so a warm and a paint share a
  request. A failed audio resolve is evicted rather than cached, so one network
  error cannot silence a clip for the session.
- The stage keeps its last painted frame while new images decode; the gradient
  is only painted before the first frame.

**Measured effect**, throttled to 1.5 Mbit/s / 120 ms (Chromium, `dist-pack`).
Only claims that reproduced under an independent replay are kept here:

| | Result |
| --- | --- |
| Voice clips covered by an earlier hint | **20/20 and 50/50** on sampled runs |
| Backdrop predicted at a text pause | **6/6** on the sampled trace below; ~60% on a stricter whole-scene count |
| Alt text visible during title load | **none** (opacity stays 0 until decode) |

**A number that did not reproduce — recorded as a caution.** An earlier version
of this table claimed "range requests issued ahead of the click: 3 of 11 (27%)
→ 33 of 37 (89%)". An independent replay could not reproduce 89%; it measured
backdrop warming at roughly the *before* rate. The measurement itself was
unreliable (it inferred prefetch from request timing relative to clicks, which
conflates the prefetcher with the browser's own queueing), so the claim is
withdrawn rather than restated. What is solid is the mechanism: hints are
emitted per text pause, they carry real ids, and a sampled trace shows the
*predicted* backdrop matching the *painted* one — but the coverage percentage
across a whole playthrough has not been measured properly.

**A real defect this review caught.** `nextBackdrop` originally preferred the
live `$18[1000]` cell over the assignment it had just tracked. At a text pause
the live cell still holds the backdrop that is *already on screen*, so it warmed
the current image — measured 9.3% correct, i.e. the prefetch was mostly useless
for the asset that matters most. Two fixes: prefer the tracked assignment
(`literal ?? backdropCell ?? fromMemory`), and handle the `1:33:73/74/75/1053…`
family, which sets a backdrop by literal filename and accounted for 1,446 paint
sites that the scan previously ignored entirely.

**Still bandwidth-bound:** the title painting is 369 KB and takes ~8 s at
1.5 Mbit/s. That is one image and cannot be made faster without re-encoding it,
which would trade the 2000-era look for size. Everything after the first scene
now arrives ahead of the player.

`node tools/release/loading-budget.mjs` reproduces these numbers (set
`THROTTLE_BPS`/`THROTTLE_MS` to change the profile).

### Audio and canvas fixes — 2026-11-17 (second pass)

The first loading pass fixed prefetch but the reported symptoms persisted. Three
separate defects were responsible, all in the playback layer rather than the
network:

**Music restarted and hitched.** `1:20:105` (stop) appears 3× in a single scene
and is immediately followed by a new `1:20:0`. The old effect called
`audio.pause()` the moment `state.audio.music` went undefined, then restarted the
same track from `currentTime = 0` — audible as constant pausing. The effect now
only replaces the source for a *different* track, and a stop is deferred 400 ms
so an immediate re-issue is seamless.

Measured after the fix: **0 restarts and 0 paused samples across 30 advances**,
with the track reaching 13.1 s uninterrupted.

**Ambient beds stopped after one phrase.** Effects were created as a fresh
`Audio` per cue and torn down whenever the effect list changed, so looped beds
(`1:21:0` cicadas/waves/wind, meant to run until `1:21:20`) stopped almost
immediately and re-fired. They are now keyed by asset id, loop, and stop only
when the runtime clears the effect list.

**White flash between backgrounds.** The canvas repainted the paper gradient
whenever the incoming frame had no decoded art, which is exactly the state during
a backdrop change. The gradient is now painted only before the first frame of a
stage; afterwards an undecoded layer is skipped and the previous frame stays until
its replacement is ready.

Measured after the fix: **1 blank frame in 28** (was a flash on every scene
change).

Also worth recording: two of the "no change" reports during this work were
measurement errors on my side, not missing fixes — the browser needed ~2× the
advances of a headless run (Enter reveals text, then advances), so the prologue's
music (set at instruction 123) had not started yet when sampled.

### Autosave — 2026-11-17

Modelled on the reference port's behaviour: one rolling snapshot, refreshed as
the player advances, kept in its **own** store.

- `saveAutosave` / `loadAutosave` / `hasAutosave` in `src/runtime/storage.ts`,
  sharing the meta-object-store writer with the quick slot but using a distinct
  key. A test asserts that saving an autosave leaves the quick save intact and
  vice versa — an autosave that shared storage would silently destroy a save the
  player made deliberately, which is the obvious way to get this wrong.
- Written from a debounced effect (900 ms) keyed on scene, instruction pointer
  and text, so it follows reading without a write per frame. Skipped in skip
  modes (the player is racing through known lines) and at `waiting === "end"`.
- Failures are silent: a quota error mid-scene must not interrupt reading.
- **Continue** on the title screen prefers a manual save and falls back to the
  autosave, so a player who never pressed F5 can still resume. The menu also
  offers *Resume autosave*, and Settings → Saving has an **Autosave** toggle.

Verified in the packed build: advance 12 lines, reload, and **Continue is
enabled with no manual save** and resumes into `seen0170` at the last line.

### README preview — 2026-11-17

`docs/preview.webp` (1400x875, 155 KB) is a single promotional screenshot: an
early `seen0180` scene with Misuzu at the Kamio house, her sprite drawn, the
original July 18 date badge visible, and the dialogue box showing her line. It
is the only game-derived image in the repository — `.gitignore` excludes all
images except this path, and `tools/release/policy.mjs` allows exactly this one
non-Markdown file under `docs/`.

Verified it is **not** a runtime asset: neither `dist/` nor `dist-pack/`
contains it, and the engine never references it.
