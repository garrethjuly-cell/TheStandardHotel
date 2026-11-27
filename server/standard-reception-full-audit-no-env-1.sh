#!/usr/bin/env bash
# Standard Reception staging audit for the code-initialized Firebase build.
# Read-only: does not deploy, restart, or modify the database or account data.
set -u
BASE_URL="https://staging.thestandardhotel.net"
EXPECTED_PROJECT="the-standard-test-reception"
EXPECTED_KEY="the-standard-test-reception-firebase-adminsdk-fbsvc-00c4a8a57a.json"
PASS=0; WARN=0; FAIL=0
TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT
ok(){ printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
warn(){ printf 'WARN  %s\n' "$1"; WARN=$((WARN+1)); }
fail(){ printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
section(){ printf '\n===== %s =====\n' "$1"; }

section '1. LIVE HTTPS AND HEALTH'
if command -v curl >/dev/null 2>&1; then
  CODE=$(curl -sS -L --max-redirs 3 -o "$TMP_DIR/health" -w '%{http_code}' "$BASE_URL/healthz" 2>/dev/null || true)
  FINAL_URL=$(curl -sS -L --max-redirs 3 -o /dev/null -w '%{url_effective}' "$BASE_URL/healthz" 2>/dev/null || true)
  if [ "$CODE" = 200 ] && grep -q '"status":"ok"' "$TMP_DIR/health"; then ok 'HTTPS health returns 200 and status=ok'; else fail "Health returned HTTP ${CODE:-no-response}"; fi
  case "$FINAL_URL" in https://staging.thestandardhotel.net/*) ok 'Health remains on staging hostname';; *) fail "Health redirected to $FINAL_URL";; esac
else fail 'curl unavailable'; fi

section '2. LIVE API ROUTE REACHABILITY'
probe(){ label="$1"; method="$2"; path="$3"; payload="${4-}"; out="$TMP_DIR/$label";
  if [ "$method" = GET ]; then code=$(curl -sS -o "$out" -w '%{http_code}' "$BASE_URL$path" 2>/dev/null || true)
  else code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data "$payload" "$BASE_URL$path" 2>/dev/null || true); fi
  case "$code" in 200|201|202) warn "$label returned $code unauthenticated; inspect response";; 400|401|403|405|422) ok "$label route exists (HTTP $code)";; 404) fail "$label is missing (HTTP 404)";; 5*) fail "$label returned HTTP $code";; *) warn "$label returned HTTP ${code:-no-response}";; esac
  printf '      '; head -c 180 "$out" 2>/dev/null | tr '\n' ' '; printf '\n'
}
probe dashboard GET /api/staff/dashboard
probe gateway-heartbeat POST /api/test/gateway/heartbeat '{}'
probe gateway-events POST /api/test/gateway/events '{}'

section '3. SOURCE AND NODE SYNTAX'
ROOT="$PWD"; if [ -f "$ROOT/server.js" ]; then SERVER_DIR="$ROOT"; elif [ -f "$ROOT/server/server.js" ]; then SERVER_DIR="$ROOT/server"; else SERVER_DIR=""; fi
if [ -z "$SERVER_DIR" ]; then fail 'server.js not found; run from server directory or its parent'; exit 2; fi
ok "Backend source found: $SERVER_DIR/server.js"
if command -v node >/dev/null 2>&1; then
  BAD=0; COUNT=0
  while IFS= read -r -d '' f; do COUNT=$((COUNT+1)); node --check "$f" >/dev/null 2>&1 || { echo "      syntax error: $f"; BAD=$((BAD+1)); }; done < <(find "$SERVER_DIR" -type f -name '*.js' -not -path '*/node_modules/*' -print0)
  [ "$BAD" -eq 0 ] && ok "Node syntax passed ($COUNT files)" || fail "$BAD JavaScript syntax errors"
else warn 'Node command unavailable; syntax not checked'; fi
for route in '/api/test/gateway/heartbeat' '/api/test/gateway/events' '/api/staff/dashboard'; do
  if grep -RqsF --exclude-dir=node_modules --include='*.js' "$route" "$SERVER_DIR"; then ok "Source contains $route"; else fail "Source missing $route"; fi
done
if grep -Rqs --exclude-dir=node_modules --include='*.js' 'MasterAcc' "$SERVER_DIR" && grep -Rqs --exclude-dir=node_modules --include='*.js' 'TestAcc' "$SERVER_DIR"; then ok 'Source references MasterAcc and TestAcc'; else fail 'Test-account allowlist not found'; fi

section '4. FIREBASE CODE-INITIALIZED CREDENTIAL CHECK'
PUSH_FILE="$SERVER_DIR/push-notifications.js"
if [ -f "$PUSH_FILE" ] && grep -qF "$EXPECTED_KEY" "$PUSH_FILE" && grep -qF "$EXPECTED_PROJECT" "$PUSH_FILE"; then
  ok 'Backend source explicitly initializes the dedicated test Firebase project from the fixed credential filename'
else
  fail 'Firebase source does not contain the expected no-environment-variable initialization';
fi
CRED="$SERVER_DIR/$EXPECTED_KEY"
if [ -f "$CRED" ]; then
  ok 'Firebase service-account file exists beside server.js'
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$CRED" "$EXPECTED_PROJECT" <<'PY'
import json,sys
p,expected=sys.argv[1:]
try:
    with open(p,encoding='utf-8') as f: d=json.load(f)
    good=d.get('project_id')==expected and bool(d.get('client_email')) and bool(d.get('private_key'))
except Exception: good=False
sys.exit(0 if good else 1)
PY
    if [ $? -eq 0 ]; then ok 'Credential JSON is valid and belongs to the dedicated test project'; else fail 'Credential JSON invalid, incomplete, or wrong Firebase project'; fi
  else warn 'python3 unavailable; credential JSON contents not validated'; fi
  if command -v stat >/dev/null 2>&1; then
    PERM=$(stat -c '%a' "$CRED" 2>/dev/null || true)
    case "$PERM" in 600|400) ok "Credential file permissions are restrictive ($PERM)";; *) warn "Credential file permissions are $PERM; use chmod 600 on the file";; esac
  fi
else fail "Firebase credential file not found at $CRED"; fi
if grep -qF 'GOOGLE_APPLICATION_CREDENTIALS' "$PUSH_FILE" 2>/dev/null; then warn 'Firebase source also references environment-based credentials; inspect precedence'; else ok 'Firebase initialization does not require GOOGLE_APPLICATION_CREDENTIALS'; fi

section '5. SUMMARY'
printf 'PASS=%s WARN=%s FAIL=%s\n' "$PASS" "$WARN" "$FAIL"
printf 'This audit made no deployment, database, account, or service changes.\n'
[ "$FAIL" -eq 0 ] || exit 2
[ "$WARN" -eq 0 ] || exit 1
exit 0
