/**
 * node-pty@1.1.0 ships its unix `spawn-helper` prebuilt without the execute
 * bit, which makes pty.spawn fail with "posix_spawnp failed". Restore it.
 */
const { chmodSync, existsSync } = require("node:fs");
const path = require("node:path");

try {
  const pkgDir = path.dirname(require.resolve("node-pty/package.json"));
  const prebuilds = path.join(pkgDir, "prebuilds");
  for (const platform of existsSync(prebuilds) ? require("node:fs").readdirSync(prebuilds) : []) {
    const helper = path.join(prebuilds, platform, "spawn-helper");
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
      console.log(`[terminal-provider] chmod +x ${helper}`);
    }
  }
} catch (err) {
  // Non-fatal: node-pty may not be installed yet (e.g. during clean install).
  console.warn(`[terminal-provider] spawn-helper fix skipped: ${err.message}`);
}
