# Ask on Telegram too (`tg-ask`)

When you need a decision or answer from the user, ask in this session AND on Telegram at the same time, and carry on with whichever answer comes first.

Skip this when you are a subagent, or when the session itself is a Telegram channel session (started with `--channels`). There, ask through the channel's `reply` tool instead.

1. Start the Telegram copy with Bash `run_in_background: true`:
   `tg-ask ask "<question>" -o "<option 1>" -o "<option 2>"`
   Options are optional. The user can also type a free answer.
2. In the same response, ask the same question here in plain text with the same numbered options, then end your turn. Do NOT use AskUserQuestion for it: its dialog blocks the session, so a Telegram answer could not get through.
3. Telegram answers first: the background task finishes with `ANSWER: <text>`. Say in one line that it was answered on Telegram, then continue with that answer. The bot has already told them "Got you!".
4. The user answers here first: run `tg-ask cancel` before anything else (it marks the Telegram question "Answered on your computer" and stops the waiter), then continue.
5. `NO_ANSWER`, or `tg-ask` reports "not set up" or an error: just wait for the answer here.

Only one question per session can be pending at a time. If you need a new one while one is open, run `tg-ask cancel` first.
