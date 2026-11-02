// Kreide-Arena game server: serves the page and runs every arena authoritatively.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const wsLite = require("./ws-lite.js");
const KA = require("./shared/game.js");
const { C, WEAP, PU, MAPS, SIZES, clamp } = KA;

const PORT = process.env.PORT || 3000;
const DT = 1 / C.TICK;

// ---------- static files ----------
const FILES = {
  "/": ["public/index.html", "text/html; charset=utf-8"],
  "/index.html": ["public/index.html", "text/html; charset=utf-8"],
  "/client.js": ["public/client.js", "text/javascript; charset=utf-8"],
  "/game.js": ["shared/game.js", "text/javascript; charset=utf-8"],
  "/favicon.svg": ["public/favicon.svg", "image/svg+xml"]
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); return; }
  const f = FILES[url.pathname];
  if (!f) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Nicht gefunden"); return; }
  fs.readFile(path.join(__dirname, f[0]), (err, data) => {
    if (err) { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { "content-type": f[1], "cache-control": "no-cache" });
    res.end(data);
  });
});

// ---------- helpers ----------
const clean = s => String(s == null ? "" : s)
  .replace(/[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁯﻿]/g, "")
  .trim().slice(0, 14);
const roomName = s => (String(s || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24)) || "haupt";
const num = v => (typeof v === "number" && Number.isFinite(v)) ? v : null;
const r1 = v => Math.round(v * 10) / 10;

// ---------- rooms ----------
const rooms = new Map();
let nextPlayerId = 1;

class Room {
  constructor(name) {
    this.name = name;
    this.players = new Map();
    this.bullets = [];
    this.pu = [];
    this.dummies = [];
    this.events = [];
    this.nextB = 1;
    this.nextPu = 1;
    this.puTimer = 3;
    this.time = 0;
    this.g = { r: 0, m: Math.floor(Math.random() * MAPS.length), z: 1, t: C.ROUND_T, st: "wait", e: 0, wn: "" };
    this.ws = []; // round wins: [name, count]
    this.geo = KA.geometry(this.g.m, this.g.z);
    this.rosterDirty = true;
  }
  joined() { return [...this.players.values()].filter(p => p.joined); }

  freeSpot(margin, minDist) {
    const { W, H } = this.geo;
    for (let i = 0; i < 200; i++) {
      const x = 60 + Math.random() * (W - 120), y = 60 + Math.random() * (H - 120);
      if (KA.blocked(this.geo, x, y, margin)) continue;
      let close = false;
      for (const p of this.players.values()) if (p.alive && Math.hypot(p.x - x, p.y - y) < minDist) close = true;
      if (close && i < 150) continue;
      return [x, y];
    }
    return [this.geo.W / 2, this.geo.H / 2];
  }
  spawn(p) {
    const [x, y] = this.freeSpot(C.PR + 14, 260 * this.geo.s);
    p.x = x; p.y = y; p.hp = p.mh; p.alive = true; p.prot = C.SPAWN_PROT; p.respawn = 0;
    p.dash = 0; p.dashCd = 0;
  }
  resetForRound(p) {
    p.kills = 0; p.mh = C.BASE_HP; p.w = 0; p.hasSh = false; p.shT = 0; p.shCd = 0; p.turbo = 0; p.phase = 0;
    this.spawn(p);
  }
  setMap(m, z) {
    this.g.m = m; this.g.z = z;
    this.geo = KA.geometry(m, z);
  }
  startRound() {
    let m = this.g.m;
    if (MAPS.length > 1) while (m === this.g.m) m = Math.floor(Math.random() * MAPS.length);
    const n = this.joined().length;
    this.setMap(m, n <= 2 ? 0 : n <= 4 ? 1 : 2);
    this.g.r++; this.g.t = C.ROUND_T; this.g.st = "play"; this.g.e = 0; this.g.wn = "";
    this.bullets = []; this.pu = []; this.puTimer = 4;
    for (const p of this.joined()) this.resetForRound(p);
    this.events.push({ k: "round", r: this.g.r, m });
  }
  standings() { return this.joined().sort((a, b) => b.kills - a.kills); }
  endRound() {
    const s = this.standings();
    const top = s[0], second = s[1];
    this.g.wn = "";
    if (top && top.kills > 0 && (!second || top.kills > second.kills)) {
      this.g.wn = top.name;
      const e = this.ws.find(x => x[0] === top.name);
      if (e) e[1]++; else this.ws.push([top.name, 1]);
      this.ws.sort((a, b) => b[1] - a[1]);
      this.ws = this.ws.slice(0, 16);
      this.rosterDirty = true;
    }
    this.g.st = "end"; this.g.e = C.END_T;
    this.bullets = []; this.pu = [];
  }

