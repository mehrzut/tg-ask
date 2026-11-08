# tg-ask

Answer Claude Code's questions from Telegram.

When a Claude Code session needs a decision from you, it asks in the session **and** on Telegram at the same time. Answer wherever you are; the first answer wins and the other copy closes itself.

```
❓ Claude · my-project

Deploy to staging or production?

1. Staging
2. Production

Tap an option, or type any answer in your own words.
```

- Tap an option, or type a free answer ("staging, but skip the migrations"). A bare number such as `2` picks that option.
- If you answer in the session instead, the Telegram message is marked "✓ Answered on your computer".
- Several sessions can ask at once. With more than one question open, tap a button or reply to the question you mean.

## How it works

```
Claude Code ── tg-ask ──▶ relay (Cloudflare Worker) ──▶ Telegram bot ──▶ your phone
                 ▲                                                            │
                 └──────────────── your answer ◀──────────────────────────────┘
```

One bot serves a whole team. Each computer gets its own key when it connects, and each person only ever sees their own questions. The bot token lives only in the Worker. The computers talk to the Worker, never to Telegram.

- `tg_ask.py` is the client (Python 3.8+, standard library only).
- `telegram-ask.md` holds the instructions Claude follows. The installer loads them into every session through your global `~/.claude/CLAUDE.md`.
- `worker/` is the relay: a Cloudflare Worker with a D1 database. It has no dependencies, and the free plan is enough for a team.

## Run it with your own bot

You need a Cloudflare account (free), Node.js 18+, Python 3 and a Telegram bot.

1. In [@BotFather](https://t.me/BotFather), send `/newbot` and copy the token.
2. Clone this repo and run:

   ```bash
   ./worker/deploy.sh
   ```

   It logs in to Cloudflare, creates the database, deploys the Worker, asks for the bot token once and points the bot at the Worker. At the end it prints the install command with your relay URL and an invite code.
3. Run that install command on your computer, then share it with your team.

Re-running `deploy.sh` is safe. It redeploys the code and re-points the webhook. Your database ID and secrets stay in git-ignored files (`worker/wrangler.toml`, `worker/.relay/`).

## Install on a computer

```bash
curl -fsSL https://raw.githubusercontent.com/mehrzut/tg-ask/main/install.sh | bash -s -- --relay <RELAY_URL> --invite <INVITE_CODE>
```

Or from a clone: `./install.sh --relay <RELAY_URL> --invite <INVITE_CODE>`. If you deploy from a fork, `deploy.sh` prints a command that downloads from your fork.

The installer:
- puts `tg-ask` in `~/.local/bin`,
- copies `telegram-ask.md` to `~/.claude/` and imports it from `~/.claude/CLAUDE.md`,
- prints a link: open it and press **Start** in Telegram to connect.

It works on macOS, Linux and Windows (Git Bash, which Claude Code uses there). Open a new Claude Code session afterwards so it loads the instructions.

## Commands

```bash
tg-ask ask "Question" -o "Option 1" -o "Option 2"   # prints ANSWER: <text> | NO_ANSWER | CANCELLED
tg-ask cancel                                       # answered in the session: close the Telegram copy
tg-ask status                                       # show the connection
tg-ask setup --relay URL --invite CODE              # connect again
```

Exit codes for `ask`: `0` answered, `2` no answer (it expires after 4 hours by default, see `--timeout`), `3` cancelled.

## Privacy

- Questions are stored only while they're open. The text is blanked when a question closes, and the row is deleted once the asking computer has read the answer. An hourly cleanup removes anything left over.
- Whoever runs the Worker owns the Cloudflare account and the bot, so they could read open questions. Run your own if that matters to you.
- Anyone with the invite code can connect their own Telegram, but they only ever see their own questions. To change the code, delete `worker/.relay/invite-code` and run `deploy.sh` again. Computers that are already connected keep working.
- To disconnect a computer, delete its row from the `users` table:
  `npx wrangler d1 execute tg-ask --remote --command "SELECT name, created_at FROM users"`

## Develop

```bash
cd worker && npm install && ./test/run.sh
```

The test runs the Worker locally against a fake Telegram and drives the real client end to end.

## Uninstall

```bash
rm ~/.local/bin/tg-ask ~/.claude/telegram-ask.md
rm -r ~/.local/share/tg-ask ~/.claude/channels/tg-ask
```

Then remove the `@~/.claude/telegram-ask.md` section from `~/.claude/CLAUDE.md`.

## License

[MIT](LICENSE)
