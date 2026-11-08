"""A fake Telegram Bot API for the end-to-end test.

Logs every call as one JSON line, and numbers sent messages 101, 102, …

  python3 fake_telegram.py <log file> <port>
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG, PORT = sys.argv[1], int(sys.argv[2])
next_message_id = [100]


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        method = self.path.rsplit("/", 1)[-1]
        body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        with open(LOG, "a") as f:
            f.write(json.dumps({"method": method, "params": body}, ensure_ascii=False) + "\n")
        if method == "getMe":
            result = {"username": "testbot"}
        elif method == "sendMessage":
            next_message_id[0] += 1
            result = {"message_id": next_message_id[0]}
        else:
            result = True
        out = json.dumps({"ok": True, "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *_):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