  fire(p) {
    const wp = WEAP[p.w];
    p.fireCd = wp.cd;
    const bx = p.x + Math.cos(p.a) * (C.PR + 6), by = p.y + Math.sin(p.a) * (C.PR + 6);
    if (KA.blocked(this.geo, bx, by, wp.rad)) return;
    const own = this.bullets.filter(b => b.owner === p.id).length;
    for (let i = 0; i < wp.n && own + i < C.MAX_B; i++) {
      const a = p.a + (wp.n > 1 ? (i / (wp.n - 1) - 0.5) * 2 * wp.spread : 0) + (Math.random() - 0.5) * 2 * wp.jit;
      this.bullets.push({ id: this.nextB++, owner: p.id, c: p.color, x: bx, y: by, vx: Math.cos(a) * wp.spd, vy: Math.sin(a) * wp.spd, life: wp.life, bn: 0, max: wp.bn, k: p.w });
    }
  }
  stepBullet(b, dt) {
    const r = WEAP[b.k].rad;
    let nx = b.x + b.vx * dt;
    if (KA.blocked(this.geo, nx, b.y, r)) { if (b.bn >= b.max) return false; b.vx = -b.vx; b.bn++; nx = b.x; this.events.push({ k: "bounce", x: Math.round(b.x), y: Math.round(b.y), c: b.c }); }
    b.x = nx;
    let ny = b.y + b.vy * dt;
    if (KA.blocked(this.geo, b.x, ny, r)) { if (b.bn >= b.max) return false; b.vy = -b.vy; b.bn++; ny = b.y; this.events.push({ k: "bounce", x: Math.round(b.x), y: Math.round(b.y), c: b.c }); }
    b.y = ny;
    b.life -= dt;
    return b.life > 0;
  }
  kill(victim, killerId) {
    victim.alive = false; victim.hp = 0; victim.respawn = C.RESPAWN;
    victim.w = 0; victim.turbo = 0;
    const killer = this.players.get(killerId);
    if (killer && killer !== victim && this.g.st === "play") killer.kills++;
    this.events.push({ k: "kill", a: killerId, v: victim.id, x: Math.round(victim.x), y: Math.round(victim.y), c: victim.color });
  }
  applyPu(p, type) {
    switch (type) {
      case 0: p.hp = Math.min(p.mh, p.hp + 2); break;
      case 1: p.mh = Math.min(C.MAX_HP_CAP, p.mh + 1); p.hp = Math.min(p.mh, p.hp + 1); break;
      case 2: p.hasSh = true; p.shCd = 0; break;
      case 3: case 4: case 5: p.w = type - 2; break;
      case 6: p.turbo = C.TURBO_T; break;
      case 7: p.phase = 1; break;
    }
    this.events.push({ k: "pu", p: p.id, u: type, x: Math.round(p.x), y: Math.round(p.y) });
  }
  // one-time ghost sprint: through walls, always landing on free ground
  phaseSprint(p) {
    if (!p.alive || p.phase <= 0 || this.g.st === "end") return;
    let dx = 0, dy = 0;
    if (p.lastK & 1) dy -= 1;
    if (p.lastK & 2) dy += 1;
    if (p.lastK & 4) dx -= 1;
    if (p.lastK & 8) dx += 1;
    if (!dx && !dy) { dx = Math.cos(p.a); dy = Math.sin(p.a); }
    const len = Math.hypot(dx, dy) || 1;
    const t = KA.phaseTarget(this.geo, p.x, p.y, dx / len, dy / len);
    if (!t) return; // nowhere to land: keep the charge
    this.events.push({ k: "phase", p: p.id, x1: Math.round(p.x), y1: Math.round(p.y), x2: Math.round(t[0]), y2: Math.round(t[1]), c: p.color });
    p.x = t[0]; p.y = t[1];
    p.phase = 0; p.dash = 0;
  }
  pickPuType() {
    const total = PU.reduce((s, p) => s + p.w, 0);
    let r = Math.random() * total;
    for (let i = 0; i < PU.length; i++) { r -= PU[i].w; if (r <= 0) return i; }
    return 0;
  }

