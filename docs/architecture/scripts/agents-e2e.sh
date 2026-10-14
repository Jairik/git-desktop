#!/usr/bin/env bash
# Agent + comment + SPA-serving end-to-end regression for gitdaemon.
#
# Deterministic: drives a FAKE agent CLI (no real LLM, no network) to prove the
# agent.*/comment.* RPC plumbing, and checks GITDAEMON_SERVE_DIR (the
# one-binary / Electron desktop path). Complements e2e-smoke.sh.
#
# Usage: yarn e2e:agents   (or: bash docs/architecture/scripts/agents-e2e.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
BIN="$ROOT/server/target/debug/gitdaemon"
PORT="${GITDAEMON_AGENT_PORT:-4791}"
SPA_PORT="${GITDAEMON_SPA_PORT:-4792}"
TMP="$(mktemp -d)"
RID=1
pass=0; fail=0
SRV=""; SRV_SPA=""

note() { printf '  %-9s %s\n' "$1" "$2"; }
check() { # check <label> <needle> <haystack>
  if grep -qF "$2" <<<"$3"; then note PASS "$1"; pass=$((pass+1));
  else note FAIL "$1"; echo "---- got: $3"; fail=$((fail+1)); fi
}
rpc() { curl -sf "http://127.0.0.1:$PORT/rpc" -H 'content-type: application/json' \
        -d "{\"id\":$RID,\"method\":\"$1\",\"params\":$2}"; RID=$((RID+1)); }

cleanup() {
  [[ -n "$SRV" ]] && kill "$SRV" 2>/dev/null || true
  [[ -n "$SRV_SPA" ]] && kill "$SRV_SPA" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== building daemon =="
( cd server && cargo build -q )

echo "== fake agent =="
mkdir -p "$TMP/fakebin"
cat > "$TMP/fakebin/fake-agent" <<'SH'
#!/usr/bin/env bash
# Deterministic stand-in for an AI agent CLI: ignores all args, prints a marker.
echo "FAKEAGENT-OUTPUT"
exit 0
SH
chmod +x "$TMP/fakebin/fake-agent"

cat > "$TMP/agents.toml" <<TOML
default_agent = "fake"

[[agents]]
name = "fake"
command = "$TMP/fakebin/fake-agent"
detect = ["--version"]
argv = []
enabled = true

[tasks.commit_message]
agent = "fake"
skill = ""
prompt = "Generate a conventional commit message for these changes."

[tasks.summarize_file]
agent = "fake"
skill = ""
prompt = "Summarize this file."

[tasks.review]
agent = "fake"
skill = ""
prompt = "Review this."

[tasks.comment]
agent = "fake"
skill = ""
prompt = "Reply to the comment."
TOML

echo "== scratch repo =="
R="$TMP/repo"; mkdir -p "$R"
git -C "$R" init -q; git -C "$R" config user.email e2e@example.com; git -C "$R" config user.name E2E
printf 'hello\nworld\n' > "$R/a.txt"; git -C "$R" add -A; git -C "$R" commit -qm "init"
printf 'hello\nCHANGED\n' > "$R/a.txt"; git -C "$R" add -A   # staged change

echo "== starting agent daemon on :$PORT =="
GITDAEMON_PORT=$PORT GITDAEMON_AGENTS_CONFIG="$TMP/agents.toml" PATH="$TMP/fakebin:$PATH" \
  "$BIN" >/tmp/opencode/gitdaemon-agent.log 2>&1 &
SRV=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done

echo "== agents & comments =="
AL="$(rpc agent.list '{}')"
check "agent.list.detect"    '"name":"fake"'     "$AL"
check "agent.list.available" '"available":true'  "$AL"

CMP="$(rpc agent.commit_message "{\"path\":\"$R\",\"staged\":true}")"
check "agent.commit_message" '"FAKEAGENT-OUTPUT"' "$CMP"

RV="$(rpc agent.review "{\"path\":\"$R\",\"target\":{\"kind\":\"file\",\"file\":\"a.txt\"}}")"
check "agent.review"         '"FAKEAGENT-OUTPUT"' "$RV"

CC="$(rpc comment.create "{\"path\":\"$R\",\"file\":\"a.txt\",\"body\":\"why changed?\"}")"
check "comment.created"      '"body":"why changed?"' "$CC"
check "comment.listed"       'why changed?'          "$(rpc comment.list "{\"path\":\"$R\"}")"
CID="$(sed -n 's/.*"id":"\([^"]*\)".*/\1/p' <<<"$CC")"
CS="$(rpc comment.send "{\"path\":\"$R\",\"id\":\"$CID\"}")"
check "comment.send.reply"   '"FAKEAGENT-OUTPUT"' "$CS"
check "comment.send.status"  '"status":"sent"'     "$CS"

echo "== SPA serve (GITDAEMON_SERVE_DIR) =="
mkdir -p "$TMP/site"
printf '<!doctype html><title>spa-index</title>OKSPA' > "$TMP/site/index.html"
GITDAEMON_PORT=$SPA_PORT GITDAEMON_SERVE_DIR="$TMP/site" "$BIN" >/tmp/opencode/gitdaemon-spa.log 2>&1 &
SRV_SPA=$!
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:$SPA_PORT/health" >/dev/null && break; sleep 0.2; done
check "spa.root"         'OKSPA'      "$(curl -s "http://127.0.0.1:$SPA_PORT/")"
check "spa.deepFallback" 'OKSPA'      "$(curl -s "http://127.0.0.1:$SPA_PORT/deep/route")"
check "spa.apiStillWorks" '"ok":true' "$(curl -s "http://127.0.0.1:$SPA_PORT/health")"

echo "== result: $pass passed, $fail failed =="
[[ $fail -eq 0 ]]
