#!/bin/sh
# Upserts every /workflows/*.json into n8n via the Public API (matched by workflow name).
set -eu
if [ -z "${N8N_API_KEY:-}" ]; then echo "Secret n8n-api-key not set - skipping workflow sync."; exit 0; fi
apk add --no-cache curl jq >/dev/null

H="X-N8N-API-KEY: ${N8N_API_KEY}"
api() { curl -sS --fail-with-body -H "$H" -H "Content-Type: application/json" "$@"; }

echo "Waiting for n8n API..."
i=0
until api "${N8N_API_URL}/workflows?limit=1" >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -ge 60 ] && { echo "n8n API not reachable"; exit 1; }
  sleep 5
done

# Collect all existing workflows (paginated)
existing='[]'; cursor=''
while :; do
  page=$(api "${N8N_API_URL}/workflows?limit=250${cursor:+&cursor=$cursor}")
  existing=$(printf '%s\n%s' "$existing" "$page" | jq -s '.[0] + .[1].data')
  cursor=$(echo "$page" | jq -r '.nextCursor // empty')
  [ -z "$cursor" ] && break
done

for f in /workflows/*.json; do
  [ -e "$f" ] || continue
  name=$(jq -r '.name' "$f")
  body=$(jq '{name, nodes, connections,
    settings: ((.settings // {}) | with_entries(select(.key | IN(
      "saveExecutionProgress","saveManualExecutions","saveDataErrorExecution",
      "saveDataSuccessExecution","executionTimeout","errorWorkflow",
      "timezone","executionOrder","callerPolicy"))))}' "$f")
  id=$(echo "$existing" | jq -r --arg n "$name" '[.[] | select(.name==$n)][0].id // empty')

  if [ -n "$id" ]; then
    echo "UPDATE  $name ($id)"
    echo "$body" | api -X PUT "${N8N_API_URL}/workflows/$id" -d @- >/dev/null
  else
    echo "CREATE  $name"
    id=$(echo "$body" | api -X POST "${N8N_API_URL}/workflows" -d @- | jq -r '.id')
  fi

  if [ "$(jq -r '.active // false' "$f")" = "true" ]; then
    api -X POST "${N8N_API_URL}/workflows/$id/activate" >/dev/null && echo "        activated"
  else
    api -X POST "${N8N_API_URL}/workflows/$id/deactivate" >/dev/null 2>&1 || true
  fi
done
echo "Workflow sync done."
