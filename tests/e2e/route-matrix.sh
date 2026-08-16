#!/bin/bash
# Route-layer verification matrix for v0.5–v0.8 fields against a clean web
# instance. Prints PASS/FAIL per check and a summary.
BASE=http://127.0.0.1:3101/api/taskboard
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); echo "  PASS  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  <- $2"; }
check() { # check <name> <expected_status> <actual_status>
  if [ "$2" = "$3" ]; then ok "$1 (HTTP $3)"; else bad "$1" "expected $2 got $3"; fi
}
jq_field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null; }

echo '== v0.5 spec fields =='
# 1. POST without spec -> 201, status draft
R=$(curl -s -w '\n%{http_code}' -X POST $BASE/task -H 'content-type: application/json' -d '{"title":"R1 no spec"}')
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "POST no spec -> 201 draft" 201 "$CODE"
[ "$(echo "$BODY" | jq_field "['status']")" = "draft" ] && ok "no-spec task lands in draft" || bad "no-spec task status" "$(echo "$BODY" | jq_field "['status']")"

# 2. POST with criteria + open -> 201, status open
R=$(curl -s -w '\n%{http_code}' -X POST $BASE/task -H 'content-type: application/json' -d '{"title":"R2 specd","status":"open","acceptance_criteria":["c1","c2"],"context_refs":["src/a.ts"],"definition_of_done":"ship"}')
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "POST spec + open -> 201" 201 "$CODE"
[ "$(echo "$BODY" | jq_field "['status']")" = "open" ] && ok "spec'd task lands in open" || bad "spec'd status" "$(echo "$BODY" | jq_field "['status']")"
[ "$(echo "$BODY" | jq_field "['spec']['acceptanceCriteria']")" = "['c1', 'c2']" ] && ok "criteria stored" || bad "criteria" "$(echo "$BODY" | jq_field "['spec']")"
R2_ID=$(echo "$BODY" | jq_field "['id']")

echo '== v0.7 dependency & budget fields =='
# 3. POST depends_on + budget -> 201
R=$(curl -s -w '\n%{http_code}' -X POST $BASE/task -H 'content-type: application/json' -d "{\"title\":\"R3 worker\",\"status\":\"open\",\"acceptance_criteria\":[\"w\"],\"depends_on\":[\"$R2_ID\"],\"budget_tokens\":500}")
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "POST depends_on+budget -> 201" 201 "$CODE"
[ "$(echo "$BODY" | jq_field "['dependsOn']")" = "['$R2_ID']" ] && ok "dependsOn stored" || bad "dependsOn" "$(echo "$BODY" | jq_field "['dependsOn']")"
[ "$(echo "$BODY" | jq_field "['budgetTokens']")" = "500" ] && ok "budgetTokens stored" || bad "budgetTokens" "$(echo "$BODY" | jq_field "['budgetTokens']")"

# 4. PATCH move to open without spec -> 400
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"status":"open"}')
CODE=${R##*$'\n'}
check "PATCH to open without spec -> 400" 400 "$CODE"

# 5. PATCH spec partial (only context_refs), then move to open -> 200
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"acceptance_criteria":["ok"]}')
CODE=${R##*$'\n'}
check "PATCH add criteria -> 200" 200 "$CODE"
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"status":"open","expectedRevision":1}')
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "PATCH draft->open with spec -> 200" 200 "$CODE"
[ "$(echo "$BODY" | jq_field "['status']")" = "open" ] && ok "now open" || bad "status" "$(echo "$BODY" | jq_field "['status']")"