  tick(dt) {
    this.time += dt;
    const players = this.joined();
    const n = players.length;
    const fighting = this.g.st !== "end";

    // round flow
    if (this.g.st === "wait") { if (n >= 2) this.startRound(); }
    else if (this.g.st === "play") {
      if (n < 2) this.g.st = "wait";
      else {
        this.g.t = Math.max(0, this.g.t - dt);
        const top = this.standings()[0];
        if ((top && top.kills >= C.WIN_KILLS) || this.g.t <= 0) this.endRound();
      }
    } else if (this.g.st === "end") {
      this.g.e -= dt;
      if (this.g.e <= 0) { if (n >= 2) this.startRound(); else { this.g.st = "wait"; this.g.e = 0; } }
    }

    // practice dummies while someone is alone
    if (n === 1 && this.g.st === "wait") {
      if (!this.dummies.length) this.dummies = [0, 1, 2].map(i => ({ i, hp: C.BASE_HP, dead: 0, x: 0, y: 0 }));
      const { W, H } = this.geo;
      for (const d of this.dummies) {
        if (d.dead > 0) { d.dead -= dt; if (d.dead <= 0) d.hp = C.BASE_HP; continue; }
        d.x = [0.22, 0.78, 0.5][d.i] * W + Math.cos(this.time * 0.6 + d.i * 2) * 90;
        d.y = [0.5, 0.5, 0.86][d.i] * H + Math.sin(this.time * 0.9 + d.i) * 50;
      }
    } else this.dummies = [];

    // players: timers, respawn, firing
    for (const p of players) {
      p.budget = Math.min(0.3, p.budget + dt);
      p.fireCd -= dt; p.prot -= dt; p.shT -= dt; p.shCd -= dt; p.turbo -= dt;
      if (!p.alive && fighting) { p.respawn -= dt; if (p.respawn <= 0) this.spawn(p); }
      if (p.alive && p.fireHeld && p.fireCd <= 0 && fighting) this.fire(p);
    }

    // bullets
    const keep = [];
    for (const b of this.bullets) {
      const ox = b.x, oy = b.y;
      if (!fighting || !this.stepBullet(b, dt)) continue;
      const rad = WEAP[b.k].rad;
      let gone = false;
      for (const p of players) {
        if (!p.alive || p.id === b.owner || p.prot > 0) continue;
        if (KA.segDist(p.x, p.y, ox, oy, b.x, b.y) >= C.PR + rad) continue;
        if (p.shT > 0) {
          // shield: the throw flies back and now belongs to the defender
          b.owner = p.id; b.c = p.color; b.vx = -b.vx; b.vy = -b.vy; b.bn = 1; b.max = 1; b.life = 1.1;
          b.x = ox; b.y = oy;
          this.events.push({ k: "refl", x: Math.round(b.x), y: Math.round(b.y) });
          break;
        }
        p.hp -= KA.dmgOf(b.k, b.bn > 0);
        this.events.push({ k: "hit", v: p.id, a: b.owner, x: Math.round(b.x), y: Math.round(b.y), c: b.c });
        if (p.hp <= 0) this.kill(p, b.owner);
        gone = true;
        break;
      }
      if (!gone) for (const d of this.dummies) {
        if (d.dead > 0 || Math.hypot(b.x - d.x, b.y - d.y) >= C.PR + rad) continue;
        d.hp -= KA.dmgOf(b.k, b.bn > 0);
        this.events.push({ k: "hit", v: 0, a: b.owner, x: Math.round(b.x), y: Math.round(b.y), c: b.c });
        if (d.hp <= 0) { d.dead = 1.5; this.events.push({ k: "dummy", a: b.owner, x: Math.round(d.x), y: Math.round(d.y) }); }
        gone = true;
        break;
      }
      if (!gone) keep.push(b);
    }
    this.bullets = keep;

    // power-ups
    if (fighting) {
      for (const p of players) {
        if (!p.alive) continue;
        for (let i = this.pu.length - 1; i >= 0; i--) {
          const u = this.pu[i];
          if (Math.hypot(u.x - p.x, u.y - p.y) < C.PR + 16) { this.pu.splice(i, 1); this.applyPu(p, u.type); }
        }
      }
      this.puTimer -= dt;
      if (this.puTimer <= 0) {
        this.puTimer = 6 + Math.random() * 5;
        if (this.pu.length < 2 + Math.ceil(n / 2)) {
          const [x, y] = this.freeSpot(C.PR + 20, 120);
          this.pu.push({ id: this.nextPu++, type: this.pickPuType(), x: Math.round(x), y: Math.round(y) });
        }
      }
    }

    this.broadcast();
  }

