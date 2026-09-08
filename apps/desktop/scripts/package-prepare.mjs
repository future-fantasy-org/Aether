#!/usr/bin/env node
/**
 * package-prepare.mjs — materialize the Agent Execution Host sidecar before
 * electron-forge packages the app.
 *
 * `pnpm --filter=@aether/agent-runtime-host deploy --prod <target>` copies the
 * host package plus its prod dependency tree (including @aether/runtime-deepseek
 * with dist/harness) into a self-contained directory that forge.config.ts packs
 * via `extraResources`. At runtime the packaged app spawns the host sidecar from
 * `process.resourcesPath/aether-agent-host` (see src/main/sidecar.ts).
 *
 * Prerequisite: `pnpm build` at the repo root (deploy copies dist as-is).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "../..");
const target = path.join(appDir, ".pack", "aether-agent-host");
const hostDistBin = path.join(repoRoot, "packages/agent-runtime-host/dist/bin/aether-agent-host.js");

if (!existsSync(hostDistBin)) {
  console.error(
    "[package-prepare] packages/agent-runtime-host/dist is missing — run `pnpm build` at the repo root first.",
  );
  process.exit(1);
}

// npm implicitly runs node-gyp for packages that ship binding.gyp without an
// install script; pnpm does not. macos-alias (via appdmg → MakerDMG) needs its
// native addon built before `electron-forge make` on darwin, and fs-xattr
// (electron-winstaller) is often in the same state after an allowBuilds change.
if (process.platform === "darwin") {
  const nodeGyp = path.join(repoRoot, "node_modules/node-gyp/bin/node-gyp.js");
  if (!existsSync(nodeGyp)) {
    console.error("[package-prepare] node-gyp not found at", nodeGyp, "— add it as a root devDependency.");
    process.exit(1);
  }
  for (const pkg of ["macos-alias", "fs-xattr"]) {
    const pkgDir = path.join(repoRoot, "node_modules", pkg);
    const releaseDir = path.join(pkgDir, "build/Release");
    const alreadyBuilt =
      existsSync(releaseDir) && readdirSync(releaseDir).some((f) => f.endsWith(".node"));
    if (!existsSync(pkgDir) || alreadyBuilt) continue;
    console.log(`[package-prepare] building native addon for ${pkg} (node-gyp)`);
    const built = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
      cwd: pkgDir,
      stdio: "inherit",
    });
    if (built.status !== 0) {
      console.error(`[package-prepare] node-gyp rebuild failed for ${pkg}`);
      process.exit(built.status ?? 1);
    }
  }
}

// Fresh deploy: pnpm deploy refuses to write into a dirty target.
rmSync(target, { recursive: true, force: true });
mkdirSync(path.dirname(target), { recursive: true });

console.log("[package-prepare] deploying @aether/agent-runtime-host (+ prod deps) to", target);
const deploy = spawnSync(
  "pnpm",
  // --legacy: pnpm ≥10 only allows deploy from injected-dependencies workspaces
  // otherwise. We want this single command scoped, not inject-workspace-packages
  // globally, so use the legacy layout (package files at target root).
  // --ignore-scripts: the deploy sub-install re-evaluates build-script approval
  // (whose allowBuilds keys differ on Windows file: paths), and nothing here
  // needs it — node-pty ships prebuilds/ that node-gyp-build loads at runtime,
  // and the spawn-helper chmod is handled below.
  ["--filter=@aether/agent-runtime-host", "deploy", "--prod", "--legacy", "--ignore-scripts", target],
  {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  },
);
if (deploy.status !== 0) {
  console.error("[package-prepare] pnpm deploy failed with status", deploy.status);
  process.exit(deploy.status ?? 1);
}

// node-pty ships prebuilt spawn-helper binaries whose exec bit does not always
// survive copies (pnpm 11 / cross-platform checkouts). Restore 0o755 so the
// packaged terminal surface keeps working. See terminal-provider postinstall.
let fixed = 0;
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full);
    } else if (entry === "spawn-helper") {
      chmodSync(full, 0o755);
      fixed += 1;
    }
  }
};
walk(target);
console.log(`[package-prepare] restored exec bit on ${fixed} spawn-helper binary(ies)`);

// Verify the deployed layout: default deploy puts the package at the target
// root; legacy-style layouts nest it under node_modules. sidecar.ts probes both.
const binCandidates = [
  path.join(target, "dist/bin/aether-agent-host.js"),
  path.join(target, "node_modules/@aether/agent-runtime-host/dist/bin/aether-agent-host.js"),
];
const found = binCandidates.filter((c) => existsSync(c));
if (found.length === 0) {
  console.error(
    "[package-prepare] deployed tree has no host bin. Expected one of:\n  " +
      binCandidates.join("\n  "),
  );
  process.exit(1);
}
const harness = path.join(target, "node_modules/@aether/runtime-deepseek/dist/harness/bin/deepseek-harness.js");
if (!existsSync(harness)) {
  console.error("[package-prepare] deployed tree is missing the deepseek harness bin:", harness);
  process.exit(1);
}
console.log("[package-prepare] ok — host bin:", found[0]);
