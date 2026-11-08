#!/usr/bin/env python3
"""tg-ask: ask on Telegram from any Claude Code session; the first answer wins.

The question goes to your phone through the team's ask bot while the same
question waits in the session's own chat. A Telegram answer is printed here (so
the session carries on); an answer in the chat closes the Telegram question via
`tg-ask cancel`.

Your computer never talks to Telegram. It talks to the team's relay (a
Cloudflare Worker) with a personal key that `tg-ask setup` creates, so the bot
token stays on the relay and you only ever see your own questions.

  tg-ask setup --relay URL --invite CODE   connect this computer to your Telegram
  tg-ask ask "Question" [-o OPTION]... [--from LABEL] [--timeout SECONDS]
        stdout: "ANSWER: <text>" (exit 0) | "NO_ANSWER" (exit 2) | "CANCELLED" (exit 3)
  tg-ask cancel [--note TEXT] [--id ID]    answered elsewhere: close the question, stop the waiter
  tg-ask status                            show the connection
"""
import argparse
import json
import os
import signal
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "2.0"
DIR = Path.home() / ".claude" / "channels" / "tg-ask"
CONFIG_FILE = DIR / "config.json"
PENDING_DIR = DIR / "pending"
ANSWERED_HERE = "Answered on your computer"
NETWORK_ERRORS = (urllib.error.URLError, TimeoutError, ConnectionError, OSError)


class RelayError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def die(msg, code=1):
    print(f"tg-ask: {msg}", file=sys.stderr)
    sys.exit(code)


def load_config():
    try:
        cfg = json.loads(CONFIG_FILE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        cfg = {}
    if not cfg.get("relay") or not cfg.get("key"):
        die("not set up: run `tg-ask setup --relay URL --invite CODE`")
    return cfg


def save_config(cfg):
    DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg))
    os.chmod(tmp, 0o600)
    os.replace(tmp, CONFIG_FILE)


def call(cfg, method, path, body=None, timeout=30):
    headers = {"Content-Type": "application/json", "User-Agent": f"tg-ask/{VERSION}"}
    if cfg.get("key"):
        headers["Authorization"] = f"Bearer {cfg['key']}"
    req = urllib.request.Request(
        cfg["relay"].rstrip("/") + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get("error") or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}"
        raise RelayError(e.code, msg) from None


def cmd_setup(a):
    relay = a.relay.rstrip("/")
    try:
        res = call({"relay": relay}, "POST", "/pair", {"invite": a.invite})
    except RelayError as e:
        die(e)
    except NETWORK_ERRORS as e:
        die(f"can't reach {relay}: {e}")
    cfg = {"relay": relay, "key": res["key"]}
    save_config(cfg)
    print(f"Open this link and press Start in Telegram:\n\n  {res['link']}\n", flush=True)
    print("Waiting...", file=sys.stderr, flush=True)
    deadline = time.time() + min(a.timeout, res.get("expires_in", 900))
    while time.time() < deadline:
        try:
            me = call(cfg, "GET", "/me")
            if me.get("paired"):
                print(f"tg-ask: connected to @{me['bot']} as {me['name']}")
                return
        except RelayError as e:
            die(e)
        except NETWORK_ERRORS:
            pass
        time.sleep(3)
    die("timed out waiting for Start: run setup again", 2)


def cmd_status(_a):
    cfg = load_config()
    try:
        me = call(cfg, "GET", "/me")
    except RelayError as e:
        die(e)
    except NETWORK_ERRORS as e:
        die(f"can't reach {cfg['relay']}: {e}")
    if me.get("paired"):
        print(f"relay: {cfg['relay']}\nbot: @{me['bot']}\nconnected as: {me['name']}")
    else:
        print("not connected yet: open the setup link, or run setup again")


