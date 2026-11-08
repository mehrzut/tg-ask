#!/usr/bin/env bash
# Deploys your own tg-ask relay to Cloudflare (the free plan is enough) and
# points your Telegram bot at it.
#
#   ./worker/deploy.sh
#
# First run: logs in to Cloudflare, creates the database, asks for your bot
# token (from @BotFather), then prints the install command for you and your team.
# Re-running is safe: it redeploys the code and re-points the webhook.
set -euo pipefail
cd "$(dirname "$0")"
state=.relay # git-ignored: the webhook secret and the team invite code

say() { printf '\n▸ %s\n' "$*"; }
for tool in node npm curl python3; do
  command -v "$tool" >/dev/null || { echo "deploy.sh needs $tool" >&2; exit 1; }
done

say "Installing wrangler"
npm install --silent --no-fund --no-audit

if ! npx wrangler whoami 2>/dev/null | grep -q 'You are logged in'; then
  say "Logging in to Cloudflare"
  npx wrangler login
fi

[ -f wrangler.toml ] || cp wrangler.example.toml wrangler.toml
db_id() {
  npx wrangler d1 list --json 2>/dev/null |
    python3 -c 'import json,sys; print(next((d["uuid"] for d in json.load(sys.stdin) if d["name"] == "tg-ask"), ""))'
}
if grep -q 'REPLACE_ME' wrangler.toml; then
  say "Creating the database"
  id=$(db_id)
  if [ -z "$id" ]; then
    npx wrangler d1 create tg-ask >/dev/null
    id=$(db_id)
  fi
  python3 - "$id" <<'PY'
import pathlib, re, sys
p = pathlib.Path("wrangler.toml")
p.write_text(re.sub(r'database_id = "REPLACE_ME".*', f'database_id = "{sys.argv[1]}"', p.read_text()))
PY
fi
out=$(npx wrangler d1 execute tg-ask --remote --file schema.sql --yes 2>&1) || { echo "$out"; exit 1; }

say "Deploying"
out=$(npx wrangler deploy 2>&1) || { echo "$out"; exit 1; }
url=$(printf '%s\n' "$out" | grep -o 'https://[a-z0-9.-]*\.workers\.dev' | head -1)
[ -n "$url" ] || { echo "$out"; echo "Couldn't find the workers.dev URL above." >&2; exit 1; }

say "Checking secrets"
mkdir -p "$state" && chmod 700 "$state"
secrets=$(npx wrangler secret list 2>/dev/null || echo '[]')
put() { printf '%s' "$2" | npx wrangler secret put "$1" >/dev/null; }
if ! grep -q '"BOT_TOKEN"' <<<"$secrets"; then
  read -rsp "Bot token from @BotFather: " token
  echo
  put BOT_TOKEN "$token"
fi
for spec in webhook-secret:WEBHOOK_SECRET:32 invite-code:INVITE_CODE:18; do
  IFS=: read -r file name bytes <<<"$spec"
  if [ ! -s "$state/$file" ] || ! grep -q "\"$name\"" <<<"$secrets"; then
    python3 -c "import secrets; print(secrets.token_urlsafe($bytes))" >"$state/$file"
    chmod 600 "$state/$file"
    put "$name" "$(tr -d '\n' <"$state/$file")"
  fi
done

say "Pointing the bot at $url"
curl -fsS -X POST -H "Authorization: Bearer $(tr -d '\n' <"$state/webhook-secret")" "$url/setup-webhook"
echo

# The install one-liner downloads from this repo's GitHub, if it has one.
invite=$(tr -d '\n' <"$state/invite-code")
raw=$(git config --get remote.origin.url 2>/dev/null |
  sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+)/([^/.]+)(\.git)?$#https://raw.githubusercontent.com/\2/\3/main#p' || true)
say "Done. Install tg-ask on each computer (yours too):"
if [ -n "$raw" ]; then
  echo "  curl -fsSL $raw/install.sh | TG_ASK_SRC=$raw bash -s -- --relay $url --invite $invite"
fi
echo "  or from a clone of this repo: ./install.sh --relay $url --invite $invite"
echo
echo "Anyone with the invite code can connect their own Telegram. To change it,"
echo "delete $PWD/$state/invite-code and run deploy.sh again."
