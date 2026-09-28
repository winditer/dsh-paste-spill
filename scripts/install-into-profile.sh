#!/usr/bin/env bash
# Mount dsh-paste-spill into the desktop profile.
#
# This must run OUTSIDE the agent's workspace-write sandbox: the profile lives at
# ~/.dsh/profiles/desktop, which that sandbox cannot write.
#
# ONE package, both halves. `dsh-paste-spill` declares `dsh.bundle.patch` (host half via
# `exports["."]`) AND `dsh.client` + `exports["./client"]` (browser half), so a single
# loader row in its patch covers both. That is the same shape as the installed
# dsh-image-gen / dsh-message-rail / dsh-prompt-optimizer.
#
# WHY the dependency entry, not just the bundle list. `dsh.profile.bundles` alone is NOT
# durable: `reconcileProfilePlugins` re-derives the bundle list from `dependencies`, and
# the desktop crash-recovery path (`sanitizeProfile`) replaces the whole list with the
# in-box names, keeping only dependency-backed entries. A name that is not a dependency
# is erased the first time the app recovers from a fatal boot. On 2026-09-28 this plugin
# was erased exactly that way (two `cordis.patch.yml.bak-*` fingerprints were left in the
# profile).
#
# No restart is needed on dsh-desktop >= 0.1.7-rc.2: dsh-hmr watches the profile manifest
# and recomposes when the ordered bundles list changes. The browser half is a page-level
# module, so a page refresh may still be required; a full relaunch is the guaranteed
# fallback (and is required if the manifest was wrong to begin with).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_HOME:-$HOME/.dsh}/profiles/desktop"
NODE_MODULES="$PROFILE/node_modules"

PKG="dsh-paste-spill"
# The browser half used to be its own package. Leaving either name behind in the profile
# after the merge would be a dangling bundle/dependency that a later `pnpm add` would try
# to resolve from the registry.
LEGACY_PKG="dsh-client-ui-paste-spill"

if [ ! -d "$PROFILE" ]; then
  echo "error: desktop profile not found at $PROFILE" >&2
  exit 1
fi

# `node` is not on PATH in this environment; fall back to a bundled runtime. Each
# candidate is EXECUTED, not just tested for the executable bit: the app's
# `runtime/bin/node` is a shell wrapper around $DSH_DESKTOP_NODE_EXECUTABLE and fails
# with "exec: : not found" when that variable is unset.
find_node() {
  local candidate
  if command -v node >/dev/null 2>&1 && node --version >/dev/null 2>&1; then
    command -v node
    return
  fi
  local candidates=(
    "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node"
  )
  for candidate in "${candidates[@]}"; do
    if [ -x "$candidate" ] && "$candidate" --version >/dev/null 2>&1; then
      echo "$candidate"
      return
    fi
  done
  return 1
}
NODE_BIN="$(find_node)" || {
  echo "error: no node executable found (PATH, app runtime, or ~/.dsh runtimes)" >&2
  exit 1
}

mkdir -p "$NODE_MODULES"
rm -rf "$NODE_MODULES/$PKG" "$NODE_MODULES/$LEGACY_PKG"
# The plugin package IS the repository root (market / awesome-list CI reads `dsh.bundle`
# from the root package.json), so the link points at the repo, not at a subdirectory.
ln -s "$REPO_ROOT" "$NODE_MODULES/$PKG"
echo "linked: $NODE_MODULES/$PKG -> $REPO_ROOT"

"$NODE_BIN" - "$PROFILE/package.json" "$REPO_ROOT" "$PKG" "$LEGACY_PKG" <<'NODE'
const fs = require("node:fs");
const [file, repoRoot, pkg, legacyPkg] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
manifest.dsh ??= {};
manifest.dsh.profile ??= {};
manifest.dsh.profile.bundles ??= [];
manifest.dependencies ??= {};
// Drop the pre-merge package name from BOTH lists before adding the merged package.
manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== legacyPkg);
delete manifest.dependencies[legacyPkg];
if (!manifest.dsh.profile.bundles.includes(pkg)) manifest.dsh.profile.bundles.push(pkg);
// Exactly the spec pnpm writes for a local directory: "link:<abs path>".
manifest.dependencies[pkg] = `link:${repoRoot}`;
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
if (legacyPkg in manifest.dependencies) throw new Error("legacy dependency survived");
if (manifest.dsh.profile.bundles.includes(legacyPkg)) throw new Error("legacy bundle survived");
console.log("bundles:", manifest.dsh.profile.bundles.join(", "));
console.log("dependency:", `${pkg}=${manifest.dependencies[pkg]}`);
NODE

cat <<'NOTE'

done.
  - one package, one loader row: dsh-paste-spill carries both the host half and the
    browser half (dsh.client + exports["./client"]).
  - dsh-desktop >= 0.1.7-rc.2 recomposes live when dsh.profile.bundles changes; the
    browser half may need a page refresh, and a full relaunch is the safe fallback.
  - verify the browser half actually applied by reading
    localStorage["dsh.paste-spill.diag"] in the renderer: `build` must be the current
    BUILD_REV and `applyRanAt` must be a fresh timestamp.
NOTE