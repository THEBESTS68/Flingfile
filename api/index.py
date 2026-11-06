"""
Flingfile backend — งานเบามาก เพราะไฟล์วิ่งตรงระหว่างอุปกรณ์ (WebRTC P2P)

  GET /api/config -> ค่าที่ frontend ใช้ต่อ Supabase Realtime (signaling) + ICE servers
  GET /api/ice    -> STUN/TURN servers (credential TURN ชั่วคราว) สำหรับ WebRTC
  GET /api/room   -> รหัสห้องของ "เครือข่ายเดียวกัน" (hash จาก Public IP ไม่เก็บ IP จริง)

รันในเครื่อง:  uvicorn api.index:app --reload   (เสิร์ฟหน้าเว็บให้ด้วย)
"""
import hashlib
import ipaddress
import json
import os
import time
import urllib.request
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Flingfile")

# ค่าเริ่มต้น: โปรเจกต์ Supabase "flingfile" (ใช้แค่ Realtime)
# publishable key ออกแบบมาให้เปิดเผยได้ (ถูกส่งไปที่เบราว์เซอร์อยู่แล้ว)
DEFAULT_SUPABASE_URL = "https://qhhdyhepygkfpyhjocuu.supabase.co"
DEFAULT_SUPABASE_KEY = "sb_publishable_ZqnQ9LAcg4Wfxk8YZGHV3g_mYul2BO9"

# ใช้ค่าจาก env เป็นคู่ก็ต่อเมื่อมี SUPABASE_ANON_KEY (กัน URL เก่าจับคู่ผิดกับ key ใหม่)
if os.environ.get("SUPABASE_ANON_KEY"):
    SUPABASE_URL = (os.environ.get("SUPABASE_URL") or DEFAULT_SUPABASE_URL).rstrip("/")
    SUPABASE_ANON_KEY = os.environ["SUPABASE_ANON_KEY"]
else:
    SUPABASE_URL, SUPABASE_ANON_KEY = DEFAULT_SUPABASE_URL, DEFAULT_SUPABASE_KEY
ROOM_SALT = os.environ.get("ROOM_SALT") or SUPABASE_ANON_KEY[-16:] or "flingfile"


# ---------- ICE: STUN + TURN ----------
# STUN  = ช่วยให้แต่ละเครื่องรู้ "ที่อยู่สาธารณะ" ของตัวเอง เพื่อต่อกันตรงๆ (ฟรี ใช้ได้เสมอ)
# TURN  = "คนกลางส่งของ" ใช้เมื่อเครือข่ายบล็อกการต่อตรง (4G บางเจ้า / Wi-Fi องค์กร)
#
# รองรับ TURN 3 แบบ (ตั้งใน env) — เลือกอันแรกที่ตั้งไว้ และรวมกันได้:
#   1) Cloudflare Realtime TURN (แนะนำ ฟรี 1,000 GB/เดือน):
#        CLOUDFLARE_TURN_KEY_ID, CLOUDFLARE_TURN_API_TOKEN
#   2) Metered.ca (ฟรี 50 GB/เดือน):
#        METERED_DOMAIN (เช่น yourapp.metered.live), METERED_API_KEY
#   3) TURN ของตัวเอง (เช่น coturn): TURN_URL, TURN_USERNAME, TURN_CREDENTIAL
#   + ICE_SERVERS_JSON สำหรับใส่เพิ่มแบบ JSON
# รหัสของ (1)(2) อยู่ฝั่งเซิร์ฟเวอร์เท่านั้น เบราว์เซอร์ได้แค่ credential ชั่วคราว (หมดอายุตาม TURN_TTL)
STUN_SERVERS = [{"urls": ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]}]
TURN_TTL = int(os.environ.get("TURN_TTL", "21600"))  # 6 ชั่วโมง
_turn_cache = {"servers": None, "expires": 0.0, "provider": None}


