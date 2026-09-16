# Source-only release checklist

1. `npm ci`, `npm run check`, `npm audit`, `npm run test:e2e` (install Chromium first).
2. With private data available, `npm run prepare:air` and `npm run test:e2e:game`. Never upload these data or browser reports.
3. `npm run build` restores the root-path demo after subpath browser tests.
4. `npm run release:check` rejects unexpected/large source files, tracked asset paths when Git is available, and unsafe default build output.
5. `npm run release:source` creates an allowlisted folder under `release/` and a SHA-256 inventory beside it. No originals or generated media are deleted or copied. **Do not zip the entire `release/` directory**: it can also contain private backups! Package only the exact new `air-web-source-*` folder printed by the command.
6. Review its inventory and contents. Verify dependency licenses and code provenance; automated filename checks cannot establish copyright ownership or detect every secret/content snippet.
7. In that source-only folder, run a clean `npm ci && npm run check`. The eleven real-data tests must be reported skipped, not silently pass. Run the demo browser test there too.
8. Initialize Git in the reviewed source folder, not the asset-bearing workspace:

   ```sh
   git init
   git add .
   npm run release:check
   git diff --cached --stat
   git diff --cached --name-only
   git commit -m "Prepare source-only AIR web player"
   git branch -M main
   ```

9. Create an empty GitHub repository using your chosen owner/name, add its remote, and push only after reviewing the staged files. The preparation agent does not choose an account, create a remote, or publish automatically.
10. Label the initial release **experimental / prerelease**. Link README, QA limitations, MIT license, and hosting instructions. GitHub source archives should contain code only. Do not attach `dist-game/`, game manifests, asset reports, original data, saves, screenshots, logs, or traces.

## Artifact distinction

| Path | Contents | Public source release? |
| --- | --- | --- |
| `src/`, `tools/`, docs/config | Code and synthetic fixtures | Yes, after review |
| `public/` | Hand-written web manifest and retirement worker | Yes |
| `dist/` | Asset-free compiled demo | Optional separate demo hosting, not source package |
| `AIR_SE/` | Original proprietary installation | No |
| `.air-web-assets/` | Decoded media, story manifest, local report | No |
| `dist-game/` | Playable asset-bearing static deployment | No; authorized hosting only |
| `release/local-dist-preserved-*` | Backup of older asset-bearing output, if present | **No** |

Ignore rules are a safety net, not permission to publish. Never force-add ignored game content. The source exporter uses explicit roots and refuses symlinks rather than relying solely on `.gitignore`.
