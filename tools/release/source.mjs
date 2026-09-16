import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sourceFiles } from "./policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const files = await sourceFiles(root);
const destination = path.join(root, "release", `air-web-source-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
await fs.mkdir(destination, { recursive: true });
const inventory = [];
for (const relative of files) {
  const data = await fs.readFile(path.join(root, relative));
  const target = path.join(destination, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data, { flag: "wx" });
  inventory.push(`${createHash("sha256").update(data).digest("hex")}  ${relative}`);
}
await fs.writeFile(`${destination}.sha256`, `${inventory.join("\n")}\n`);
console.log(`Source-only release: ${destination}\n${files.length} files. Originals and decoded assets were not copied, modified, or deleted.`);
