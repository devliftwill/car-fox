#!/usr/bin/env python3
"""
CAR FOX Live Avatar — local server (LiveAvatar API).

Serves the demo AND mints LiveAvatar session tokens server-side, so your API key
stays in this process and never reaches the browser.

Run:
    HEYGEN_API_KEY=your-key python3 server.py
    # then open http://127.0.0.1:8899/carfox-live-avatar.html

The key is read from HEYGEN_API_KEY (a LiveAvatar API key from liveavatar.com ->
"Get API Key"). It is never logged and sent only to api.liveavatar.com.
"""
import json
import os
import urllib.request
import urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8899"))
API_KEY = os.environ.get("HEYGEN_API_KEY", "").strip()
API_URL = os.environ.get("LIVEAVATAR_API_URL", "https://api.liveavatar.com").rstrip("/")
TOKEN_URL = API_URL + "/v1/sessions/token"

# api.liveavatar.com sits behind Cloudflare, which blocks Python's default
# urllib signature with "error code: 1010". A normal browser User-Agent + Accept
# headers get the request through to the real API.
BROWSER_UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
             "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
COMMON_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
}


class Handler(SimpleHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        p = self.path.split("?", 1)[0].rstrip("/")
        if p == "/api/health":
            self._json(200, {"keySet": bool(API_KEY), "apiUrl": API_URL})
            return
        return SimpleHTTPRequestHandler.do_GET(self)

    def do_POST(self):
        if self.path.rstrip("/") != "/api/token":
            self._json(404, {"error": "not found"})
            return
        if not API_KEY:
            self._json(500, {"error": "HEYGEN_API_KEY env var is not set on the server."})
            return
        # config comes from the client (avatar/voice/language/mode)
        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        except Exception:
            body = {}

        avatar_id = (body.get("avatar_id") or "").strip()
        voice_id = (body.get("voice_id") or "").strip()
        language = (body.get("language") or "en").strip()
        push_to_talk = bool(body.get("pushToTalk"))
        sandbox = bool(body.get("sandbox"))

        persona = {"language": language}
        if voice_id:
            persona["voice_id"] = voice_id

        payload = {
            "mode": "FULL",
            "avatar_id": avatar_id,
            "avatar_persona": persona,
            "is_sandbox": sandbox,
        }
        if push_to_talk:
            payload["interactivity_type"] = "PUSH_TO_TALK"

        try:
            headers = {"X-API-KEY": API_KEY, "Content-Type": "application/json"}
            headers.update(COMMON_HEADERS)
            req = urllib.request.Request(
                TOKEN_URL,
                method="POST",
                headers=headers,
                data=json.dumps(payload).encode(),
            )
            with urllib.request.urlopen(req, timeout=25) as r:
                data = json.loads(r.read().decode())
            d = (data or {}).get("data", {}) or {}
            token = d.get("session_token")
            if not token:
                self._json(502, {"error": "no session_token in LiveAvatar response", "raw": data})
                return
            self._json(200, {"session_token": token, "session_id": d.get("session_id")})
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            self._json(e.code, {"error": "LiveAvatar returned %s" % e.code, "detail": detail})
        except Exception as e:  # noqa
            self._json(502, {"error": str(e)})

    def log_message(self, *a):  # quiet
        pass


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    key_state = "SET" if API_KEY else "MISSING (set HEYGEN_API_KEY)"
    print("CAR FOX Live Avatar server (LiveAvatar API)")
    print("  http://127.0.0.1:%d/carfox-live-avatar.html" % PORT)
    print("  API: %s" % API_URL)
    print("  API key: %s" % key_state)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