# 6. PATCH depends_on cycle (self) -> 400
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"depends_on":["TB-1"]}')
CODE=${R##*$'\n'}
check "PATCH self-dependency -> 400" 400 "$CODE"

# 7. PATCH budget clear (null) -> 200
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"budget_tokens":null}')
CODE=${R##*$'\n'}
check "PATCH budget null -> 200" 200 "$CODE"

echo '== v0.9 executor / dueAt / notes =='
# POST with executor/due_at/notes -> 201
R=$(curl -s -w '\n%{http_code}' -X POST $BASE/task -H 'content-type: application/json' -d '{"title":"R9 human","status":"open","acceptance_criteria":["h"],"executor":"human","due_at":1999999999000,"notes":"initial note"}')
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "POST executor+due_at+notes -> 201" 201 "$CODE"
[ "$(echo "$BODY" | jq_field "['executor']")" = "human" ] && ok "executor stored" || bad "executor" "$(echo "$BODY" | jq_field "['executor']")"
[ "$(echo "$BODY" | jq_field "['dueAt']")" = "1999999999000" ] && ok "dueAt stored" || bad "dueAt" "$(echo "$BODY" | jq_field "['dueAt']")"
[ "$(echo "$BODY" | jq_field "['notes']")" = "initial note" ] && ok "notes stored" || bad "notes" "$(echo "$BODY" | jq_field "['notes']")"
R9_KEY=$(echo "$BODY" | jq_field "['key']")
# PATCH note append (twice) on the SAME R9 task -> append not overwrite
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/$R9_KEY -H 'content-type: application/json' -d '{"note":"second"}')
CODE=${R##*$'\n'}
check "PATCH note append -> 200" 200 "$CODE"
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/$R9_KEY -H 'content-type: application/json' -d '{"note":"third"}')
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "PATCH note append again -> 200" 200 "$CODE"
printf '%s' "$BODY" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d['notes']=='initial note\nsecond\nthird', repr(d['notes'])" >/dev/null 2>&1 \
  && ok "notes appended" || bad "notes" "$(echo "$BODY" | jq_field "['notes']")"
# PATCH executor change -> 200
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/$R9_KEY -H 'content-type: application/json' -d '{"executor":"any"}')
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "PATCH executor -> 200" 200 "$CODE"
[ "$(echo "$BODY" | jq_field "['executor']")" = "any" ] && ok "executor changed" || bad "executor" "$(echo "$BODY" | jq_field "['executor']")"

echo '== status migrations & guards =='
# 8. claim + confirm done + evidence-free OK; stale revision -> 409
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"status":"in_progress","claimed_by_session_id":"route-test"}')
CODE=${R##*$'\n'}
check "PATCH claim -> 200" 200 "$CODE"
R=$(curl -s -w '\n%{http_code}' -X PATCH $BASE/task/TB-1 -H 'content-type: application/json' -d '{"status":"done","expectedRevision":1}')
CODE=${R##*$'\n'}
check "PATCH stale expectedRevision -> 409" 409 "$CODE"

echo '== reads =='
R=$(curl -s -w '\n%{http_code}' $BASE/task/TB-1)
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "GET task -> 200" 200 "$CODE"
for f in '["spec"]' '["dependsOn"]' '["budgetTokens"]' '["evidence"]'; do
  echo "$BODY" | jq_field "$f" >/dev/null 2>&1 && ok "GET carries $f" || bad "GET missing $f" "$f"
done
R=$(curl -s -w '\n%{http_code}' $BASE/task/TB-1/activity)
CODE=${R##*$'\n'}
check "GET activity -> 200" 200 "$CODE"
R=$(curl -s -w '\n%{http_code}' $BASE/board)
CODE=${R##*$'\n'}; BODY=${R%$'\n'*}
check "GET board -> 200" 200 "$CODE"
echo "$BODY" | jq_field "['workspaces']" >/dev/null 2>&1 && ok "board carries workspaces" || bad "board workspaces" "missing"
R=$(curl -s -w '\n%{http_code}' -X POST $BASE/task -H 'content-type: text/plain' -d '{"title":"x"}')
CODE=${R##*$'\n'}
check "CSRF 415 still enforced" 415 "$CODE"

echo
echo "ROUTE-MATRIX: $PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