  broadcast() {
    if (this.rosterDirty) {
      this.rosterDirty = false;
      const roster = JSON.stringify({
        t: "roster",
        list: [...this.players.values()].filter(p => p.joined).map(p => [p.id, p.name, p.color]),
        ws: this.ws
      });
      for (const p of this.players.values()) send(p, roster);
    }
    const common = {
      t: "s",
      g: { r: this.g.r, m: this.g.m, z: this.g.z, t: r1(this.g.t), st: this.g.st, e: r1(this.g.e), wn: this.g.wn },
      p: this.joined().map(p => [p.id, Math.round(p.x), Math.round(p.y), Math.round(p.a * 100) / 100, p.hp, p.mh,
        (p.alive ? 1 : 0) | (p.prot > 0 ? 2 : 0) | (p.dash > 0 ? 4 : 0) | (p.shT > 0 ? 8 : 0) | (p.turbo > 0 ? 16 : 0),
        p.w, p.kills]),
      b: this.bullets.map(b => [b.id, Math.round(b.x), Math.round(b.y), Math.round(b.vx), Math.round(b.vy), b.k, b.bn > 0 ? 1 : 0, b.c]),
      u: this.pu.map(u => [u.id, u.type, u.x, u.y]),
      d: this.dummies.filter(d => d.dead <= 0).map(d => [Math.round(d.x), Math.round(d.y), d.hp]),
      ev: this.events
    };
    this.events = [];
    const head = JSON.stringify(common).slice(0, -1);
    for (const p of this.players.values()) {
      const you = p.joined ? {
        id: p.id, ack: p.ack, x: r1(p.x), y: r1(p.y), dash: r1(p.dash * 1000) / 1000, dashCd: r1(p.dashCd * 1000) / 1000,
        al: p.alive, rs: r1(Math.max(0, p.respawn)), sh: p.hasSh, shCd: r1(Math.max(0, p.shCd)), shT: p.shT > 0,
        tb: r1(Math.max(0, p.turbo)), w: p.w, hp: p.hp, mh: p.mh, ph: p.phase
      } : { id: p.id, spectator: true };
      send(p, head + ',"you":' + JSON.stringify(you) + "}");
    }
  }
}

function send(p, msg) {
  if (p.ws.readyState === 1 && p.ws.bufferedAmount < 256 * 1024) p.ws.send(msg);
}

