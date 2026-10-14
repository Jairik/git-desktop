#!/usr/bin/env bash
# The one build command for this fork.
#
#   ./build.sh
#
# Builds both halves of the active product — the Rust daemon (server/, release)
# and the web client (client/, vite) — then verifies the outputs and prints how
# to run the result. No yarn needed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

step() { printf '\n== %s ==\n' "$1"; }
die()  { printf 'error: %s\n' "$1" >&2; exit 1; }

# --- prerequisites -----------------------------------------------------------
for tool in node npm cargo; do
  command -v "$tool" >/dev/null || die "'$tool' not found on PATH (see docs/BUILD.md → Prerequisites)"
done

# --- build the daemon (release) ----------------------------------------------
step "building daemon (cargo --release)"
( cd server && cargo build --release )
[[ -x server/target/release/gitdaemon ]] || die "build finished but server/target/release/gitdaemon is missing"

# --- build the client ---------------------------------------------------------
step "building web client (tsc --noEmit && vite build)"
( cd client && npm run build )
[[ -f client/dist/index.html ]] || die "build finished but client/dist/index.html is missing"

# --- done ---------------------------------------------------------------------
step "build OK"
cat <<EOF
  daemon:  server/target/release/gitdaemon
  client:  client/dist/

Run the whole app (one binary serves the UI + the API on http://127.0.0.1:4789):

  ( cd server && GITDAEMON_SERVE_DIR="\$PWD/../client/dist" ./target/release/gitdaemon )

Or the packaged desktop shell:  yarn desktop   (== cd desktop && npm start)

Pieces, if you only need one side:
  cargo build --release   (in server/)   — or debug: cargo build
  npm run build           (in client/)   — dev server: npm run dev
EOF
