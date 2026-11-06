"""
Flingfile backend — งานเบามาก เพราะไฟล์วิ่งตรงระหว่างอุปกรณ์ (WebRTC P2P)

  GET /api/config -> ค่าที่ frontend ใช้ต่อ Supabase Realtime (signaling) + ICE servers
  GET /api/room   -> รหัสห้องของ "เครือข่ายเดียวกัน" (hash จาก Public IP ไม่เก็บ IP จริง)

รันในเครื่อง:  uvicorn api.index:app --reload   (เสิร์ฟหน้าเว็บให้ด้วย)
"""
import hashlib
import ipaddress
import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Flingfile")

SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY") or ""
ROOM_SALT = os.environ.get("ROOM_SALT") or SUPABASE_ANON_KEY[-16:] or "flingfile"


def ice_servers():
    servers = [{"urls": ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]}]
    turn_url = os.environ.get("TURN_URL")  # ใส่ได้หลาย url คั่นด้วย ,
    if turn_url:
        servers.append({
            "urls": [u.strip() for u in turn_url.split(",") if u.strip()],
            "username": os.environ.get("TURN_USERNAME", ""),
            "credential": os.environ.get("TURN_CREDENTIAL", ""),
        })
    extra = os.environ.get("ICE_SERVERS_JSON")  # เผื่อใช้ TURN หลายเจ้า
    if extra:
        try:
            servers.extend(json.loads(extra))
        except ValueError:
            pass
    return servers


@app.get("/api/config")
def config():
    return JSONResponse(
        {
            "supabase_url": SUPABASE_URL,
            "supabase_anon_key": SUPABASE_ANON_KEY,
            "ice_servers": ice_servers(),
        },
        headers={"Cache-Control": "no-store"},
    )


def client_ip(request: Request) -> str:
    for header in ("x-real-ip", "x-forwarded-for"):
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()
    return request.client.host if request.client else "0.0.0.0"


@app.get("/api/room")
def network_room(request: Request):
    raw = client_ip(request)
    try:
        ip = ipaddress.ip_address(raw)
        if ip.version == 6 and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if ip.version == 6:
            # IPv6: ทุกเครื่องในบ้านได้ IP ต่างกัน แต่ใช้ prefix /64 เดียวกัน
            key = str(ipaddress.ip_network(f"{ip}/64", strict=False))
        else:
            key = str(ip)
        if ip.is_private or ip.is_loopback:
            key = "local-dev"
    except ValueError:
        key = raw
    room = hashlib.sha256(f"{ROOM_SALT}|{key}".encode()).hexdigest()[:16]
    return JSONResponse({"room": f"net-{room}"}, headers={"Cache-Control": "no-store"})


# ---------- ใช้ตอนรันในเครื่องเท่านั้น (บน Vercel ไฟล์ static ถูกเสิร์ฟโดย CDN) ----------
if not os.environ.get("VERCEL"):
    from fastapi.staticfiles import StaticFiles

    ROOT = Path(__file__).resolve().parent.parent
    app.mount("/", StaticFiles(directory=ROOT, html=True), name="static")
