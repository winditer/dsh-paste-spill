#!/usr/bin/env bash
# Mount both paste-spill packages into the desktop profile.
#
# This must run OUTSIDE the agent's workspace-write sandbox: the profile lives at
# ~/.dsh/profiles/desktop, which that sandbox cannot write.
#
# Idempotent: re-running replaces the linked packages and re-writes the bundle
# list. `patchReload: live` in the profile means no restart is needed after this.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
NODE_MODULES="$PROFILE/node_modules"

HOST_PKG="dsh-paste-spill"
CLIENT_PKG="dsh-client-ui-paste-spill"

if [ ! -d "$PROFILE" ]; then
  echo "error: desktop profile not found at $PROFILE" >&2
  exit 1
fi

mkdir -p "$NODE_MODULES"
rm -rf "$NODE_MODULES/$HOST_PKG" "$NODE_MODULES/$CLIENT_PKG"
ln -s "$REPO_ROOT/$HOST_PKG" "$NODE_MODULES/$HOST_PKG"
ln -s "$REPO_ROOT/$CLIENT_PKG" "$NODE_MODULES/$CLIENT_PKG"
echo "linked: $NODE_MODULES/$HOST_PKG"
echo "linked: $NODE_MODULES/$CLIENT_PKG"

node - "$PROFILE/package.json" "$HOST_PKG" "$CLIENT_PKG" <<'NODE'
const fs = require("node:fs");
const [file, hostPkg, clientPkg] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
for (const name of [hostPkg, clientPkg]) {
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
}
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("bundles:", pkg.dsh.profile.bundles.join(", "));
NODE

echo "done. If the GUI does not pick it up live, refresh the page."