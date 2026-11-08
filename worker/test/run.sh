#!/usr/bin/env bash
# End-to-end test: runs the Worker locally (wrangler dev, local D1) against a
# fake Telegram, and drives the real client through every flow.
#
#   cd worker && npm install && ./test/run.sh
set -u
cd "$(dirname "$0")/.."
WORKER="$PWD"
CLIENT="python3 -I $WORKER/../tg_ask.py"
TG_PORT=8799
RELAY_PORT=8788
R="http://127.0.0.1:$RELAY_PORT"
TMP="$(mktemp -d)"
LOG="$TMP/telegram.log"
WRANGLER=(npx wrangler --config wrangler.example.toml)

cleanup() {
  kill "$FAKE_PID" "$DEV_PID" 2>/dev/null
  pkill -f "wrangler dev .*--port $RELAY_PORT" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

touch "$LOG"
python3 -I test/fake_telegram.py "$LOG" "$TG_PORT" &
FAKE_PID=$!
"${WRANGLER[@]}" d1 execute tg-ask --local --persist-to "$TMP/state" --file schema.sql >/dev/null 2>&1
"${WRANGLER[@]}" dev --local --persist-to "$TMP/state" --port "$RELAY_PORT" \
  --var "TELEGRAM_API:http://127.0.0.1:$TG_PORT" --var BOT_TOKEN:fake \
  --var WEBHOOK_SECRET:hooksecret --var INVITE_CODE:inv123 >"$TMP/dev.log" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 60); do curl -s -o /dev/null "$R/" && break; sleep 1; done

export HOME="$TMP/home"
mkdir -p "$HOME/work" "$HOME/other"
cd "$HOME/work"

pass=0
fail=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; pass=$((pass + 1)); else echo "FAIL $1: got [$2] want [$3]"; fail=$((fail + 1)); fi
}
hook() { curl -s -X POST -H 'X-Telegram-Bot-Api-Secret-Token: hooksecret' -H 'content-type: application/json' -d "$1" "$R/telegram" >/dev/null; }
msg() { hook "{\"update_id\":$RANDOM,\"message\":{\"message_id\":$RANDOM,\"chat\":{\"id\":555,\"type\":\"private\"},\"from\":{\"id\":${2:-777},\"first_name\":\"Test\"},\"text\":\"$1\"${3:-}}}"; }
tap() { hook "{\"update_id\":$RANDOM,\"callback_query\":{\"id\":\"cb$RANDOM\",\"from\":{\"id\":${2:-777}},\"data\":\"$1\"}}"; }
last() { grep "\"$1\"" "$LOG" | tail -1; }
last_button() { # callback_data of option $1 on the last question sent
  last sendMessage | python3 -c "import json,sys; print(json.loads(sys.stdin.read())['params']['reply_markup']['inline_keyboard'][$1][0]['callback_data'])"
}
message_id_of() { # Telegram message id of the question containing $1
  python3 - "$LOG" "$1" <<'PY'
import json, sys
n = 100
for line in open(sys.argv[1]):
    e = json.loads(line)
    if e["method"] == "sendMessage":
        n += 1
        if sys.argv[2] in e["params"]["text"]:
            print(n)
PY
}

# Rejections
check "wrong invite" "$(curl -s -X POST -d '{"invite":"no"}' "$R/pair")" '{"error":"wrong invite code"}'
check "wrong webhook secret" "$(curl -s -X POST -H 'X-Telegram-Bot-Api-Secret-Token: no' -d '{}' "$R/telegram")" "forbidden"
check "not set up" "$($CLIENT ask hi 2>&1)" 'tg-ask: not set up: run `tg-ask setup --relay URL --invite CODE`'

# Setup: the link's /start code pairs this computer
$CLIENT setup --relay "$R" --invite inv123 >setup.out 2>&1 &
SP=$!
for _ in $(seq 1 20); do grep -q 'start=' setup.out && break; sleep 0.5; done
msg "/start $(grep -o 'start=[a-z0-9]*' setup.out | cut -d= -f2)"
wait $SP
check "setup" "$(tail -1 setup.out)" "tg-ask: connected to @testbot as Test"
check "status" "$($CLIENT status | tail -1)" "connected as: Test"

# Tapping an option
$CLIENT ask "Pick one" -o Alpha -o Beta >a1.out &
P=$!; sleep 2
check "options hint" "$(last sendMessage | grep -o 'Tap an option, or type any answer in your own words.')" "Tap an option, or type any answer in your own words."
tap "$(last_button 1)" 999
check "stranger's tap refused" "$(last answerCallbackQuery | grep -o 'This question is closed.')" "This question is closed."
tap "$(last_button 1)"
wait $P
check "tap answers" "$(cat a1.out)" "ANSWER: Beta"
check "tap acknowledged" "$(last answerCallbackQuery | grep -o 'Got you!')" "Got you!"
check "message shows answer" "$(last editMessageText | grep -o '✓ Beta')" "✓ Beta"
check "hint removed on close" "$(last editMessageText | grep -c 'Tap an option')" "0"

# Typing: a bare number picks the option, anything else is a free answer
$CLIENT ask "Second" -o One -o Two >a2.out &
P=$!; sleep 2; msg "2"; wait $P
check "typed number" "$(cat a2.out)" "ANSWER: Two"
$CLIENT ask "Which way?" -o Left -o Right >a3.out &
P=$!; sleep 2; msg "Neither, go straight"; wait $P
check "free text on options" "$(cat a3.out)" "ANSWER: Neither, go straight"
$CLIENT ask "Anything to add?" >a4.out &
P=$!; sleep 2
check "free-question hint" "$(last sendMessage | grep -o 'Type your answer.')" "Type your answer."
msg "No"; wait $P
check "free answer" "$(cat a4.out)" "ANSWER: No"

# Two open questions: plain text is ambiguous, a reply picks one
$CLIENT ask "Q-A" >a5.out &
PA=$!; sleep 2
(cd "$HOME/other" && $CLIENT ask "Q-B" >"$HOME/work/a6.out") &
PB=$!; sleep 2
msg "hello"
check "ambiguous text refused" "$(last sendMessage | grep -o '2 questions are open')" "2 questions are open"
msg "for A" 777 ",\"reply_to_message\":{\"message_id\":$(message_id_of Q-A)}"
wait $PA
check "reply picks the question" "$(cat a5.out)" "ANSWER: for A"

# cancel closes the question asked from the current directory
(cd "$HOME/other" && $CLIENT cancel >/dev/null)
wait $PB
check "cancel" "$(cat a6.out)" "CANCELLED"
check "cancel note" "$(last editMessageText | grep -o 'Answered on your computer')" "Answered on your computer"
check "nothing left to cancel" "$($CLIENT cancel)" "tg-ask: nothing pending"

# Stopping the waiter without cancel closes it too
$CLIENT ask "Killed" >a7.out &
P=$!; sleep 2; kill $P; wait $P
check "stopped waiter" "$(cat a7.out)" "CANCELLED"
check "stopped waiter closes message" "$(last editMessageText | grep -o 'Killed')" "Killed"

msg "late"
check "nothing waiting" "$(last sendMessage | grep -o 'Nothing is waiting')" "Nothing is waiting"
msg "who are you" 999
check "strangers ignored" "$(last sendMessage | grep -c 'who are you')" "0"

check "setup-webhook needs the secret" "$(curl -s -X POST -H 'Authorization: Bearer no' "$R/setup-webhook")" '{"error":"forbidden"}'

echo "== $pass passed, $fail failed"
[ "$fail" -eq 0 ]