def _http_json(url: str, method: str = "GET", headers=None, body=None, timeout: float = 4.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _without_port_53(servers):
    """Cloudflare ให้ url พอร์ต 53 มาด้วย แต่เบราว์เซอร์บล็อกพอร์ตนี้ ทำให้ต่อช้า -> ตัดทิ้ง"""
    out = []
    for s in servers:
        urls = s.get("urls")
        urls = [urls] if isinstance(urls, str) else list(urls or [])
        urls = [u for u in urls if not u.split("?")[0].endswith(":53")]
        if urls:
            out.append({**s, "urls": urls})
    return out


def _cloudflare_turn():
    key_id = os.environ.get("CLOUDFLARE_TURN_KEY_ID")
    token = os.environ.get("CLOUDFLARE_TURN_API_TOKEN")
    if not (key_id and token):
        return None
    base = f"https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials"
    auth = {"Authorization": f"Bearer {token}"}
    try:
        data = _http_json(f"{base}/generate-ice-servers", "POST", auth, {"ttl": TURN_TTL})
        servers = data.get("iceServers") or []
    except Exception:
        data = _http_json(f"{base}/generate", "POST", auth, {"ttl": TURN_TTL})  # API รุ่นเก่า
        servers = data.get("iceServers") or []
    if isinstance(servers, dict):
        servers = [servers]
    return _without_port_53(servers)


def _metered_turn():
    domain = os.environ.get("METERED_DOMAIN")
    api_key = os.environ.get("METERED_API_KEY")
    if not (domain and api_key):
        return None
    data = _http_json(f"https://{domain}/api/v1/turn/credentials?apiKey={api_key}")
    return data if isinstance(data, list) else None


def _static_turn():
    servers = []
    turn_url = os.environ.get("TURN_URL")
    if turn_url:
        servers.append({
            "urls": [u.strip() for u in turn_url.split(",") if u.strip()],
            "username": os.environ.get("TURN_USERNAME", ""),
            "credential": os.environ.get("TURN_CREDENTIAL", ""),
        })
    extra = os.environ.get("ICE_SERVERS_JSON")
    if extra:
        try:
            servers.extend(json.loads(extra))
        except ValueError:
            pass
    return servers


def ice_servers():
    """คืน (servers, ttl วินาที, provider) — cache ไว้ครึ่งหนึ่งของอายุ credential"""
    now = time.time()
    if _turn_cache["servers"] is not None and now < _turn_cache["expires"]:
        return _turn_cache["servers"], int(_turn_cache["expires"] - now), _turn_cache["provider"]
    turn, provider = [], None
    for name, fetch in (("cloudflare", _cloudflare_turn), ("metered", _metered_turn)):
        try:
            got = fetch()
        except Exception:
            got = None  # ผู้ให้บริการล่ม -> ลองตัวถัดไป / ใช้ STUN อย่างเดียว
        if got:
            turn, provider = got, name
            break
    static = _static_turn()
    if static:
        turn += static
        provider = provider or "static"
    servers = STUN_SERVERS + turn
    # credential แบบชั่วคราว: cache ครึ่งอายุ / ไม่มี TURN หรือแบบ static: cache 10 นาที
    life = TURN_TTL // 2 if provider in ("cloudflare", "metered") else 600
    _turn_cache.update(servers=servers, expires=now + life, provider=provider)
    return servers, life, provider


@app.get("/api/ice")
def ice():
    servers, ttl, provider = ice_servers()
    return JSONResponse(
        {"ice_servers": servers, "ttl": ttl, "turn": provider is not None, "provider": provider},
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/config")
def config():
    servers, _, provider = ice_servers()
    return JSONResponse(
        {
            "supabase_url": SUPABASE_URL,
            "supabase_anon_key": SUPABASE_ANON_KEY,
            "ice_servers": servers,
            "turn": provider is not None,
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


# ---------- หน้าเว็บ (public/) ----------
# บน Vercel (FastAPI preset) ไฟล์ใน public/ ถูกเสิร์ฟจาก CDN ก่อนถึงแอป
# ส่วนนี้เป็นทางสำรอง + ใช้ตอนรันในเครื่อง ต้องอยู่ท้ายสุดเพื่อไม่บัง /api/*
PUBLIC = Path(__file__).resolve().parent.parent / "public"
if PUBLIC.is_dir():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=PUBLIC, html=True), name="static")
