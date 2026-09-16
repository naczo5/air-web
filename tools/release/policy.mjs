import fs from "node:fs/promises";
import path from "node:path";

// Explicit source roots, not a recursive copy of the working directory.
export const roots = ["src", "tools", "public", "e2e", ".github", ".gitignore", ".gitattributes", ".nvmrc", "README.md", "CONTRIBUTING.md", "SECURITY.md", "LICENSE", "docs", "index.html", "package.json", "package-lock.json", "tsconfig.json", "vite.config.ts", "playwright.config.ts"];
const sourceExtensions = new Set([".ts", ".tsx", ".mjs", ".css", ".html", ".json", ".md", ".yml", ".yaml", ".webmanifest", ".js"]);
const forbiddenParts = /^(?:AIR_SE|\.air-web-assets|dist(?:-game)?|node_modules|test-results|playwright-report|coverage|\.env(?:\..*)?)$/i;
const forbiddenNames = /^(?:SEEN\.txt|GAMEEXE\.INI|asset-report\.json|manifest\.json)$/i;

export function assertSourcePath(relative) {
  const parts = relative.replaceAll("\\", "/").split("/");
  if (parts.some((part) => forbiddenParts.test(part)) || forbiddenNames.test(parts.at(-1))) throw new Error(`Private/generated file is forbidden: ${relative}`);
  if (!roots.includes(parts[0])) throw new Error(`File is outside release allowlist: ${relative}`);
  if (parts.length > 1 && !sourceExtensions.has(path.extname(relative))) throw new Error(`Unexpected non-source file: ${relative}`);
}

export async function sourceFiles(root) {
  const files = [];
  async function walk(relative) {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Release refuses symlinks: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) await walk(`${relative}/${name}`);
    } else {
      assertSourcePath(relative);
      if (stat.size > 2 * 1024 * 1024) throw new Error(`Unexpected large source file: ${relative}`);
      files.push(relative);
    }
  }
  for (const entry of roots) {
    try { await fs.access(path.join(root, entry)); } catch { continue; }
    await walk(entry);
  }
  return files;
}
