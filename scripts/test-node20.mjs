import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = ["--import", "tsx", "--test", "test/integration.test.ts"];
const major = Number(process.versions.node.split(".")[0]);

function run(nodePath) {
  const result = spawnSync(nodePath, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

if (major >= 20) {
  run(process.execPath);
}

const candidates = [
  "/usr/local/opt/node@20/bin/node",
  "/opt/homebrew/opt/node@20/bin/node",
];
const node20 = candidates.find((candidate) => existsSync(candidate));

if (!node20) {
  console.error("Integration tests require Node 20+. Install node@20 or run npm test with Node 20 in PATH.");
  process.exit(1);
}

run(node20);
