#!/usr/bin/env python3
"""Call the BTQ Swap admin API on the VPS. Token stays in the environment.

Reads ADMIN_TOKEN (and HEALTH_DEEP_TOKEN for `health`) from the environment.
Never prints either token, the cookie, or request headers.

    set -a && . /opt/btq-swap/deploy/.env && set +a
    python3 docs/sops/scripts/vps-admin.py health
    python3 docs/sops/scripts/vps-admin.py GET /overview
    python3 docs/sops/scripts/vps-admin.py POST /mm/orders body.json
    python3 docs/sops/scripts/vps-admin.py POST /settings -   # JSON on stdin

Stdout is the response body. Stderr is `HTTP <code>`. Exit 0 on 2xx, else 1.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

ADMIN = os.environ.get("BTQ_ADMIN_BASE", "http://127.0.0.1:5173/api/admin")
PUBLIC = os.environ.get("BTQ_PUBLIC_BASE", "http://127.0.0.1:5173/api")


def call(url: str, method: str, data: bytes | None, cookie: str | None) -> tuple[int, bytes, str | None]:
    headers = {"accept": "application/json"}
    if data is not None:
        headers["content-type"] = "application/json"
    if cookie:
        headers["x-btq-request"] = "1"
        headers["cookie"] = cookie
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as res:
            return res.status, res.read(), res.headers.get("Set-Cookie")
    except urllib.error.HTTPError as err:
        return err.code, err.read(), None


def cookie_from(header: str | None) -> str:
    if not header or "btq_admin=" not in header:
        raise SystemExit("login returned no btq_admin cookie")
    pair = header.split(";", 1)[0]
    if not pair.startswith("btq_admin="):
        raise SystemExit("login cookie was not btq_admin")
    return pair


def login() -> str:
    token = os.environ.get("ADMIN_TOKEN", "")
    if len(token) < 24:
        raise SystemExit("ADMIN_TOKEN is not loaded; source deploy/.env in this process")
    status, body, set_cookie = call(ADMIN + "/login", "POST", json.dumps({"token": token}).encode(), None)
    if status != 200:
        sys.stdout.buffer.write(body)
        raise SystemExit(1)
    return cookie_from(set_cookie)


def health() -> int:
    token = os.environ.get("HEALTH_DEEP_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("HEALTH_DEEP_TOKEN is not loaded; source deploy/.env in this process")
    req = urllib.request.Request(
        PUBLIC + "/health/deep",
        headers={"accept": "application/json", "x-health-token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            sys.stderr.write(f"HTTP {res.status}\n")
            sys.stdout.buffer.write(res.read())
            return 0
    except urllib.error.HTTPError as err:
        sys.stderr.write(f"HTTP {err.code}\n")
        sys.stdout.buffer.write(err.read())
        return 1


def main() -> int:
    if len(sys.argv) < 2:
        raise SystemExit(__doc__ or "missing command")
    if sys.argv[1] == "health":
        return health()
    if len(sys.argv) < 3:
        raise SystemExit("usage: vps-admin.py GET|POST <path> [body.json|-]")
    method, path = sys.argv[1].upper(), sys.argv[2]
    if not path.startswith("/"):
        raise SystemExit("path must start with /")
    data = None
    if method != "GET":
        source = sys.argv[3] if len(sys.argv) > 3 else "-"
        raw = sys.stdin.read() if source == "-" else open(source, encoding="utf-8").read()
        data = (raw.strip() or "{}").encode()
    cookie = login()
    status, body, _ = call(ADMIN + path, method, data, cookie)
    sys.stderr.write(f"HTTP {status}\n")
    sys.stdout.buffer.write(body)
    if not body.endswith(b"\n"):
        sys.stdout.buffer.write(b"\n")
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        sys.stderr.write(f"{exc.__class__.__name__}: {exc}\n")
        raise SystemExit(1)
