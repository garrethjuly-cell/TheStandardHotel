#!/usr/bin/env bash
# Standard Reception staging audit. Read-only: no deployment, DB writes, account changes, or service restart.
set -u
BASE_URL="https://staging.thestandardhotel.net"
PASS=0; WARN=0; FAIL=0
TMP_DIR="$(mktemp -d)"
cleanup(){ rm -rf "$TMP_DIR"; }
trap cleanup EXIT
ok(){ printf 'PASS  %s\n' "$1"; PASS=$((PASS+1)); }
warn(){ printf 'WARN  %s\n' "$1"; WARN=$((WARN+1)); }
fail(){ printf 'FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
section(){ printf '\n===== %s =====\n' "$1"; }

section '1. LIVE HTTPS AND HEALTH'
if command -v curl >/dev/null 2>&1; then
  CODE=$(curl -sS -L --max-redirs 3 -o "$TMP_DIR/health" -w '%{http_code}' "$BASE_URL/healthz" 2>"$TMP_DIR/curlerr" || true)
  FINAL_URL=$(curl -sS -L --max-redirs 3 -o /dev/null -w '%{url_effective}' "$BASE_URL/healthz" 2>/dev/null || true)
  if [ "$CODE" = 200 ] && grep -q '"status":"ok"' "$TMP_DIR/health"; then ok "HTTPS health endpoint returns HTTP 200 and status=ok"; else fail "Health endpoint returned HTTP ${CODE:-no-response}; inspect curl/hosting logs"; fi
  case "$FINAL_URL" in https://staging.thestandardhotel.net/*) ok 'Health request remains on the staging HTTPS hostname';; *) fail "Health request redirected elsewhere: $FINAL_URL";; esac
else fail 'curl is unavailable'; fi

section '2. API ROUTE REACHABILITY (unauthenticated, empty payloads only)'
probe(){ label="$1"; method="$2"; path="$3"; data="${4-}"; out="$TMP_DIR/probe_$label"; err="$TMP_DIR/probe_${label}_err";
  if [ "$method" = GET ]; then code=$(curl -sS -o "$out" -w '%{http_code}' "$BASE_URL$path" 2>"$err" || true)
  else code=$(curl -sS -o "$out" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' --data "$data" "$BASE_URL$path" 2>"$err" || true); fi
  case "$code" in
    200|201|202) warn "$label returned HTTP $code without credentials; inspect response before interpreting";;
    400|401|403|405|422) ok "$label route is present (HTTP $code; validation/authentication applied)";;
    404) fail "$label route is missing (HTTP 404)";;
    5*) fail "$label returned server error HTTP $code";;
    *) warn "$label returned HTTP ${code:-no-response}; inspect hosting logs";;
  esac
  printf '      response: '; head -c 240 "$out" 2>/dev/null | tr '\n' ' '; printf '\n'
}
probe 'dashboard' GET '/api/staff/dashboard'
probe 'gateway-heartbeat' POST '/api/test/gateway/heartbeat' '{}'
probe 'gateway-events' POST '/api/test/gateway/events' '{}'

