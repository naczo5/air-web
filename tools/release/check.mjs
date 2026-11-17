import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertSourcePath, sourceFiles } from "./policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = await sourceFiles(root);
let tracked;
try { tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { /* Source folders need not be git repos. */ }
if (tracked) for (const file of tracked.split("\0").filter(Boolean)) assertSourcePath(file);
// Built demo must contain only the compiled shell and our hand-written public files.
const dist = path.join(root, "dist");
try {
  for (const name of await fs.readdir(dist)) {
    if (!["assets", "index.html", "manifest.webmanifest", "sw.js"].includes(name)) throw new Error(`Unsafe demo output: dist/${name}. Run npm run build.`);
  }
  for (const name of await fs.readdir(path.join(dist, "assets"))) {
    if (!/\.(?:js|css)$/.test(name)) throw new Error(`Unexpected demo bundle: ${name}`);
    if ((await fs.stat(path.join(dist, "assets", name))).size > 2 * 1024 * 1024) throw new Error(`Oversized demo bundle: ${name}`);
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

// Game builds and packed deployments must never be tracked, even if their
// paths sit under an allowlisted root.
const untrackedRequired = ["dist-pack", "dist-game", "hosting", "AIR_SE", ".air-web-assets"];
const trackedList = tracked ? tracked.split("\0").filter(Boolean) : [];
for (const prefix of untrackedRequired) {
  const offender = trackedList.find((file) => file === prefix || file.startsWith(`${prefix}/`));
  if (offender) throw new Error(`Private/generated path is tracked by Git: ${offender}. Remove it from the index.`);
}
for (const prefix of ["dist-pack/", "dist-pack-"]) {
  const offender = trackedList.find((file) => file.startsWith(prefix));
  if (offender) throw new Error(`Packed deployment is tracked by Git: ${offender}. Remove it from the index.`);
}
console.log(`PASS: ${files.length} allowlisted source files; Git tracked-file and demo-output checks passed where present.`);