// ---------- websocket ----------
wsLite.attach(server, { path: "/ws", maxPayload: 2048 }, (ws, req) => {
  const url = new URL(req.url, "http://x");
  const rname = roomName(url.searchParams.get("raum"));
  let room = rooms.get(rname);
  if (!room) { room = new Room(rname); rooms.set(rname, room); }

  const p = {
    id: nextPlayerId++, ws, joined: false, name: "", color: 0,
    x: 0, y: 0, a: 0, hp: C.BASE_HP, mh: C.BASE_HP, alive: false, respawn: 0, prot: 0,
    dash: 0, dashCd: 0, fireCd: 0, fireHeld: false, w: 0, hasSh: false, shT: 0, shCd: 0, shCount: 0, turbo: 0,
    phase: 0, phCount: 0, lastK: 0,
    kills: 0, ack: 0, budget: 0, msgs: 0, msgWindow: Date.now(), alivePing: true
  };
  room.players.set(p.id, p);
  ws.on("pong", () => { p.alivePing = true; });

  ws.on("message", raw => {
    const now = Date.now();
    if (now - p.msgWindow > 1000) { p.msgWindow = now; p.msgs = 0; }
    if (++p.msgs > 150) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== "object") return;

    if (m.t === "join") {
      const name = clean(m.n);
      if (!name) return;
      if (!p.joined && room.joined().length >= C.MAX_PLAYERS) { send(p, JSON.stringify({ t: "full" })); return; }
      p.name = name;
      p.color = clamp(Math.round(num(m.c) || 0), 0, KA.COLORS.length - 1);
      if (!p.joined) {
        p.joined = true;
        p.kills = 0; p.mh = C.BASE_HP; p.w = 0; p.hasSh = false; p.turbo = 0; p.phase = 0;
        room.spawn(p);
        room.events.push({ k: "join", p: p.id });
      }
      room.rosterDirty = true;
      return;
    }

    if (m.t === "in" && p.joined) {
      const s = num(m.s), k = num(m.k), a = num(m.a);
      let dt = num(m.dt);
      if (s == null || k == null || a == null || dt == null) return;
      p.ack = Math.max(p.ack, Math.round(s));
      p.a = clamp(a, -4, 4);
      p.fireHeld = !!m.f;
      const sc = num(m.sh);
      if (sc != null && sc > p.shCount) {
        p.shCount = sc;
        if (p.alive && p.hasSh && p.shCd <= 0) { p.shT = C.SHIELD_T; p.shCd = C.SHIELD_CD; }
      }
      if (!p.alive || room.g.st === "end") return;
      dt = clamp(dt, 0, 0.05);
      dt = Math.min(dt, p.budget); // no speed hacks: movement time can't outrun real time
      p.budget -= dt;
      p.lastK = Math.round(k) & 31;
      KA.stepMove(room.geo, p, p.lastK, dt, p.turbo > 0);
      const pc = num(m.ph);
      if (pc != null && pc > p.phCount) { p.phCount = pc; room.phaseSprint(p); }
    }
  });

  ws.on("close", () => {
    room.players.delete(p.id);
    if (p.joined) { room.events.push({ k: "leave", p: p.id, n: p.name }); room.rosterDirty = true; }
    room.bullets = room.bullets.filter(b => b.owner !== p.id);
    if (!room.players.size) rooms.delete(room.name);
  });

  send(p, JSON.stringify({ t: "hello", id: p.id, raum: room.name }));
});

function startLoops() {
// game loop
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const room of rooms.values()) room.tick(dt);
}, 1000 / C.TICK);

// drop dead connections
setInterval(() => {
  for (const room of rooms.values()) for (const p of room.players.values()) {
    if (!p.alivePing) { p.ws.terminate(); continue; }
    p.alivePing = false;
    try { p.ws.ping(); } catch (e) {}
  }
}, 20000);

}

if (require.main === module) {
  startLoops();
  server.listen(PORT, () => console.log("Kreide-Arena läuft auf Port " + PORT));
}
module.exports = { Room };