section '3. DEPLOYED SOURCE AND NODE SYNTAX'
ROOT="$PWD"
if [ -f "$ROOT/server.js" ]; then SERVER_DIR="$ROOT"; elif [ -f "$ROOT/server/server.js" ]; then SERVER_DIR="$ROOT/server"; else SERVER_DIR=""; fi
if [ -z "$SERVER_DIR" ]; then fail 'Could not find server.js in current directory or ./server/; run from Node application root';
else
  ok "Found backend source at $SERVER_DIR/server.js"
  if command -v node >/dev/null 2>&1; then
    BAD=0; COUNT=0
    while IFS= read -r -d '' f; do COUNT=$((COUNT+1)); node --check "$f" >/dev/null 2>&1 || { printf '      syntax error: %s\n' "$f"; BAD=$((BAD+1)); }; done < <(find "$SERVER_DIR" -type f -name '*.js' -not -path '*/node_modules/*' -not -name '*.backup*' -print0)
    if [ "$BAD" -eq 0 ]; then ok "Node syntax passed for $COUNT JavaScript files"; else fail "$BAD JavaScript syntax error(s) found"; fi
  else warn 'Node.js command unavailable'; fi
  ALL="$TMP_DIR/source.txt"; grep -RhoE --exclude-dir=node_modules --exclude='*.backup*' --include='*.js' --include='*.json' '/api/test/gateway/heartbeat|/api/test/gateway/events|/api/staff/dashboard|MasterAcc|TestAcc' "$SERVER_DIR" 2>/dev/null | sort -u > "$ALL" || true
  for needle in '/api/test/gateway/heartbeat' '/api/test/gateway/events' '/api/staff/dashboard'; do if grep -Fq "$needle" "$ALL"; then ok "Source contains $needle"; else fail "Deployed source does not contain $needle"; fi; done
  if grep -Rqs --exclude-dir=node_modules --exclude='*.backup*' --include='*.js' 'MasterAcc' "$SERVER_DIR" && grep -Rqs --exclude-dir=node_modules --exclude='*.backup*' --include='*.js' 'TestAcc' "$SERVER_DIR"; then ok 'Source references both permitted test accounts'; else fail 'Could not verify both MasterAcc and TestAcc in source'; fi

  section '4. FIREBASE SERVER CREDENTIAL SAFETY'
  # Read only the two expected values from .env when shell variables are not exported. Never print credential contents.
  read_dotenv(){ [ -f "$SERVER_DIR/.env" ] && sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SERVER_DIR/.env" | tail -n 1 | tr -d '\\r' || true; }
  PROJECT="${FIREBASE_PROJECT_ID:-}"; [ -n "$PROJECT" ] || PROJECT="$(read_dotenv FIREBASE_PROJECT_ID)"
  if [ "$PROJECT" = 'the-standard-test-reception' ]; then ok 'FIREBASE_PROJECT_ID is set to the dedicated test project'; else fail 'FIREBASE_PROJECT_ID is missing or not the-standard-test-reception'; fi
  CRED="${GOOGLE_APPLICATION_CREDENTIALS:-}"; [ -n "$CRED" ] || CRED="$(read_dotenv GOOGLE_APPLICATION_CREDENTIALS)"
  if [ -n "$CRED" ] && [ -f "$CRED" ]; then
    case "$CRED" in "$ROOT"/public/*|"$ROOT"/public_html/*|*/public_html/*|*/htdocs/*) fail 'Firebase credential appears inside a public web directory';;
      *) ok 'Firebase credential file exists outside common public web directories';; esac
    if command -v node >/dev/null 2>&1; then
      node -e 'const fs=require("fs");let x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(x.project_id==="the-standard-test-reception"?0:2)' "$CRED" >/dev/null 2>&1 && ok 'Firebase service-account project_id matches the test project' || fail 'Firebase service-account JSON is invalid or belongs to a different project'
    fi
  else fail 'GOOGLE_APPLICATION_CREDENTIALS does not point to an existing service-account file'; fi
  if grep -Rqs --exclude-dir=node_modules --exclude='*.backup*' --include='*.js' 'private-config/firebase-service-account.json' "$SERVER_DIR"; then warn 'Source still contains a fixed private-config credential path; confirm deployed code prioritizes GOOGLE_APPLICATION_CREDENTIALS'; fi
fi

section '5. SUMMARY'
printf 'PASS=%s  WARN=%s  FAIL=%s\n' "$PASS" "$WARN" "$FAIL"
printf 'No files, database records, accounts, or running services were changed by this audit.\n'
if [ "$FAIL" -gt 0 ]; then exit 2; elif [ "$WARN" -gt 0 ]; then exit 1; else exit 0; fi
