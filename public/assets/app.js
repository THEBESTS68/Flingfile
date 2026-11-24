/* Flingfile — โยนไฟล์ข้ามอุปกรณ์แบบ P2P (WebRTC DataChannel)
 *
 *  ┌────────┐  presence + SDP/ICE (Trystero ผ่าน Nostr relay สาธารณะ)  ┌────────┐
 *  │ เครื่อง A │ ◀───────────────────────────────────────────────────▶ │ เครื่อง B │
 *  └────────┘ ═════════════ ไฟล์วิ่งตรง (WebRTC, เข้ารหัส DTLS) ═══════ └────────┘
 *
 *  ตัวกลางหาเครื่อง (signaling):
 *    - Trystero/Nostr — ไม่ต้องมีบัญชี (assets/vendor/trystero.min.mjs)
 *    - BroadcastChannel — ถ้าโหลด Trystero ไม่ได้ (เห็นเฉพาะแท็บในเบราว์เซอร์เดียวกัน) + แจ้งเตือน
 *  สำรองเมื่อทุกอย่างล่ม: จับคู่ด้วย QR สองรอบ แลกข้อมูลจับมือผ่านกล้อง ไม่ผ่านเซิร์ฟเวอร์ใดเลย
 */
(() => {
  "use strict";

  /* ================= constants & utils ================= */
  // ---- ความเร็ว (ค่าที่วัดแล้วเร็วและนิ่งที่สุด — ดู README หัวข้อความเร็ว) ----
  // ชิ้นละ 64KB: ใหญ่กว่านี้ไม่ได้เร็วขึ้น และ Safari รับได้ราว 64KB (ถ้าอีกฝ่ายรับได้น้อยกว่าก็ลดลงตาม)
  const CHUNK = 64 * 1024, CHUNK_MIN = 16 * 1024;
  const READ = 4 * 1024 * 1024;        // อ่านไฟล์ทีละ 4MB และอ่านช่วงถัดไปล่วงหน้าระหว่างส่ง
  const HIGH_WATER = 8 * 1024 * 1024;  // เติมคิวได้ถึง 8MB (คิวใหญ่กว่านี้วัดแล้วช้าลงและไม่นิ่ง)
  const LOW_WATER = 1024 * 1024;       // คิวลดต่ำกว่า 1MB ค่อยเติมต่อ
  const SPILL = 32 * 1024 * 1024;      // รวม chunk เป็น Blob ทุก 32MB (ให้เบราว์เซอร์ย้ายลงดิสก์ได้)
  const FORCE_RELAY = new URLSearchParams(location.search).get("relay") === "1"; // ?relay=1 ทดสอบ TURN
  const ZIP_LIMIT = 1024 * 1024 * 1024;
  const AUTOSAVE_MAX = 5;

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rid = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join("");
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtSize = (b) => b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " KB" : b < 1073741824 ? (b / 1048576).toFixed(1) + " MB" : (b / 1073741824).toFixed(2) + " GB";
  const extOf = (n) => { const m = /\.([a-z0-9]{1,5})$/i.exec(n || ""); return m ? m[1] : "FILE"; };
  const hueOf = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  const store = {
    get(k, d) { try { return JSON.parse(localStorage.getItem("ff:" + k)) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ff:" + k, JSON.stringify(v)); } catch {} },
    getRaw(k) { try { return localStorage.getItem(k); } catch { return null; } },
    setRaw(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const ICON = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/></svg>',
  };

  /* ================= identity ================= */
  const ANIMALS = [["🦊", "จิ้งจอก"], ["🐼", "แพนด้า"], ["🐨", "โคอาลา"], ["🦉", "นกฮูก"], ["🐬", "โลมา"], ["🐧", "เพนกวิน"], ["🦁", "สิงโต"], ["🐯", "เสือ"],
    ["🐰", "กระต่าย"], ["🦄", "ยูนิคอร์น"], ["🐙", "ปลาหมึก"], ["🦋", "ผีเสื้อ"], ["🐳", "วาฬ"], ["🦜", "นกแก้ว"], ["🐢", "เต่า"], ["🦔", "เม่น"]];
  const COLORS = ["สีฟ้า", "สีชมพู", "สีทอง", "สีเขียว", "สีม่วง", "สีส้ม", "สีเงิน", "สีคราม", "สีมรกต", "สีพีช"];

  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? "iPhone" : /iPad|Macintosh.*Mobile/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad"
      : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "อุปกรณ์";
    // เรียงจากเจาะจงไปทั่วไป: แอปที่เปิดเว็บในตัว → เบราว์เซอร์เฉพาะเจ้า → Chrome/Safari (เกือบทุกเจ้าใส่คำว่า Chrome/Safari ใน UA)
    const BROWSERS = [
      [/\bLine\//, "LINE"], [/FBAN|FBAV|FB_IAB/, "Facebook"], [/Instagram/, "Instagram"], [/musical_ly|BytedanceWebview|TikTok/, "TikTok"],
      [/DuckDuckGo\//, "DuckDuckGo"], [/SamsungBrowser\//, "Samsung Internet"], [/MiuiBrowser\//, "Mi Browser"], [/HuaweiBrowser\//, "Huawei Browser"],
      [/YaBrowser\//, "Yandex"], [/UCBrowser\//, "UC Browser"], [/Whale\//, "Whale"], [/Vivaldi\//, "Vivaldi"],
      [/Edg(e|A|iOS)?\//, "Edge"], [/OPR\/|OPT\/|OPiOS\//, "Opera"], [/Firefox\/|FxiOS\//, "Firefox"],
      [/Chrome\/|CriOS\//, "Chrome"], [/Safari\//, "Safari"],
    ];
    const br = (BROWSERS.find(([re]) => re.test(ua)) || [, ""])[1];
    return br ? `${os} · ${br}` : os;
  }

  // ข้อมูลที่ UA ไม่บอก (Brave, Opera GX, Windows 11) ถามแบบ async จาก userAgentData — มีเฉพาะเบราว์เซอร์ตระกูล Chromium
  async function refineDeviceLabel(label) {
    let [os, br] = label.split(" · ");
    try {
      const uad = navigator.userAgentData;
      const brands = (uad?.brands || []).map((b) => b.brand);
      if (await navigator.brave?.isBrave?.()) br = "Brave";
      else if (brands.includes("Opera GX")) br = "Opera GX";
      else if (brands.includes("Brave")) br = "Brave";
      else if (brands.includes("Vivaldi")) br = "Vivaldi";
      if (os === "Windows" && uad?.getHighEntropyValues) {
        const { platformVersion } = await uad.getHighEntropyValues(["platformVersion"]);
        const major = parseInt(platformVersion, 10);
        if (major >= 13) os = "Windows 11"; else if (major > 0) os = "Windows 10";
      }
    } catch {}
    return br ? `${os} · ${br}` : os;
  }

  let saved = store.get("me", null);
  if (!saved) {
    const [emoji, animal] = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    saved = { emoji, name: `${animal}${COLORS[Math.floor(Math.random() * COLORS.length)]}` };
    store.set("me", saved);
  }
  const me = { id: rid(12), name: saved.name, emoji: saved.emoji, device: deviceLabel(), since: Date.now() };

  /* ================= toast ================= */
  function toast(msg, err = false, ms = 3200) {
    const t = document.createElement("div");
    t.className = "toast" + (err ? " err" : "");
    t.innerHTML = "<i></i><span></span>";
    t.lastChild.textContent = msg;
    $("toasts").appendChild(t);
    setTimeout(() => { t.classList.add("out"); t.addEventListener("animationend", () => t.remove(), { once: true }); }, ms);
  }

  /* ================= modal (queue) ================= */
  const modalQueue = [];
  let modalOpen = null;
  function openModal(build) {
    return new Promise((resolve) => {
      modalQueue.push({ build, resolve });
      if (!modalOpen) nextModal();
    });
  }
  function nextModal() {
    const item = modalQueue.shift();
    if (!item) { modalOpen = null; document.body.classList.remove("modal-open"); return; }
    document.body.classList.add("modal-open"); // หยุดแอนิเมชันพื้นหลังระหว่างเปิดหน้าต่าง (ลดงาน GPU)
    const wrap = $("modalWrap"), box = $("modal");
    wrap.classList.remove("out");
    box.innerHTML = "";
    wrap.hidden = false;
    let done = false;
    const close = (value) => {
      if (done) return;
      done = true;
      wrap.classList.add("out");
      setTimeout(() => { wrap.hidden = true; item.resolve(value); nextModal(); }, 230);
    };
    modalOpen = { close, onDismiss: null };
    item.build(box, close, modalOpen);
    const focusable = box.querySelector("[autofocus]") || box.querySelector("input, textarea, .btn");
    focusable && setTimeout(() => focusable.focus(), 60);
  }
  $("modalWrap").addEventListener("pointerdown", (e) => { if (e.target === $("modalWrap") && modalOpen) (modalOpen.onDismiss || modalOpen.close)(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (modalOpen) (modalOpen.onDismiss || modalOpen.close)(); hidePopover(); } });

  /* ================= signaling ================= */
  // handlers: join(peer) / leave(id) / update(peer) / signal(from, data) / status(state)
  class LocalSignal {
    constructor(room, h) { this.room = room; this.h = h; this.seen = new Map(); }
    start() {
      this.bc = new BroadcastChannel("flingfile:" + this.room);
      this.bc.onmessage = ({ data: m }) => this.onMsg(m);
      this.hello();
      this.timer = setInterval(() => { this.hello(); this.prune(); }, 2000);
      this.h.status("live");
    }
    hello() { this.bc.postMessage({ k: "hello", peer: me }); }
    prune() { const now = Date.now(); for (const [id, s] of this.seen) if (now - s.t > 7000) { this.seen.delete(id); this.h.leave(id); } }
    onMsg(m) {
      if (m.k === "hello" && m.peer.id !== me.id) {
        const old = this.seen.get(m.peer.id);
        this.seen.set(m.peer.id, { t: Date.now(), peer: m.peer });
        if (!old) { this.h.join(m.peer); this.hello(); }
        else if (old.peer.name !== m.peer.name || old.peer.emoji !== m.peer.emoji || old.peer.device !== m.peer.device) this.h.update(m.peer);
      } else if (m.k === "bye" && this.seen.delete(m.id)) this.h.leave(m.id);
      else if (m.k === "sig" && m.to === me.id) this.h.signal(m.from, m.data);
    }
    send(to, data) { this.bc.postMessage({ k: "sig", to, from: me.id, data }); }
    update() { this.hello(); }
    stop() { clearInterval(this.timer); try { this.bc.postMessage({ k: "bye", id: me.id }); this.bc.close(); } catch {} for (const id of this.seen.keys()) this.h.leave(id); this.seen.clear(); }
  }

  // Trystero ต่อ WebRTC หากันผ่าน Nostr relay สาธารณะ (ไม่ต้องมีบัญชี/ไม่มีโปรเจกต์ให้โดนพัก)
  // ใช้การเชื่อมต่อของ Trystero เป็นท่อส่ง presence + สัญญาณจับมือให้ Conn ของแอปอีกชั้น
  // (ส่วนส่งไฟล์จึงเหมือนเดิมทุกอย่าง)
  const RELAY_TIMEOUT = 10000;
  class TrysteroSignal {
    constructor(lib, room, h) {
      Object.assign(this, { lib, room, h });
      this.seen = new Map();   // peer.id -> info
      this.byTp = new Map();   // trystero peerId -> peer.id
      this.toTp = new Map();   // peer.id -> trystero peerId
    }
    start() {
      const cfg = { appId: "flingfile.p2p", identity: "none", rtcConfig: { iceServers: CFG.ice_servers } };
      if (CFG.nostr_relays?.length) cfg.relayConfig = { urls: CFG.nostr_relays };
      const r = this.r = this.lib.joinRoom(cfg, this.room);
      this.hello = r.makeAction("hello");
      this.sig = r.makeAction("sig");
      r.onPeerJoin(({ peerId }) => this.hello.send(me, { target: peerId }).catch(() => {}));
      r.onPeerLeave(({ peerId }) => {
        const id = this.byTp.get(peerId);
        this.byTp.delete(peerId);
        if (!id || this.toTp.get(id) !== peerId) return;
        this.toTp.delete(id); this.seen.delete(id); this.h.leave(id);
      });
      this.hello.onMessage((peer, { peerId }) => {
        if (!peer?.id || peer.id === me.id) return;
        this.byTp.set(peerId, peer.id); this.toTp.set(peer.id, peerId);
        const old = this.seen.get(peer.id);
        this.seen.set(peer.id, peer);
        if (!old) this.h.join(peer);
        else if (old.name !== peer.name || old.emoji !== peer.emoji || old.device !== peer.device) this.h.update(peer);
      });
      this.sig.onMessage((data, { peerId }) => { const from = this.byTp.get(peerId); if (from) this.h.signal(from, data); });
      // สถานะ: "live" เมื่อต่อ relay ได้อย่างน้อย 1 ตัว; ต่อไม่ได้เลยนานเกิน RELAY_TIMEOUT → "error"
      this.okAt = Date.now();
      const check = () => {
        let open = false;
        try { open = Object.values(this.lib.getRelaySockets()).some((s) => s.readyState === 1); } catch {}
        if (open) this.okAt = Date.now();
        this.h.status(open ? "live" : Date.now() - this.okAt > RELAY_TIMEOUT ? "error" : "connecting");
      };
      this.timer = setInterval(check, 500);
      check();
    }
    send(to, data) { const tp = this.toTp.get(to); if (tp) this.sig.send(data, { target: tp }).catch(() => {}); }
    update() { this.hello?.send(me).catch(() => {}); }
    stop() {
      clearInterval(this.timer);
      try { this.r?.leave(); } catch {}
      for (const id of this.seen.keys()) this.h.leave(id);
      this.seen.clear(); this.byTp.clear(); this.toTp.clear();
    }
  }

  // ท่อสัญญาณผ่าน DataChannel ที่จับคู่ด้วย QR แล้ว (BootLink) — ใช้แทนตัวกลางสำหรับเครื่องคู่นี้
  class LinkSignal {
    constructor(link, room, h) { Object.assign(this, { link, room, h }); this.peer = null; }
    start() {
      this.link.onmessage = (m) => {
        if (m.k === "hello" && m.peer?.id && m.peer.id !== me.id) {
          const first = !this.peer;
          this.peer = m.peer;
          first ? this.h.join(m.peer) : this.h.update(m.peer);
        } else if (m.k === "sig" && this.peer) this.h.signal(this.peer.id, m.data);
      };
      this.link.onclose = () => { if (this.peer) this.h.leave(this.peer.id); this.peer = null; this.h.status("off"); };
      this.update();
      this.h.status("live");
    }
    send(to, data) { this.link.send({ k: "sig", data }); }
    update() { this.link.send({ k: "hello", peer: me }); }
    stop() { this.link.onclose = null; this.link.close(); if (this.peer) this.h.leave(this.peer.id); this.peer = null; }
  }

  /* ================= rooms & peers ================= */
  let CFG = { ice_servers: [{ urls: ["stun:stun.l.google.com:19302"] }] };
  let trystero = null;   // โมดูล Trystero (null = โหลดไม่ได้ → ใช้ LocalSignal)
  const rooms = new Map();   // roomId -> { signal, label, kind, status }
  const peers = new Map();   // peerId -> { info, rooms:Set, el, conn, queue }
  const via = new Map();     // peerId -> signal ที่ใช้ติดต่อล่าสุด

  const makeSignal = (roomId, h) => trystero ? new TrysteroSignal(trystero, roomId, h) : new LocalSignal(roomId, h);
  function joinRoom(roomId, kind, label, factory = makeSignal) {
    if (rooms.has(roomId)) return;
    const room = { kind, label, status: "connecting" };
    const h = {
      join: (p) => addPeer(p, roomId, room.signal),
      update: (p) => updatePeer(p),
      leave: (id) => removePeerRoom(id, roomId),
      signal: (from, data) => { via.set(from, room.signal); onSignal(from, data); },
      status: (s) => {
        if (room.status === s || !rooms.has(roomId)) return;
        room.status = s; renderChips();
        if (kind === "net") netStatus(s);
        if (kind === "qr" && s === "off") { leaveRoom(roomId); toast(`ขาดการเชื่อมต่อ QR กับ ${label}`, true); }
      },
    };
    room.signal = factory(roomId, h);
    rooms.set(roomId, room);
    room.signal.start();
    renderChips();
  }
  function leaveRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    rooms.delete(roomId);
    room.signal.stop();
    renderChips();
  }

  function renderChips() {
    const box = $("chips");
    box.innerHTML = "";
    for (const [id, r] of rooms) {
      const chip = document.createElement("span");
      chip.className = "chip " + (r.status === "live" ? "live" : r.status === "error" ? "err" : "");
      chip.innerHTML = `<i></i>${r.kind === "pair" ? `ห้อง <b>${esc(r.label)}</b>` : r.kind === "qr" ? `QR · ${esc(r.label)}` : esc(r.label)}`;
      if (r.kind === "pair" || r.kind === "qr") {
        const b = document.createElement("button");
        const what = r.kind === "qr" ? "ตัดการเชื่อมต่อ" : "ออกจากห้อง";
        b.innerHTML = ICON.x; b.title = what; b.setAttribute("aria-label", what + " " + r.label);
        b.onclick = () => { leaveRoom(id); toast(r.kind === "qr" ? `ตัดการเชื่อมต่อ QR กับ ${r.label} แล้ว` : "ออกจากห้อง " + r.label + " แล้ว"); };
        chip.appendChild(b);
      }
      box.appendChild(chip);
    }
  }

  function addPeer(info, roomId, signal) {
    let p = peers.get(info.id);
    if (p) { p.rooms.add(roomId); updatePeer(info); return; }
    p = { info, rooms: new Set([roomId]), conn: null, queue: Promise.resolve(), busy: false };
    peers.set(info.id, p);
    if (!via.has(info.id)) via.set(info.id, signal);
    p.el = makePeerEl(p);
    $("peers").appendChild(p.el);
    layout();
  }
  function updatePeer(info) {
    const p = peers.get(info.id);
    if (!p) return;
    p.info = { ...p.info, ...info };
    p.el.querySelector(".em").textContent = p.info.emoji;
    p.el.querySelector(".peer-name").textContent = p.info.name;
    if (!p.busy) p.el.querySelector(".peer-sub").textContent = p.info.device;
  }
  function removePeerRoom(id, roomId) {
    const p = peers.get(id);
    if (!p) return;
    p.rooms.delete(roomId);
    if (p.rooms.size) return;
    peers.delete(id);
    via.delete(id);
    if (p.conn) p.conn.kill("left");
    p.el.classList.add("leaving");
    setTimeout(() => { p.el.remove(); }, 450);
    layout();
  }

  /* ================= peer UI ================= */
  function makePeerEl(p) {
    const el = document.createElement("div");
    el.className = "peer";
    el.dataset.id = p.info.id;
    el.innerHTML = `
      <div class="peer-in">
        <button class="peer-orb" style="--h:${hueOf(p.info.id)};--delay:${-(Math.random() * 6).toFixed(2)}s" aria-haspopup="menu">
          <svg class="peer-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="46"/><circle class="bar" cx="50" cy="50" r="46"/></svg>
          <span class="em"></span>
        </button>
        <div class="peer-name"></div>
        <div class="peer-sub"></div>
      </div>`;
    el.querySelector(".em").textContent = p.info.emoji;
    el.querySelector(".peer-name").textContent = p.info.name;
    el.querySelector(".peer-sub").textContent = p.info.device;
    const orb = el.querySelector(".peer-orb");
    orb.setAttribute("aria-label", `ส่งให้ ${p.info.name}`);
    orb.onclick = () => onPeerClick(p.info.id, orb);
    orb.oncontextmenu = (e) => { e.preventDefault(); composeText(p.info.id); };
    let depth = 0;
    el.addEventListener("dragenter", (e) => { e.preventDefault(); if (!depth++) getConn(p.info.id); el.classList.add("drag"); });
    el.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.classList.remove("drag"); } });
    el.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
    el.addEventListener("drop", async (e) => {
      e.preventDefault(); e.stopPropagation(); depth = 0; el.classList.remove("drag");
      const files = await filesFromDrop(e.dataTransfer);
      if (files.length) queueSend(p.info.id, files);
      else { const text = e.dataTransfer.getData("text/plain"); if (text) sendText(p.info.id, text); }
    });
    return el;
  }

  function layout() {
    const list = [...peers.values()].sort((a, b) => (a.info.since || 0) - (b.info.since || 0));
    $("empty").classList.toggle("gone", list.length > 0);
    $("hint").style.opacity = list.length ? 1 : 0;
    const stage = $("stage");
    const w = stage.clientWidth, h = stage.clientHeight;
    const mobile = w < 560;
    const rx = Math.max(120, Math.min(w / 2 - (mobile ? 52 : 74), 380));
    const ry = Math.max(180, Math.min(h / 2 - (mobile ? 86 : 92), 300));
    const n = list.length;
    list.forEach((p, i) => {
      // เริ่มจากด้านบน วนตามเข็ม; 2 เครื่องบนจอกว้างวางซ้าย-ขวา
      const a = -Math.PI / 2 + (n === 1 ? 0 : (i * 2 * Math.PI) / n) + (n === 2 && !mobile ? Math.PI / 2 : 0);
      const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
      p.el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    });
  }
  let layoutRaf = 0;
  addEventListener("resize", () => { cancelAnimationFrame(layoutRaf); layoutRaf = requestAnimationFrame(layout); });

  const R_CIRC = 2 * Math.PI * 46;
  function setPeerProgress(id, frac, text, mode = "busy") {
    const p = peers.get(id);
    if (!p) return;
    p.busy = mode !== "idle";
    p.el.classList.toggle("busy", p.busy);
    p.el.classList.toggle("waiting", mode === "waiting");
    p.el.querySelector(".peer-ring .bar").style.strokeDashoffset = mode === "waiting" ? "" : R_CIRC * (1 - Math.min(1, frac || 0));
    p.el.querySelector(".peer-sub").textContent = mode === "idle" ? p.info.device : text;
  }
  function flashDone(id) {
    const p = peers.get(id);
    if (!p) return;
    const orb = p.el.querySelector(".peer-orb");
    const b = document.createElement("span");
    b.className = "badge"; b.innerHTML = ICON.check;
    orb.appendChild(b);
    setTimeout(() => { b.style.transition = "opacity .4s, transform .4s"; b.style.opacity = 0; b.style.transform = "scale(.5)"; setTimeout(() => b.remove(), 400); }, 1800);
  }

  /* ================= popover (เลือกสิ่งที่จะส่ง) ================= */
  let popTarget = null;
  const supportsFolder = "webkitdirectory" in document.createElement("input") && !/iPhone|iPad|Android/.test(navigator.userAgent);
  if (!supportsFolder) $("folderAct").hidden = true;

  function onPeerClick(id, anchor) {
    const p = peers.get(id);
    if (!p) return;
    if (pendingFiles) { const f = pendingFiles; clearPending(); return queueSend(id, f); }
    if (!p.busy) getConn(id); // อุ่นเครื่อง: เริ่มต่อ P2P ทันทีระหว่างที่ผู้ใช้กำลังเลือกไฟล์
    if (p.busy && p.cancel) return confirmCancel(id);
    showPopover(id, anchor);
  }
  function showPopover(id, anchor) {
    const pop = $("popover");
    popTarget = id;
    pop.hidden = false;
    pop.classList.remove("out");
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    let x = r.left + r.width / 2 - pw / 2, y = r.bottom + 10, oy = "0%";
    if (y + ph > innerHeight - 8) { y = r.top - ph - 10; oy = "100%"; }
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    pop.style.left = x + "px"; pop.style.top = y + "px";
    pop.style.setProperty("--ox", `${r.left + r.width / 2 - x}px`); pop.style.setProperty("--oy", oy);
    pop.querySelector("button:not([hidden])").focus();
  }
  function hidePopover() {
    const pop = $("popover");
    if (pop.hidden) return;
    pop.classList.add("out");
    setTimeout(() => { pop.hidden = true; }, 180);
  }
  document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#popover") && !e.target.closest(".peer-orb")) hidePopover(); });
  $("popover").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b || !popTarget) return;
    const id = popTarget;
    hidePopover();
    if (b.dataset.act === "files") pick("pickFiles", id);
    else if (b.dataset.act === "folder") pick("pickFolder", id);
    else composeText(id);
  });
  function pick(inputId, peerId) {
    const input = $(inputId);
    input.onchange = () => {
      const files = [...input.files];
      input.value = "";
      if (files.length) queueSend(peerId, files.map((f) => ({ file: f, path: f.webkitRelativePath || f.name })));
    };
    input.click();
  }

  /* ---------- ไฟล์ค้างรอเลือกปลายทาง (จาก paste / drop ที่พื้นหลัง) ---------- */
  let pendingFiles = null;
  function setPending(files) {
    if (peers.size === 0) return toast("ยังไม่มีอุปกรณ์ให้ส่ง — เปิดหน้านี้บนอีกเครื่องก่อน", true);
    if (peers.size === 1) return queueSend([...peers.keys()][0], files);
    pendingFiles = files;
    peers.forEach((p) => p.el.classList.add("target"));
    toast(`เลือกแล้ว ${files.length} รายการ — แตะอุปกรณ์ที่จะส่ง`);
  }
  function clearPending() { pendingFiles = null; peers.forEach((p) => p.el.classList.remove("target")); }

  async function filesFromDrop(dt) {
    const items = [...(dt.items || [])].filter((i) => i.kind === "file");
    const entries = items.map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, path: f.name }));
    const out = [];
    const readAll = (reader) => new Promise((res) => { const all = []; const next = () => reader.readEntries((b) => { if (!b.length) return res(all); all.push(...b); next(); }, () => res(all)); next(); });
    const walk = async (entry, prefix) => {
      if (entry.isFile) await new Promise((res) => entry.file((f) => { out.push({ file: f, path: prefix + f.name }); res(); }, res));
      else if (entry.isDirectory) for (const child of await readAll(entry.createReader())) await walk(child, prefix + entry.name + "/");
    };
    for (const e of entries) await walk(e, "");
    return out;
  }

  let dragDepth = 0;
  addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; });
  addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); });
  addEventListener("dragover", (e) => e.preventDefault());
  addEventListener("drop", async (e) => {
    e.preventDefault(); dragDepth = 0;
    const files = await filesFromDrop(e.dataTransfer);
    if (files.length) setPending(files);
  });
  addEventListener("paste", (e) => {
    if (e.target.closest?.("input, textarea")) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); setPending(files.map((f) => ({ file: f, path: f.name || "clipboard.png" }))); }
  });

  /* ================= WebRTC connection ================= */
  class Conn {
    constructor(peerId) {
      this.peerId = peerId;
      this.polite = me.id < peerId;
      this.waiters = [];
      this.cancelled = new Set();
      this.dead = false;
      this.route = null;      // "direct" | "relay" — รู้หลังเชื่อมต่อแล้ว
      this.chunk = CHUNK;
      const pc = this.pc = new RTCPeerConnection({ iceServers: CFG.ice_servers, iceTransportPolicy: FORCE_RELAY ? "relay" : "all" });
      const dc = this.dc = pc.createDataChannel("fling", { negotiated: true, id: 0, ordered: true });
      dc.binaryType = "arraybuffer";
      dc.bufferedAmountLowThreshold = LOW_WATER;
      this.opened = new Promise((res, rej) => {
        dc.onopen = () => {
          const max = pc.sctp?.maxMessageSize;
          this.chunk = max ? Math.max(CHUNK_MIN, Math.min(CHUNK, max)) : CHUNK;
          this.detectRoute();
          res();
        };
        this.rejectOpen = rej;
      });
      this.opened.catch(() => {});
      dc.onmessage = (e) => onData(this, e.data);
      dc.onclose = () => this.kill("closed");
      let makingOffer = false, ignoreOffer = false;
      const signal = (data) => (via.get(peerId) || [...rooms.values()][0]?.signal)?.send(peerId, data);
      pc.onicecandidate = ({ candidate }) => candidate && signal({ candidate: candidate.toJSON() });
      pc.onnegotiationneeded = async () => {
        try { makingOffer = true; await pc.setLocalDescription(); signal({ description: pc.localDescription.toJSON() }); }
        catch (e) { console.warn(e); } finally { makingOffer = false; }
      };
      // เน็ตสะดุด/สลับ Wi-Fi: ลองหาเส้นทางใหม่ (ICE restart) 1 ครั้งก่อนยอมแพ้
      pc.onconnectionstatechange = () => {
        const st = pc.connectionState;
        if (st === "connected") { clearTimeout(this.failTimer); this.detectRoute(); }
        if (st === "failed") {
          if (this.restarted || !pc.restartIce) return this.kill("failed");
          this.restarted = true;
          pc.restartIce();
          this.failTimer = setTimeout(() => { if (pc.connectionState !== "connected") this.kill("failed"); }, 12000);
        }
      };
      // จัดคิวให้ประมวลผลสัญญาณตามลำดับ (กัน ICE candidate มาก่อน remote description)
      this.sigQ = Promise.resolve();
      this.onSignal = (data) => { this.sigQ = this.sigQ.then(() => handle(data)); };
      const handle = async ({ description, candidate }) => {
        try {
          if (description) {
            const collision = description.type === "offer" && (makingOffer || pc.signalingState !== "stable");
            ignoreOffer = !this.polite && collision;
            if (ignoreOffer) return;
            await pc.setRemoteDescription(description);
            if (description.type === "offer") { await pc.setLocalDescription(); signal({ description: pc.localDescription.toJSON() }); }
          } else if (candidate) {
            try { await pc.addIceCandidate(candidate); } catch (e) { if (!ignoreOffer) throw e; }
          }
        } catch (e) { console.warn("signal error", e); }
      };
    }
    async ready(ms = 20000) {
      if (this.dc.readyState === "open") return;
      let t;
      await Promise.race([this.opened, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t));
    }
    json(o) { this.dc.send(JSON.stringify(o)); }
    // รอจนคิวลดลงต่ำกว่า LOW_WATER — ใช้ event เป็นหลัก + poll สั้นๆ เผื่อเบราว์เซอร์ที่ event ไม่ยิง
    async drain() {
      if (this.dc.bufferedAmount <= HIGH_WATER) return;
      while (this.dc.bufferedAmount > LOW_WATER) {
        if (this.dead || this.dc.readyState !== "open") throw new Error("closed");
        await new Promise((r) => {
          const done = () => { clearInterval(iv); this.dc.removeEventListener("bufferedamountlow", done); r(); };
          const iv = setInterval(() => { if (this.dc.bufferedAmount <= LOW_WATER || this.dead) done(); }, 50);
          this.dc.addEventListener("bufferedamountlow", done);
        });
      }
    }
    // ดูว่าต่อตรง (host/srflx) หรือผ่าน TURN (relay)
    async detectRoute() {
      try {
        const stats = await this.pc.getStats();
        let pair = null;
        stats.forEach((s) => { if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
        if (!pair) stats.forEach((s) => { if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") pair = s; });
        const local = pair && stats.get(pair.localCandidateId);
        const remote = pair && stats.get(pair.remoteCandidateId);
        if (local) this.route = local.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
      } catch {}
    }
    waitFor(pred, ms = 0) {
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, reject };
        if (ms) w.timer = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error("timeout")); }, ms);
        this.waiters.push(w);
      });
    }
    kill(reason) {
      if (this.dead) return;
      this.dead = true;
      clearTimeout(this.failTimer);
      this.rejectOpen?.(new Error(reason));
      this.waiters.forEach((w) => { clearTimeout(w.timer); w.reject(new Error(reason)); });
      this.waiters = [];
      try { this.pc.close(); } catch {}
      const p = peers.get(this.peerId);
      if (p?.conn === this) p.conn = null;
      if (this.incoming) { toast(`การรับไฟล์จาก ${this.incoming.from} ขาดการเชื่อมต่อ`, true); endIncoming(this); }
    }
  }

  function getConn(id) {
    const p = peers.get(id);
    if (p && p.conn && !p.conn.dead) return p.conn;
    const c = new Conn(id);
    if (p) p.conn = c; else orphanConns.set(id, c);
    return c;
  }
  const orphanConns = new Map(); // สัญญาณมาก่อน presence
  function onSignal(from, data) {
    let c = peers.get(from)?.conn || orphanConns.get(from);
    if (!c || c.dead) {
      c = new Conn(from);
      const p = peers.get(from);
      if (p) p.conn = c; else orphanConns.set(from, c);
    }
    c.onSignal(data);
  }
  setInterval(() => { for (const [id, c] of orphanConns) if (peers.has(id)) { const p = peers.get(id); if (!p.conn || p.conn.dead) p.conn = c; orphanConns.delete(id); } else if (c.dead) orphanConns.delete(id); }, 1000);

  /* ================= sending ================= */
  let activeTransfers = 0;
  let wakeLock = null;
  async function busyStart() { activeTransfers++; try { if (!wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request("screen"); } catch {} }
  function busyEnd() { activeTransfers = Math.max(0, activeTransfers - 1); if (!activeTransfers && wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; } }
  addEventListener("beforeunload", (e) => { if (activeTransfers) { e.preventDefault(); e.returnValue = ""; } });

  function queueSend(id, files) {
    const p = peers.get(id);
    if (!p) return;
    p.queue = p.queue.then(() => sendFiles(id, files)).catch(() => {});
  }

  async function connect(id) {
    const conn = getConn(id);
    setPeerProgress(id, 0, "กำลังเชื่อมต่อ…", "waiting");
    try { await conn.ready(); return conn; }
    catch {
      setPeerProgress(id, 0, "", "idle");
      toast(CFG.turn
        ? "เชื่อมต่อไม่สำเร็จ แม้ผ่าน TURN — ลองใหม่อีกครั้ง หรือสลับเครือข่าย"
        : "เชื่อมต่อแบบ P2P ไม่สำเร็จ — เครือข่ายนี้บล็อกการต่อตรง (ผู้ดูแลต้องตั้ง TURN server)", true, 5000);
      conn.kill("timeout");
      return null;
    }
  }
  const routeLabel = (conn) => (conn?.route === "relay" ? " · 🔁 TURN" : conn?.route === "direct" ? " · ⚡ ตรง" : "");
  const fmtEta = (s) => (!isFinite(s) || s <= 0 ? "" : s < 60 ? ` · เหลือ ${Math.ceil(s)} วิ` : ` · เหลือ ${Math.ceil(s / 60)} นาที`);
  // อ่านไฟล์ล่วงหน้า 1 ช่วง: ระหว่างส่งช่วงนี้ ดิสก์ก็อ่านช่วงถัดไปไปพร้อมกัน
  async function* readBlocks(file) {
    let next = file.size ? file.slice(0, READ).arrayBuffer() : null;
    for (let off = 0; off < file.size; off += READ) {
      const buf = await next;
      next = off + READ < file.size ? file.slice(off + READ, off + 2 * READ).arrayBuffer() : null;
      yield buf;
    }
  }

  async function sendFiles(id, files) {
    const p = peers.get(id);
    if (!p) return;
    const total = files.reduce((s, f) => s + f.file.size, 0);
    await busyStart();
    const conn = await connect(id);
    if (!conn) return busyEnd();
    const tid = rid();
    const job = { cancelled: false };
    p.cancel = () => { job.cancelled = true; try { conn.json({ t: "x", tid }); } catch {} };
    try {
      conn.json({ t: "req", tid, from: me.name, emoji: me.emoji, total, files: files.map((f) => ({ name: f.path, size: f.file.size, type: f.file.type })) });
      setPeerProgress(id, 0, "รออีกฝ่ายตอบรับ…", "waiting");
      const ans = await conn.waitFor((m) => m.tid === tid && ["acc", "dec", "x"].includes(m.t), 120000);
      if (ans.t !== "acc") { toast(`${p.info.name} ปฏิเสธการรับไฟล์`, true); return; }
      // ลงทะเบียนรอ "ได้รับครบ" ตั้งแต่ก่อนเริ่มส่ง — กันข้อความยืนยันมาถึงก่อนที่เราจะเริ่มรอ
      const finished = conn.waitFor((m) => m.tid === tid && (m.t === "ok" || m.t === "x"));
      finished.then((m) => { if (m.t === "x") job.remoteCancel = true; }, () => {});
      let queued = 0, last = 0;
      const t0 = performance.now();
      const chunk = conn.chunk;
      // ความเร็ว/เปอร์เซ็นต์คิดจาก "ส่งถึงจริง" = ใส่คิวแล้ว - ที่ยังค้างในคิว (ไม่หลอกตาช่วงแรก)
      const report = (force) => {
        const now = performance.now();
        if (!force && now - last < 150) return;
        last = now;
        const done = Math.max(0, queued - conn.dc.bufferedAmount);
        const speed = done / Math.max((now - t0) / 1000, .001);
        const frac = total ? done / total : 1;
        setPeerProgress(id, frac, `${Math.floor(frac * 100)}% · ${fmtSize(speed)}/s${fmtEta((total - done) / speed)}${routeLabel(conn)}`);
      };
      for (let i = 0; i < files.length; i++) {
        const f = files[i].file;
        conn.json({ t: "fs", tid, i });
        for await (const buf of readBlocks(f)) {
          for (let o = 0; o < buf.byteLength; o += chunk) {
            if (job.cancelled) throw new Error("cancelled");
            if (job.remoteCancel) throw new Error("cancelled-remote");
            await conn.drain();
            const len = Math.min(chunk, buf.byteLength - o);
            conn.dc.send(new Uint8Array(buf, o, len)); // view แทน slice = ไม่ต้องคัดลอกหน่วยความจำ
            queued += len;
            report();
          }
        }
        conn.json({ t: "fe", tid, i });
      }
      while (conn.dc.bufferedAmount > 0 && !conn.dead && !job.cancelled) { report(); await sleep(100); }
      if (job.cancelled) throw new Error("cancelled");
      report(true);
      setPeerProgress(id, 1, "รอยืนยันจากผู้รับ…");
      const fin = await finished;
      if (fin.t === "x") throw new Error("cancelled-remote");
      flashDone(id);
      toast(`ส่ง ${files.length} รายการ (${fmtSize(total)}) ให้ ${p.info.name} สำเร็จ`);
    } catch (e) {
      if (e.message === "cancelled") toast("ยกเลิกการส่งแล้ว");
      else if (e.message === "cancelled-remote") toast(`${p.info.name} ยกเลิกการรับ`, true);
      else if (e.message === "timeout") { try { conn.json({ t: "x", tid }); } catch {} toast(`${p.info.name} ไม่ตอบรับภายใน 2 นาที`, true); }
      else toast(`การส่งให้ ${p.info.name} ล้มเหลว (${e.message})`, true);
    } finally {
      p.cancel = null;
      setPeerProgress(id, 0, "", "idle");
      busyEnd();
    }
  }

  async function confirmCancel(id) {
    const p = peers.get(id);
    const yes = await openModal((box, close) => {
      box.innerHTML = `<div class="m-title">ยกเลิกการส่งให้ ${esc(p.info.name)}?</div>
        <div class="m-actions"><button class="btn ghost" data-v="0">ส่งต่อ</button><button class="btn" data-v="1">ยกเลิกการส่ง</button></div>`;
      box.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) close(b.dataset.v === "1"); };
    });
    if (yes) peers.get(id)?.cancel?.();
  }

  /* ---------- ข้อความ ---------- */
  async function composeText(id) {
    const p = peers.get(id);
    if (!p) return;
    const text = await openModal((box, close) => {
      box.innerHTML = `
        <div class="m-head"><div class="m-avatar" style="--h:${hueOf(id)}">${esc(p.info.emoji)}</div><div><div class="m-title">ส่งข้อความถึง ${esc(p.info.name)}</div><div class="m-sub">ข้อความ ลิงก์ หรือโค้ด — ส่งตรงไม่ผ่านเซิร์ฟเวอร์</div></div></div>
        <textarea class="field" id="msgText" placeholder="พิมพ์หรือวางข้อความที่นี่…" autofocus></textarea>
        <div class="m-actions"><button class="btn ghost" data-v="0">ยกเลิก</button><button class="btn" data-v="1">${ICON.send}ส่ง</button></div>`;
      const ta = box.querySelector("#msgText");
      ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) close(ta.value); });
      box.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) close(b.dataset.v === "1" ? ta.value : null); };
    });
    if (text && text.trim()) sendText(id, text);
  }
  async function sendText(id, body) {
    const p = peers.get(id);
    if (!p) return;
    p.queue = p.queue.then(async () => {
      const conn = await connect(id);
      if (!conn) return;
      try { conn.json({ t: "txt", body, from: me.name, emoji: me.emoji }); flashDone(id); toast(`ส่งข้อความให้ ${p.info.name} แล้ว`); }
      catch { toast("ส่งข้อความไม่สำเร็จ", true); }
      finally { setPeerProgress(id, 0, "", "idle"); }
    }).catch(() => {});
  }

  /* ================= receiving ================= */
  const autoAccept = new Set();
  function onData(conn, data) {
    if (typeof data !== "string") return onChunk(conn, data);
    let m;
    try { m = JSON.parse(data); } catch { return; }
    for (const w of [...conn.waiters]) if (w.pred(m)) { clearTimeout(w.timer); conn.waiters = conn.waiters.filter((x) => x !== w); w.resolve(m); }
    const inc = conn.incoming;
    switch (m.t) {
      case "req": return askAccept(conn, m);
      case "fs":
        if (inc?.tid === m.tid) inc.cur = { meta: inc.files[m.i], chunks: [], parts: [], pending: 0 };
        return;
      case "fe":
        if (inc?.tid === m.tid && inc.cur) finishFile(conn, inc);
        if (inc?.tid === m.tid && m.i === inc.files.length - 1) finishIncoming(conn, inc);
        return;
      case "x":
        conn.cancelled.add(m.tid);
        if (inc?.tid === m.tid) { toast(`${inc.from} ยกเลิกการส่ง`, true); endIncoming(conn); }
        if (conn.pendingReq?.tid === m.tid) conn.pendingReq.dismiss();
        return;
      case "txt": return showText(conn.peerId, m);
    }
  }

  function onChunk(conn, buf) {
    const inc = conn.incoming;
    if (!inc?.cur) return;
    const cur = inc.cur;
    cur.chunks.push(buf);
    cur.pending += buf.byteLength;
    inc.got += buf.byteLength;
    if (cur.pending >= SPILL) { cur.parts.push(new Blob(cur.chunks)); cur.chunks = []; cur.pending = 0; }
    const now = performance.now();
    if (now - inc.lastUi > 120) {
      inc.lastUi = now;
      const speed = inc.got / Math.max((now - inc.t0) / 1000, .001);
      const frac = inc.total ? inc.got / inc.total : 1;
      setPeerProgress(conn.peerId, frac, `รับ ${Math.floor(frac * 100)}% · ${fmtSize(speed)}/s${fmtEta((inc.total - inc.got) / speed)}${routeLabel(conn)}`);
    }
  }

  async function askAccept(conn, m) {
    const p = peers.get(conn.peerId);
    const name = p?.info.name || m.from;
    let accept = autoAccept.has(conn.peerId);
    let remember = false;
    if (!accept) {
      const res = await openModal((box, close, ctl) => {
        const n = m.files.length;
        const items = m.files.slice(0, 50).map((f) => `<li><span class="thumb" style="width:30px;height:30px;font-size:8.5px;border-radius:9px">${esc(extOf(f.name))}</span><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span><span class="sz">${fmtSize(f.size)}</span></li>`).join("")
          + (n > 50 ? `<li><span class="nm" style="color:var(--faint)">…และอีก ${n - 50} ไฟล์</span></li>` : "");
        box.innerHTML = `
          <div class="m-head"><div class="m-avatar" style="--h:${hueOf(conn.peerId)}">${esc(m.emoji || "📦")}</div>
            <div><div class="m-title">${esc(name)} ต้องการส่ง ${n} ไฟล์</div><div class="m-sub">รวม ${fmtSize(m.total)}</div></div></div>
          <ul class="m-list">${items}</ul>
          <label class="m-check"><input type="checkbox" id="remember"> รับจาก ${esc(name)} อัตโนมัติในครั้งต่อไป</label>
          <div class="m-actions"><button class="btn ghost" data-v="0">ปฏิเสธ</button><button class="btn" data-v="1" autofocus>${ICON.save}รับไฟล์</button></div>`;
        box.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) { remember = box.querySelector("#remember").checked; close(b.dataset.v === "1"); } };
        ctl.onDismiss = () => close(false);
        conn.pendingReq = { tid: m.tid, dismiss: () => { toast(`${name} ยกเลิกการส่ง`, true); close(null); } };
      });
      conn.pendingReq = null;
      if (res === null) return;
      accept = res;
      if (accept && remember) autoAccept.add(conn.peerId);
    }
    if (conn.dead || conn.cancelled.has(m.tid)) return;
    if (!accept) { try { conn.json({ t: "dec", tid: m.tid }); } catch {} return; }
    conn.incoming = { tid: m.tid, from: name, files: m.files, total: m.total, got: 0, t0: performance.now(), lastUi: 0, received: [] };
    const p2 = peers.get(conn.peerId);
    if (p2) p2.cancel = () => { try { conn.json({ t: "x", tid: m.tid }); } catch {} toast("ยกเลิกการรับแล้ว"); endIncoming(conn); };
    await busyStart();
    setPeerProgress(conn.peerId, 0, "รับ 0%");
    conn.json({ t: "acc", tid: m.tid });
  }

  function finishFile(conn, inc) {
    const cur = inc.cur;
    const blob = new Blob([...cur.parts, new Blob(cur.chunks)], { type: cur.meta.type || "application/octet-stream" });
    inc.cur = null;
    inc.received.push(addToTray({ name: cur.meta.name, blob, from: inc.from }));
  }
  function finishIncoming(conn, inc) {
    try { conn.json({ t: "ok", tid: inc.tid }); } catch {}
    const items = inc.received;
    endIncoming(conn);
    flashDone(conn.peerId);
    if (items.length <= AUTOSAVE_MAX) { items.forEach((it, i) => setTimeout(() => saveItem(it), i * 350)); toast(`ได้รับ ${items.length} ไฟล์จาก ${inc.from} — บันทึกแล้ว`); }
    else { toast(`ได้รับ ${items.length} ไฟล์จาก ${inc.from} — กด "บันทึกเป็น .zip" ในถาด`, false, 5000); openTray(); }
  }
  function endIncoming(conn) {
    if (!conn.incoming) return;
    conn.incoming = null;
    const p = peers.get(conn.peerId);
    if (p) p.cancel = null;
    setPeerProgress(conn.peerId, 0, "", "idle");
    busyEnd();
  }

  async function showText(peerId, m) {
    const p = peers.get(peerId);
    const name = p?.info.name || m.from;
    const isUrl = /^https?:\/\/\S+$/i.test(m.body.trim());
    await openModal((box, close) => {
      box.innerHTML = `
        <div class="m-head"><div class="m-avatar" style="--h:${hueOf(peerId)}">${esc(m.emoji || "💬")}</div><div><div class="m-title">ข้อความจาก ${esc(name)}</div><div class="m-sub">${m.body.length.toLocaleString()} ตัวอักษร</div></div></div>
        <div class="text-view"></div>
        <div class="m-actions">${isUrl ? '<button class="btn ghost" data-a="open">เปิดลิงก์</button>' : '<button class="btn ghost" data-a="close">ปิด</button>'}<button class="btn" data-a="copy" autofocus>คัดลอก</button></div>`;
      box.querySelector(".text-view").textContent = m.body;
      box.onclick = async (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "copy") { try { await navigator.clipboard.writeText(m.body); toast("คัดลอกแล้ว"); } catch { toast("คัดลอกไม่ได้", true); } close(); }
        else if (a === "open") { window.open(m.body.trim(), "_blank", "noopener"); close(); }
        else if (a === "close") close();
      };
    });
  }

  /* ================= tray ================= */
  const tray = [];
  function addToTray({ name, blob, from }) {
    const item = { id: rid(), name, blob, from, url: URL.createObjectURL(blob), at: new Date() };
    tray.unshift(item);
    const li = document.createElement("li");
    li.className = "tray-item";
    li.dataset.id = item.id;
    const thumb = blob.type.startsWith("image/") && blob.size < 30 * 1048576 ? `<img src="${item.url}" alt="">` : esc(extOf(name));
    li.innerHTML = `<div class="thumb">${thumb}</div><div class="meta"><div class="nm"></div><div class="sub"></div></div><button class="icon-btn" aria-label="บันทึก">${ICON.save}</button>`;
    li.querySelector(".nm").textContent = name;
    li.querySelector(".nm").title = name;
    li.querySelector(".sub").textContent = `${fmtSize(blob.size)} · จาก ${from}`;
    li.querySelector("button").onclick = () => saveItem(item);
    $("trayList").prepend(li);
    $("trayList").querySelector(".tray-empty")?.remove();
    updateTrayCount(true);
    return item;
  }
  function updateTrayCount(bump) {
    $("trayCount").textContent = tray.length;
    $("trayToggle").hidden = tray.length === 0 || $("tray").classList.contains("open");
    $("zipAll").hidden = tray.length < 2;
    if (bump) { const t = $("trayToggle"); t.classList.remove("bump"); void t.offsetWidth; t.classList.add("bump"); }
  }
  function saveItem(item) {
    const a = document.createElement("a");
    a.href = item.url;
    a.download = item.name.split("/").join(" - ");
    document.body.appendChild(a); a.click(); a.remove();
  }
  function openTray() { $("tray").classList.add("open"); updateTrayCount(); }
  function closeTray() { $("tray").classList.remove("open"); updateTrayCount(); }
  $("trayToggle").onclick = openTray;
  $("closeTray").onclick = closeTray;
  $("clearTray").onclick = () => { tray.forEach((i) => URL.revokeObjectURL(i.url)); tray.length = 0; $("trayList").innerHTML = ""; closeTray(); };
  $("zipAll").onclick = async () => {
    if (!window.fflate) return toast("โหลดตัวบีบอัดไม่สำเร็จ — บันทึกทีละไฟล์แทน", true);
    const total = tray.reduce((s, i) => s + i.blob.size, 0);
    if (total > ZIP_LIMIT) return toast(`ไฟล์รวม ${fmtSize(total)} ใหญ่เกินจะรวม zip ในเบราว์เซอร์ — บันทึกทีละไฟล์`, true, 5000);
    const btn = $("zipAll"); btn.disabled = true; btn.textContent = "กำลังรวม…";
    try {
      const files = {};
      const used = new Set();
      for (const it of tray) {
        let n = it.name, k = 1;
        while (used.has(n)) n = it.name.replace(/(\.[^.\/]+)?$/, ` (${k++})$1`);
        used.add(n);
        files[n] = [new Uint8Array(await it.blob.arrayBuffer()), { level: 0 }];
      }
      const zipped = await new Promise((res, rej) => fflate.zip(files, (err, out) => (err ? rej(err) : res(out))));
      const url = URL.createObjectURL(new Blob([zipped], { type: "application/zip" }));
      saveItem({ url, name: `flingfile-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.zip` });
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast("รวม zip ไม่สำเร็จ: " + e.message, true); }
    finally { btn.disabled = false; btn.textContent = "บันทึกเป็น .zip"; }
  };

  /* ================= profile ================= */
  function renderMe() {
    $("meEmoji").textContent = me.emoji;
    $("meName").textContent = me.name;
    $("meSub").textContent = me.device;
    document.title = `Flingfile — ${me.name}`;
  }
  $("meOrb").onclick = async () => {
    let emoji = me.emoji;
    const res = await openModal((box, close) => {
      box.innerHTML = `
        <div class="m-title">ตั้งชื่อเครื่องนี้</div><div class="m-sub" style="margin-bottom:14px">อุปกรณ์อื่นจะเห็นชื่อและไอคอนนี้</div>
        <input class="field" id="nm" maxlength="24" autofocus>
        <div class="emoji-grid">${ANIMALS.map(([e]) => `<button data-e="${e}" class="${e === emoji ? "on" : ""}">${e}</button>`).join("")}</div>
        <div class="m-actions"><button class="btn ghost" data-v="0">ยกเลิก</button><button class="btn" data-v="1">บันทึก</button></div>`;
      const input = box.querySelector("#nm");
      input.value = me.name;
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") close({ name: input.value, emoji }); });
      box.onclick = (e) => {
        const eb = e.target.closest("[data-e]");
        if (eb) { emoji = eb.dataset.e; box.querySelectorAll("[data-e]").forEach((b) => b.classList.toggle("on", b === eb)); return; }
        const b = e.target.closest("[data-v]");
        if (b) close(b.dataset.v === "1" ? { name: input.value, emoji } : null);
      };
    });
    if (!res) return;
    me.name = res.name.trim().slice(0, 24) || me.name;
    me.emoji = res.emoji;
    store.set("me", { name: me.name, emoji: me.emoji });
    renderMe();
    rooms.forEach((r) => r.signal.update());
    toast("บันทึกชื่อแล้ว");
  };

  /* ================= pairing (ข้ามเครือข่าย) ================= */
  const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const pairLink = (code) => `${location.origin}${location.pathname}?room=${code}`;
  function joinPair(code) {
    code = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (code.length !== 6) return false;
    joinRoom("pair-" + code, "pair", code);
    return true;
  }
  $("pairBtn").onclick = () => openModal((box, close) => {
    const existing = [...rooms.values()].find((r) => r.kind === "pair");
    const code = existing?.label || Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => PAIR_ALPHABET[b % PAIR_ALPHABET.length]).join("");
    box.innerHTML = `
      <div class="m-section">
        <div class="m-title">รหัสจับคู่อุปกรณ์</div>
        <div class="m-sub" style="margin-bottom:14px">ใช้สำหรับเครือข่ายที่ต่างกัน (เช่น Wi-Fi ↔ 4G-5G)</div>
        <div class="tiles">${[...code].map((c, i) => `<span style="--i:${i}">${c}</span>`).join("")}</div>
        <div class="qr-row"><div class="qr-box" id="qr"></div><div class="m-sub">สแกนด้วยมือถือ หรือเปิดลิงก์นี้บนอีกเครื่อง<a href="${pairLink(code)}" target="_blank" rel="noopener">${pairLink(code)}</a></div></div>
        <div class="m-actions"><button class="btn ghost" data-a="copy">คัดลอกลิงก์</button><button class="btn" data-a="join">${existing ? "อยู่ในห้องแล้ว" : "สร้างห้อง"}</button></div>
      </div>
      <div class="m-section">
        <div class="m-title" style="font-size:15px">กรอกรหัสเพื่อเชื่อมต่อ</div>
        <div class="otp" id="otp" style="margin-top:12px"></div>
      </div>
      <div class="m-section">
        <div class="m-title" style="font-size:15px">จับคู่ด้วย QR ไม่ผ่านเซิร์ฟเวอร์</div>
        <div class="m-sub">ใช้เมื่อเครื่องหากันไม่เจอ — สแกน QR กันสองรอบ</div>
        <div class="m-actions"><button class="btn ghost" data-a="qrscan">สแกน QR</button><button class="btn" data-a="qrmake">สร้าง QR</button></div>
      </div>`;
    if (existing) box.querySelector('[data-a="join"]').disabled = true;
    if (window.qrcode) { const q = qrcode(0, "M"); q.addData(pairLink(code)); q.make(); box.querySelector("#qr").innerHTML = q.createSvgTag({ cellSize: 3, margin: 0, scalable: true }); }
    else box.querySelector("#qr").remove();
    const otp = box.querySelector("#otp");
    const boxes = Array.from({ length: 6 }, (_, i) => {
      const el = document.createElement("input");
      el.maxLength = 1; el.autocomplete = "off"; el.spellcheck = false; el.setAttribute("aria-label", `รหัสหลักที่ ${i + 1}`);
      otp.appendChild(el);
      return el;
    });
    const clean = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const tryJoin = () => {
      const v = boxes.map((b) => b.value).join("");
      if (v.length < 6) return;
      if (v === code && !existing) { joinPair(code); toast("เปิดห้อง " + code + " แล้ว"); return close(); }
      if (joinPair(v)) { toast("เข้าห้อง " + v + " แล้ว — รออีกเครื่อง…"); close(); }
      else { otp.classList.remove("shake"); void otp.offsetWidth; otp.classList.add("shake"); }
    };
    const fill = (s, start) => { [...clean(s)].slice(0, 6 - start).forEach((c, k) => (boxes[start + k].value = c)); (boxes.find((b) => !b.value) || boxes[5]).focus(); tryJoin(); };
    boxes.forEach((b, i) => {
      b.addEventListener("input", () => { const v = clean(b.value); if (v.length > 1) { b.value = ""; return fill(v, i); } b.value = v; if (v && i < 5) boxes[i + 1].focus(); tryJoin(); });
      b.addEventListener("keydown", (e) => { if (e.key === "Backspace" && !b.value && i > 0) { boxes[i - 1].value = ""; boxes[i - 1].focus(); e.preventDefault(); } });
      b.addEventListener("paste", (e) => { e.preventDefault(); fill(e.clipboardData.getData("text"), i); });
    });
    box.onclick = async (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (a === "copy") { try { await navigator.clipboard.writeText(pairLink(code)); toast("คัดลอกลิงก์แล้ว"); } catch { toast("คัดลอกไม่ได้", true); } if (!existing) joinPair(code); }
      else if (a === "join") { joinPair(code); toast("เปิดห้อง " + code + " แล้ว — รออีกเครื่องเข้ามา"); close(); }
      else if (a === "qrmake") { close(); qrInvite(); }
      else if (a === "qrscan") { close(); qrScanInvite(); }
    };
  });

  /* ================= จับคู่ด้วย QR (ไม่ผ่านเซิร์ฟเวอร์) ================= */
  // เครื่อง A สร้าง "รหัสเชิญ" (SDP offer ย่อ) → B สแกน แล้วแสดง "รหัสตอบกลับ" (answer) → A สแกน
  // ได้ DataChannel ตรงระหว่างกัน แล้วใช้เป็นท่อสัญญาณ (LinkSignal) ให้ Conn ส่งไฟล์ตามปกติ
  const QR_TAG = "FF1.";
  const QR_GATHER_MS = 4000;
  const b64u = {
    enc: (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
    dec: (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
  };
  const CAND_TYPES = { h: "host", s: "srflx", p: "prflx", r: "relay" };
  // เก็บเฉพาะส่วนที่จำเป็นของ SDP (data channel อย่างเดียว) ให้ QR เล็กพอสแกนจากจอได้ง่าย
  function packSdp(kind, sdp) {
    const get = (re) => (re.exec(sdp) || [])[1] || "";
    const fp = get(/a=fingerprint:sha-256 ([0-9A-F:]+)/i);
    const u = get(/a=ice-ufrag:(\S+)/), w = get(/a=ice-pwd:(\S+)/);
    if (!fp || !u || !w) throw new Error("sdp");
    const cands = [...sdp.matchAll(/a=candidate:\S+ 1 udp (\d+) (\S+) (\d+) typ (host|srflx|prflx|relay)/gi)]
      .map((m) => ({ pr: +m[1], a: m[2], p: m[3], t: m[4][0] }))
      .sort((x, y) => y.pr - x.pr).slice(0, 6)
      .map((c) => `${c.t} ${c.a} ${c.p} ${c.pr}`);
    const fpb = btoa(String.fromCharCode(...fp.split(":").map((h) => parseInt(h, 16))));
    const data = [kind, u, w, fpb, get(/a=setup:(\S+)/) || "actpass", get(/a=mid:(\S+)/) || "0", cands, [me.id, me.name, me.emoji, me.device]];
    return QR_TAG + b64u.enc(JSON.stringify(data));
  }
  function unpackCode(text) {
    const raw = String(text || "").trim();
    const m = /#ff=([\w-]+)/.exec(raw) || new RegExp("^" + QR_TAG.replace(".", "\\.") + "([\\w-]+)$").exec(raw);
    if (!m) throw new Error("code");
    const [kind, u, w, fpb, setup, mid, cands, who] = JSON.parse(b64u.dec(m[1]));
    if (!/^[oa]$/.test(kind) || !u || !w || !fpb) throw new Error("code");
    const fp = [...atob(fpb)].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0").toUpperCase()).join(":");
    const lines = ["v=0", `o=- ${Date.now()} 2 IN IP4 127.0.0.1`, "s=-", "t=0 0", `a=group:BUNDLE ${mid}`, "a=msid-semantic: WMS",
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
      ...cands.map((c, i) => { const [t, a, p, pr] = c.split(" "); return `a=candidate:${i + 1} 1 udp ${pr} ${a} ${p} typ ${CAND_TYPES[t] || "host"}${t === "h" ? "" : " raddr 0.0.0.0 rport 0"}`; }),
      "a=end-of-candidates", `a=ice-ufrag:${u}`, `a=ice-pwd:${w}`, `a=fingerprint:sha-256 ${fp}`, `a=setup:${setup}`, `a=mid:${mid}`, "a=sctp-port:5000", "a=max-message-size:262144"];
    const [id, name, emoji, device] = who || [];
    return { kind, sdp: lines.join("\r\n") + "\r\n", peer: { id, name: String(name || "อุปกรณ์"), emoji: String(emoji || "📱"), device } };
  }
  const qrInviteUrl = (code) => `${location.origin}${location.pathname}#ff=${code.slice(QR_TAG.length)}`;

  class BootLink {
    constructor() {
      const pc = this.pc = new RTCPeerConnection({ iceServers: CFG.ice_servers });
      const dc = this.dc = pc.createDataChannel("boot", { negotiated: true, id: 0, ordered: true });
      this.opened = new Promise((res, rej) => { dc.onopen = res; this.fail = rej; });
      this.opened.catch(() => {});
      dc.onmessage = (e) => { try { this.onmessage?.(JSON.parse(e.data)); } catch {} };
      dc.onclose = () => { this.fail(new Error("closed")); this.onclose?.(); };
      pc.onconnectionstatechange = () => { if (pc.connectionState === "failed") this.close(); };
    }
    async gather() {
      const pc = this.pc;
      if (pc.iceGatheringState === "complete") return;
      await new Promise((r) => {
        const t = setTimeout(r, QR_GATHER_MS);
        pc.addEventListener("icegatheringstatechange", () => { if (pc.iceGatheringState === "complete") { clearTimeout(t); r(); } });
      });
    }
    async invite() { await this.pc.setLocalDescription(); await this.gather(); return packSdp("o", this.pc.localDescription.sdp); }
    async answer(code) {
      const m = unpackCode(code);
      if (m.kind !== "o") throw new Error("kind");
      this.peer = m.peer;
      await this.pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
      await this.pc.setLocalDescription();
      await this.gather();
      return packSdp("a", this.pc.localDescription.sdp);
    }
    async accept(code) {
      const m = unpackCode(code);
      if (m.kind !== "a") throw new Error("kind");
      this.peer = m.peer;
      await this.pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
    }
    async ready(ms = 20000) {
      let t;
      await Promise.race([this.opened, new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); })]).finally(() => clearTimeout(t));
    }
    send(o) { if (this.dc.readyState === "open") this.dc.send(JSON.stringify(o)); }
    close() { try { this.dc.close(); } catch {} try { this.pc.close(); } catch {} this.fail(new Error("closed")); }
  }
  function joinLink(link) {
    const name = link.peer?.name || "อุปกรณ์";
    joinRoom("qr-" + rid(8), "qr", name, (roomId, h) => new LinkSignal(link, roomId, h));
    toast(`เชื่อมต่อกับ ${name} แล้ว (ผ่าน QR)`);
  }
  function qrSvg(text) {
    if (!window.qrcode) return "";
    const q = qrcode(0, "L"); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 3, margin: 0, scalable: true });
  }
  async function copyText(text, done = "คัดลอกรหัสแล้ว") {
    try { await navigator.clipboard.writeText(text); toast(done); } catch { toast("คัดลอกไม่ได้", true); }
  }

  // กล้องอ่าน QR: BarcodeDetector ถ้ามี (Chrome/Android) ไม่งั้นโหลด jsQR (Safari/Firefox)
  let jsqrLoad = null;
  const loadScript = (src) => new Promise((res, rej) => {
    const el = document.createElement("script");
    el.src = src; el.onload = res; el.onerror = () => rej(new Error("load " + src));
    document.head.appendChild(el);
  });
  async function qrDetector() {
    try {
      if ("BarcodeDetector" in window && (await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
        const d = new BarcodeDetector({ formats: ["qr_code"] });
        return async (src) => (await d.detect(src))[0]?.rawValue || null;
      }
    } catch {}
    await (jsqrLoad ||= loadScript("assets/vendor/jsqr.min.js"));
    return async (src, ctx, w, h) => { ctx.drawImage(src, 0, 0, w, h); return window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: "dontInvert" })?.data || null; };
  }
  function attachScanner(holder, onCode) {
    holder.hidden = false;
    holder.innerHTML = `<video playsinline muted></video><div class="scan-msg">กำลังเปิดกล้อง…</div>`;
    const video = holder.querySelector("video"), msg = holder.querySelector(".scan-msg");
    let stream = null, stopped = false, timer = 0;
    const stop = () => { stopped = true; clearTimeout(timer); stream?.getTracks().forEach((t) => t.stop()); holder.hidden = true; holder.innerHTML = ""; };
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("no camera");
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (stopped) return stop();
        video.srcObject = stream; await video.play();
        msg.textContent = "ส่องกล้องไปที่ QR";
        const detect = await qrDetector();
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tick = async () => {
          if (stopped) return;
          if (video.videoWidth) {
            const k = Math.min(1, 640 / video.videoWidth);
            canvas.width = Math.round(video.videoWidth * k); canvas.height = Math.round(video.videoHeight * k);
            try { const text = await detect(video, ctx, canvas.width, canvas.height); if (text && !stopped) { stop(); return onCode(text); } } catch {}
          }
          timer = setTimeout(tick, 200);
        };
        tick();
      } catch { if (!stopped) msg.textContent = "เปิดกล้องไม่ได้ — วางรหัสในช่องด้านล่างแทน"; }
    })();
    return stop;
  }

  // ฝั่ง A: สร้างรหัสเชิญ แล้วรอสแกน/วางรหัสตอบกลับ
  async function qrInvite() {
    if (!window.RTCPeerConnection) return;
    const link = new BootLink();
    let code;
    try { code = await link.invite(); } catch { link.close(); return toast("สร้าง QR ไม่สำเร็จ", true); }
    let linked = false;
    await openModal((box, close, ctl) => {
      box.innerHTML = `
        <div class="m-title">จับคู่ด้วย QR</div>
        <div class="m-sub">ไม่ผ่านเซิร์ฟเวอร์ — ใช้ได้แม้ระบบค้นหาอุปกรณ์ล่ม</div>
        <div class="m-label qr-step">1. ให้อีกเครื่องสแกน QR นี้ด้วยกล้อง หรือส่งรหัสไปให้</div>
        <div class="qr-big">${qrSvg(qrInviteUrl(code))}</div>
        <div class="m-label qr-step">2. อีกเครื่องจะแสดงรหัสตอบกลับ — สแกนหรือวางที่นี่</div>
        <div class="scan-box" hidden></div>
        <textarea class="field code-field" placeholder="วางรหัสตอบกลับที่ขึ้นต้นด้วย ${QR_TAG}"></textarea>
        <div class="m-status" aria-live="polite"></div>
        <div class="m-actions"><button class="btn ghost" data-a="copy">คัดลอกรหัส</button><button class="btn" data-a="scan" autofocus>สแกนรหัสตอบกลับ</button></div>`;
      const ta = box.querySelector(".code-field"), status = box.querySelector(".m-status");
      let stopScan = null, busy = false;
      const take = async (text) => {
        if (busy) return;
        busy = true; stopScan?.(); stopScan = null;
        status.textContent = "กำลังเชื่อมต่อ…";
        try {
          await link.accept(text);
          await link.ready();
          linked = true; joinLink(link); close();
        } catch (e) {
          busy = false;
          status.textContent = "";
          ta.classList.remove("shake"); void ta.offsetWidth; ta.classList.add("shake");
          toast(e.message === "kind" ? "นี่ไม่ใช่รหัสตอบกลับ — ให้อีกเครื่องสแกนรหัสเชิญก่อน" : e.message === "timeout" ? "เชื่อมต่อไม่สำเร็จ — ลองสร้าง QR ใหม่" : "รหัสไม่ถูกต้อง", true);
          if (e.message === "timeout") close();
        }
      };
      ta.addEventListener("input", () => { if (ta.value.trim().length > 20) take(ta.value); });
      box.onclick = (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "copy") copyText(qrInviteUrl(code));
        else if (a === "scan" && !stopScan) stopScan = attachScanner(box.querySelector(".scan-box"), take);
      };
      ctl.onDismiss = () => { stopScan?.(); close(); };
    });
    if (!linked) link.close();
  }

  // ฝั่ง B: ได้รหัสเชิญ (จากลิงก์ สแกน หรือวาง) → แสดงรหัสตอบกลับ แล้วรอ A สแกน
  async function qrAnswer(inviteCode) {
    if (!window.RTCPeerConnection) return;
    const link = new BootLink();
    let code;
    try { code = await link.answer(inviteCode); }
    catch (e) { link.close(); return toast(e.message === "kind" ? "นี่เป็นรหัสตอบกลับ — ให้สแกนจากเครื่องที่สร้าง QR" : "รหัสไม่ถูกต้อง", true); }
    const name = link.peer.name;
    let linked = false;
    await openModal((box, close, ctl) => {
      box.innerHTML = `
        <div class="m-head"><div class="m-avatar" style="--h:${hueOf(link.peer.id || name)}">${esc(link.peer.emoji)}</div>
          <div><div class="m-title">ส่งรหัสตอบกลับให้ ${esc(name)}</div><div class="m-sub">ให้ ${esc(name)} กด "สแกนรหัสตอบกลับ" แล้วสแกน QR นี้</div></div></div>
        <div class="qr-big">${qrSvg(code)}</div>
        <div class="m-status" aria-live="polite">รอ ${esc(name)} สแกน…</div>
        <div class="m-actions"><button class="btn ghost" data-a="close">ยกเลิก</button><button class="btn" data-a="copy">คัดลอกรหัส</button></div>`;
      box.onclick = (e) => {
        const a = e.target.closest("[data-a]")?.dataset.a;
        if (a === "copy") copyText(code);
        else if (a === "close") close();
      };
      ctl.onDismiss = () => close();
      link.ready(5 * 60 * 1000).then(() => { linked = true; joinLink(link); close(); }, () => { if (!linked) { toast("เชื่อมต่อไม่สำเร็จ — ลองสร้าง QR ใหม่", true); close(); } });
    });
    if (!linked) link.close();
  }

  // สแกน/วางรหัสเชิญจากเครื่องอื่น
  async function qrScanInvite() {
    const code = await openModal((box, close, ctl) => {
      box.innerHTML = `
        <div class="m-title">สแกน QR จากอีกเครื่อง</div>
        <div class="m-sub">ให้อีกเครื่องกด "สร้าง QR" แล้วส่องกล้องที่ QR นั้น</div>
        <div class="scan-box" hidden></div>
        <textarea class="field code-field" placeholder="หรือวางรหัส/ลิงก์ที่ได้รับที่นี่"></textarea>
        <div class="m-actions"><button class="btn ghost" data-v="0">ยกเลิก</button><button class="btn" data-v="1" autofocus>เชื่อมต่อ</button></div>`;
      const ta = box.querySelector(".code-field");
      const stop = attachScanner(box.querySelector(".scan-box"), (text) => close(text));
      const done = (v) => { stop(); close(v); };
      ta.addEventListener("input", () => { if (/#ff=[\w-]{20,}|FF1\.[\w-]{20,}/.test(ta.value)) done(ta.value); });
      box.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) done(b.dataset.v === "1" ? ta.value : null); };
      ctl.onDismiss = () => done(null);
    });
    if (code && code.trim()) qrAnswer(code);
  }

  /* ================= แจ้งเตือนเมื่อต่อระบบค้นหาอุปกรณ์ไม่ได้ ================= */
  let bannerBase = null; // ข้อความปกติ (เช่นโหมดทดสอบ TURN) — คืนค่าเมื่อเลิกแจ้งเตือน
  function showBanner(text, actions = []) {
    const el = $("banner");
    el.hidden = false;
    el.innerHTML = "";
    const span = document.createElement("span");
    span.textContent = text;
    el.appendChild(span);
    if (actions.length) {
      const row = document.createElement("span");
      row.className = "banner-actions";
      for (const [label, fn] of actions) {
        const b = document.createElement("button");
        b.className = "mini-btn"; b.type = "button"; b.textContent = label; b.onclick = fn;
        row.appendChild(b);
      }
      el.appendChild(row);
    }
  }
  function hideBanner() { if (bannerBase) showBanner(bannerBase); else { $("banner").hidden = true; $("banner").innerHTML = ""; } }
  function retryNet() {
    const [id, r] = [...rooms].find(([, r]) => r.kind === "net") || [];
    if (!id) return;
    leaveRoom(id);
    joinRoom(id, "net", r.label);
    toast("กำลังลองเชื่อมต่อใหม่…");
  }
  function netStatus(s) {
    if (!trystero) return; // โหมดแท็บเดียว: แถบแจ้งเตือนตอน boot ค้างไว้
    if (s === "error") showBanner("เชื่อมต่อระบบค้นหาอุปกรณ์ไม่ได้ — เครื่องอื่นจะยังไม่เห็นเครื่องนี้", [["ลองใหม่", retryNet], ["จับคู่ด้วย QR", qrInvite]]);
    else if (s === "live") hideBanner();
  }

  /* ================= ICE (STUN/TURN) refresh ================= */
  // credential TURN มีอายุ — ดึงใหม่ก่อนหมด (การเชื่อมต่อที่เปิดอยู่แล้วไม่กระทบ)
  let iceTimer = 0;
  function scheduleIceRefresh(ttlSec) {
    clearTimeout(iceTimer);
    iceTimer = setTimeout(refreshIce, Math.max(60, ttlSec * 0.8) * 1000);
  }
  async function refreshIce() {
    try {
      const r = await fetch("/api/ice", { cache: "no-store" });
      if (!r.ok) throw 0;
      const d = await r.json();
      if (d.ice_servers?.length) CFG.ice_servers = d.ice_servers;
      CFG.turn = !!d.turn;
      scheduleIceRefresh(d.ttl || 600);
    } catch { scheduleIceRefresh(120); }
  }

  /* ================= ธีมสว่าง/มืด (แบบเดียวกับ QR-Code-Gen) ================= */
  const themeToggle = $("themeToggle");
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  function applyTheme(theme) {
    document.body.classList.toggle("light", theme === "light");
    themeToggle.title = theme === "light" ? "เปลี่ยนเป็นโหมดมืด" : "เปลี่ยนเป็นโหมดสว่าง";
    themeToggle.setAttribute("aria-label", themeToggle.title);
    if (metaTheme) metaTheme.content = theme === "light" ? "#f1f3f9" : "#0a0d16";
  }
  applyTheme(document.body.classList.contains("light") ? "light" : "dark"); // สคริปต์ใน <body> ตั้งไว้แล้ว
  themeToggle.addEventListener("click", () => {
    // เล่นแอนิเมชันกดยุบ-เด้ง (ดู .theme-switch.switching ใน style.css)
    themeToggle.classList.remove("switching"); void themeToggle.offsetWidth; themeToggle.classList.add("switching");
    const next = document.body.classList.contains("light") ? "dark" : "light";
    applyTheme(next);
    store.setRaw("flingfileTheme", next);
  });
  themeToggle.addEventListener("animationend", (e) => { if (e.animationName === "ts-press") themeToggle.classList.remove("switching"); });
  // ผู้ใช้ยังไม่เคยเลือกเอง: ตามธีมของระบบ
  matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", (e) => { if (!store.getRaw("flingfileTheme")) applyTheme(e.matches ? "light" : "dark"); });

  // แท็บถูกซ่อน: หยุดแอนิเมชันที่วนไม่จบ (ประหยัดแบต)
  const syncPause = () => document.documentElement.classList.toggle("fx-paused", document.hidden);
  document.addEventListener("visibilitychange", syncPause);
  syncPause();

  /* ================= boot ================= */
  async function boot() {
    document.body.insertAdjacentHTML("beforeend", '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#38bdf8"/></linearGradient></defs></svg>');
    renderMe();
    refineDeviceLabel(me.device).then((d) => {
      if (d === me.device) return;
      me.device = d;
      renderMe();
      rooms.forEach((r) => r.signal.update());
    });
    if (!window.RTCPeerConnection) {
      $("banner").hidden = false;
      $("banner").textContent = "เบราว์เซอร์นี้ไม่รองรับ WebRTC — ลองใช้ Chrome, Edge, Safari หรือ Firefox รุ่นใหม่";
      return;
    }
    let netRoom = null;
    try {
      const [cfg, room] = await Promise.all([
        fetch("/api/config").then((r) => (r.ok ? r.json() : {})),
        fetch("/api/room").then((r) => (r.ok ? r.json() : {})),
      ]);
      if (cfg.ice_servers?.length) CFG.ice_servers = cfg.ice_servers;
      CFG.turn = !!cfg.turn;
      CFG.nostr_relays = cfg.nostr_relays || [];
      scheduleIceRefresh(600);
      netRoom = room.room || null;
    } catch {}
    try { trystero = await import("./vendor/trystero.min.mjs"); } catch { trystero = null; }
    if (FORCE_RELAY) {
      bannerBase = CFG.turn
        ? "โหมดทดสอบ TURN: บังคับส่งผ่าน TURN server (ให้อีกเครื่องเปิดลิงก์ที่มี ?relay=1 ด้วย)"
        : "โหมดทดสอบ TURN: เซิร์ฟเวอร์ยังไม่ได้ตั้ง TURN — จะเชื่อมต่อไม่ได้";
      showBanner(bannerBase);
    }
    if (!trystero) {
      // โหลดระบบค้นหาไม่ได้ → เห็นเฉพาะแท็บในเบราว์เซอร์นี้ + ทางสำรอง QR
      bannerBase = null;
      showBanner("โหลดระบบค้นหาอุปกรณ์ไม่สำเร็จ — ตอนนี้เห็นเฉพาะแท็บอื่นในเบราว์เซอร์นี้", [["โหลดใหม่", () => location.reload()], ["จับคู่ด้วย QR", qrInvite]]);
    }
    joinRoom(netRoom || "local", "net", "เครือข่ายเดียวกัน");
    const params = new URLSearchParams(location.search);
    const pair = params.get("room");
    if (pair && joinPair(pair)) toast(`เข้าห้อง ${pair.toUpperCase()} แล้ว`);
    if (pair) history.replaceState(null, "", location.pathname);
    // เปิดจากลิงก์/QR เชิญ (#ff=...) → แสดงรหัสตอบกลับทันที (hash ไม่ถูกส่งไปที่เซิร์ฟเวอร์)
    if (location.hash.startsWith("#ff=")) {
      const invite = location.hash;
      history.replaceState(null, "", location.pathname + location.search);
      qrAnswer(invite);
    }
    addEventListener("pagehide", () => rooms.forEach((r) => r.signal.stop()));
    layout();
  }
  boot();
})();
