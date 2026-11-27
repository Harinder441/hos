#!/usr/bin/env bash
# Hand a hos chat off by hand: hos queues it until the chat is quiet (turn over, no subagents, no busy child chats), then runs it.
set -euo pipefail
usage="usage: handoff-chat.sh <chatId or 8-char prefix> [--salvage]"
chat="${1:?$usage}"
mode=write
[ "${2:-}" = --salvage ] && mode=salvage
url="${HOS_URL:-http://127.0.0.1:4517}"
token_file="${HOS_DATA_DIR:-$HOME/.hos}/local-ops.token"
[ -r "$token_file" ] || { echo "no $token_file; is hos running on this Mac?" >&2; exit 1; }
token="$(tr -d '[:space:]' <"$token_file")"
endpoint="$url/local/chats/$chat/handoff"

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];console.log(v===null||v===undefined?"":v)})' "$1"; }

reply="$(curl -sS -X POST -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "{\"mode\":\"$mode\"}" -w '\n%{http_code}' "$endpoint")"
code="${reply##*$'\n'}"
body="${reply%$'\n'*}"
if [ "$code" != 200 ]; then
  echo "hos refused ($code): $(printf '%s' "$body" | field error)" >&2
  exit 1
fi
if [ "$(printf '%s' "$body" | field queued)" = true ]; then
  echo "handoff queued: it runs once the chat is quiet ($(printf '%s' "$body" | field reason))"
else
  echo "handoff started"
fi

for _ in $(seq "${HANDOFF_WAIT_S:-900}"); do
  status="$(curl -sS -H "Authorization: Bearer $token" "$endpoint")"
  successor="$(printf '%s' "$status" | field successorId)"
  if [ -n "$successor" ]; then
    echo "successor $successor booted"
    exit 0
  fi
  sleep 1
done
echo "no successor yet; check again with: curl -H 'Authorization: Bearer …' $endpoint" >&2
exit 2
