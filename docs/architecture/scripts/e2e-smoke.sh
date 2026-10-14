#!/usr/bin/env bash
# End-to-end smoke test for the gitdaemon server-client MVP.
# Builds the daemon, runs it against a throwaway repo, and drives the full
# workflow over the real JSON-RPC API. Prints PASS/FAIL per step.
#
# Usage: yarn e2e   (or: bash docs/architecture/scripts/e2e-smoke.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
PORT="${GITDAEMON_PORT:-4790}"
BASE="http://127.0.0.1:$PORT"
BIN="$ROOT/server/target/debug/gitdaemon"
TMP="$(mktemp -d)"
RID=1
pass=0; fail=0

note() { printf '  %-9s %s\n' "$1" "$2"; }
check() { # check <label> <needle> <haystack>
  if grep -qF "$2" <<<"$3"; then note PASS "$1"; pass=$((pass+1));
  else note FAIL "$1"; echo "---- got: $3"; fail=$((fail+1)); fi
}
rpc() { curl -sf "$BASE/rpc" -H 'content-type: application/json' \
        -d "{\"id\":$RID,\"method\":\"$1\",\"params\":$2}"; RID=$((RID+1)); }

cleanup() { [[ -n "${SRV:-}" ]] && kill "$SRV" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== building daemon =="
( cd server && cargo build -q )

echo "== preparing scratch repo =="
mkdir -p "$TMP/repo"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" config user.email e2e@example.com
git -C "$TMP/repo" config user.name E2E
printf 'line1\nline2\n' > "$TMP/repo/a.txt"
git -C "$TMP/repo" add -A
git -C "$TMP/repo" commit -qm "initial commit"

echo "== starting daemon on :$PORT =="
GITDAEMON_PORT=$PORT "$BIN" >/tmp/opencode/gitdaemon-e2e.log 2>&1 &
SRV=$!
for _ in $(seq 1 50); do curl -sf "$BASE/health" >/dev/null && break; sleep 0.2; done

echo "== driving workflow =="
check "health"     '"ok":true'        "$(curl -sf "$BASE/health")"
check "repo.open"  '"ok":true'        "$(rpc repo.open "{\"path\":\"$TMP/repo\"}")"

printf 'line1\nCHANGED\n' > "$TMP/repo/a.txt"; printf 'new\n' > "$TMP/repo/c.txt"
ST="$(rpc status.get "{\"path\":\"$TMP/repo\"}")"
check "status.modified" '"kind":"modified"' "$ST"
check "status.untracked" '"kind":"untracked"' "$ST"

check "stage"      '"ok":true'        "$(rpc status.stage "{\"path\":\"$TMP/repo\",\"files\":[\"a.txt\",\"c.txt\"]}")"
CM="$(rpc commit.create "{\"path\":\"$TMP/repo\",\"message\":{\"summary\":\"e2e second\",\"description\":\"d\"}}")"
check "commit.sha" '"sha"'            "$CM"
check "log.hasCommit" 'e2e second'    "$(rpc log.list "{\"path\":\"$TMP/repo\",\"limit\":5}")"
check "branch.create"  '"ok":true'    "$(rpc branch.create "{\"path\":\"$TMP/repo\",\"name\":\"e2e-branch\"}")"
check "branch.checkout" '"ok":true'    "$(rpc branch.checkout "{\"path\":\"$TMP/repo\",\"name\":\"e2e-branch\"}")"
check "branch.listed"   'e2e-branch'  "$(rpc branch.list "{\"path\":\"$TMP/repo\"}")"
check "changedFiles"    '"c.txt"'     "$(rpc log.changedFiles "{\"path\":\"$TMP/repo\",\"sha\":\"HEAD\"}")"
check "unknown.method"  'bad_request' "$(rpc nope.nope '{}')"

# After a full commit the working directory must be clean.
ST2="$(rpc status.get "{\"path\":\"$TMP/repo\"}")"
check "status.clean"    '"files":[]'  "$ST2"

# A path with a space must be reported in full (not truncated at the space).
printf 'spaced\n' > "$TMP/repo/my file.txt"
SPS="$(rpc status.get "{\"path\":\"$TMP/repo\"}")"
check "status.spacePath"  '"path":"my file.txt"' "$SPS"
check "status.spaceStage" '"ok":true' "$(rpc status.stage "{\"path\":\"$TMP/repo\",\"files\":[\"my file.txt\"]}")"
rpc commit.create "{\"path\":\"$TMP/repo\",\"message\":{\"summary\":\"spaced file\"}}" >/dev/null

# ahead/behind must reflect the true local-vs-upstream delta (not swapped).
git init -q --bare "$TMP/remote.git"
git -C "$TMP/repo" remote add origin "$TMP/remote.git" 2>/dev/null || true
git -C "$TMP/repo" push -q origin HEAD:refs/heads/e2e-branch
git -C "$TMP/repo" branch --set-upstream-to=origin/e2e-branch e2e-branch 2>/dev/null || true
printf 'local-only\n' >> "$TMP/repo/a.txt"
git -C "$TMP/repo" commit -qam "local ahead commit"
ABS="$(rpc status.get "{\"path\":\"$TMP/repo\"}")"
check "ab.ahead1"  '"ahead":1'  "$ABS"
check "ab.behind0" '"behind":0' "$ABS"

echo "== result: $pass passed, $fail failed =="
[[ $fail -eq 0 ]]