def cmd_ask(a):
    cfg = load_config()
    try:
        qid = call(
            cfg,
            "POST",
            "/ask",
            {"question": a.question, "options": a.option or [], "from": a.from_label, "timeout": a.timeout},
        )["id"]
    except RelayError as e:
        die(e)
    except NETWORK_ERRORS as e:
        die(f"can't reach the relay: {e}")

    deadline = time.time() + a.timeout
    PENDING_DIR.mkdir(mode=0o700, parents=True, exist_ok=True)
    pending = PENDING_DIR / f"{qid}.json"
    pending.write_text(
        json.dumps({"id": qid, "pid": os.getpid(), "cwd": os.getcwd(), "started": time.time(), "deadline": deadline})
    )

    def finish(line, code):
        pending.unlink(missing_ok=True)
        print(line, flush=True)
        sys.exit(code)

    def stopped(*_):
        # Killed without `tg-ask cancel` (e.g. the session stopped the task): close it here.
        if pending.exists():
            try:
                call(cfg, "POST", f"/q/{qid}/cancel", {"note": ANSWERED_HERE}, timeout=10)
            except Exception:
                pass
        finish("CANCELLED", 3)

    for name in ("SIGTERM", "SIGINT", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), stopped)

    while time.time() < deadline:
        try:
            res = call(cfg, "GET", f"/q/{qid}/wait", timeout=60)
        except RelayError as e:
            if e.status in (401, 404):
                finish("NO_ANSWER", 2)
            print(f"tg-ask: {e}; retrying", file=sys.stderr)
            time.sleep(5)
            continue
        except NETWORK_ERRORS as e:
            print(f"tg-ask: {e}; retrying", file=sys.stderr)
            time.sleep(5)
            continue
        status = res.get("status")
        if status == "answered":
            finish(f"ANSWER: {res.get('answer') or ''}", 0)
        if status == "cancelled":
            finish("CANCELLED", 3)
        if status in ("expired", "gone"):
            finish("NO_ANSWER", 2)

    try:
        call(cfg, "POST", f"/q/{qid}/expire", {}, timeout=15)
    except Exception:
        pass
    finish("NO_ANSWER", 2)


def cmd_cancel(a):
    cfg = load_config()
    now = time.time()
    items = []
    for f in PENDING_DIR.glob("*.json"):
        try:
            p = json.loads(f.read_text())
        except (OSError, json.JSONDecodeError):
            f.unlink(missing_ok=True)
            continue
        if p.get("deadline", 0) < now:
            f.unlink(missing_ok=True)  # its waiter is long gone
            continue
        items.append(p)
    if a.id:
        items = [p for p in items if p["id"] == a.id]
    else:
        items = [p for p in items if p.get("cwd") == os.getcwd()] or items
    if not items:
        print("tg-ask: nothing pending")
        return
    p = max(items, key=lambda p: p.get("started", 0))
    (PENDING_DIR / f"{p['id']}.json").unlink(missing_ok=True)  # tells the waiter not to close it again
    try:
        call(cfg, "POST", f"/q/{p['id']}/cancel", {"note": a.note}, timeout=15)
    except Exception as e:
        print(f"tg-ask: could not close it on Telegram: {e}", file=sys.stderr)
    try:
        os.kill(p["pid"], signal.SIGTERM)
    except OSError:
        pass
    print("tg-ask: question closed")


def main():
    ap = argparse.ArgumentParser(prog="tg-ask", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=f"tg-ask {VERSION}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup")
    s.add_argument("--relay", required=True)
    s.add_argument("--invite", required=True)
    s.add_argument("--timeout", type=int, default=900)
    s.set_defaults(fn=cmd_setup)
    q = sub.add_parser("ask")
    q.add_argument("question")
    q.add_argument("-o", "--option", action="append")
    q.add_argument("--from", dest="from_label", default=Path.cwd().name)
    q.add_argument("--timeout", type=int, default=4 * 3600)
    q.set_defaults(fn=cmd_ask)
    c = sub.add_parser("cancel")
    c.add_argument("--note", default=ANSWERED_HERE)
    c.add_argument("--id")
    c.set_defaults(fn=cmd_cancel)
    st = sub.add_parser("status")
    st.set_defaults(fn=cmd_status)
    a = ap.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()
