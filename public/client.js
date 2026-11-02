// Kreide-Arena browser client: sends input, predicts your own movement, draws what the server says.
(() => {
  "use strict";
  const { C, COLORS, WEAP, PU, MAPS, clamp } = KA;
  const INTERP_MS = 100;
  const reduceMotion = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const cv = $("cv"), ctx = cv.getContext("2d"), stage = $("stage");
  const joinOv = $("joinOv"), nameIn = $("nameIn"), swatchBox = $("swatches"), joinHint = $("joinHint");
  const endOv = $("endOv"), toast = $("toast"), boardEl = $("board"), feedEl = $("feed");

  const clean = s => String(s == null ? "" : s)
    .replace(/[\u0000-\u001f\u007f­​-‏‪-‮⁠-⁯﻿]/g, "")
    .trim().slice(0, 14);

  // room from the link: ?raum=name
  const params = new URLSearchParams(location.search);
  const raum = (String(params.get("raum") || "").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24)) || "haupt";
  $("roomName").textContent = raum;
  $("copyBtn").addEventListener("click", () => {
    const link = location.origin + location.pathname + (raum === "haupt" ? "" : "?raum=" + raum);
    const done = () => { $("copyBtn").textContent = "Kopiert!"; setTimeout(() => { $("copyBtn").textContent = "Link kopieren"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, () => window.prompt("Link kopieren:", link));
    else window.prompt("Link kopieren:", link);
  });

  $("legend").replaceChildren(...PU.map(p => {
    const li = document.createElement("li");
    const b = document.createElement("b"); b.textContent = p.glyph; b.style.color = p.color;
    li.append(b, document.createTextNode(" " + p.name + ": " + p.info));
    return li;
  }), (() => {
    const li = document.createElement("li");
    const b = document.createElement("b"); b.textContent = "◎"; b.style.color = "#ff7a7a";
    li.append(b, document.createTextNode(" Abpraller (roter Rand): mindestens 2 Schaden"));
    return li;
  })());

  // ---------- local state ----------
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("kreide-arena") || "{}") || {}; } catch (e) { saved = {}; }
  let myName = clean(saved.name) || "";
  let myColor = Number.isInteger(saved.color) ? saved.color % COLORS.length : Math.floor(Math.random() * COLORS.length);
  let wantJoin = false, joined = false;
  let myId = 0;
  const roster = new Map(); // id -> {name, color}
  let wins = [];
  let snaps = [];           // [{time, msg, players: Map}]
  let latest = null;
  let you = null;
  let geo = null, mapKey = "";
  const pred = { x: 0, y: 0, dash: 0, dashCd: 0, alive: false };
  let pending = [], seq = 0, shCount = 0, phCount = 0;
  const trails = []; // ghost sprint streaks
  const visOff = { x: 0, y: 0 };
  const feed = [], fx = [];
  let shake = 0, flash = 0, lastSt = "", lastBoard = 0;

  nameIn.value = myName;
  COLORS.forEach((c, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.style.background = c;
    b.setAttribute("aria-label", "Farbe " + (i + 1));
    b.setAttribute("aria-pressed", String(i === myColor));
    b.addEventListener("click", () => {
      myColor = i;
      [...swatchBox.children].forEach((x, j) => x.setAttribute("aria-pressed", String(j === i)));
    });
    swatchBox.appendChild(b);
  });
  $("joinForm").addEventListener("submit", e => {
    e.preventDefault();
    const n = clean(nameIn.value);
    if (!n) { nameIn.focus(); return; }
    myName = n;
    try { localStorage.setItem("kreide-arena", JSON.stringify({ name: myName, color: myColor })); } catch (err) {}
    wantJoin = true;
    sendJoin();
    joinOv.hidden = true;
    cv.focus();
  });

  // ---------- connection ----------
  let ws = null, retry = 0;
  function setStatus(s, t) { $("status").dataset.s = s; $("statusText").textContent = t; }
  function connect() {
    setStatus("wait", retry ? "Verbinde neu…" : "Verbinde… (der Server wacht evtl. erst auf)");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(proto + "://" + location.host + "/ws?raum=" + encodeURIComponent(raum));
    ws.onopen = () => { retry = 0; if (wantJoin) sendJoin(); };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMessage(m); };
    ws.onclose = () => {
      joined = false; pending = [];
      setStatus("off", "Verbindung weg, versuche es gleich wieder…");
      retry++;
      setTimeout(connect, Math.min(5000, 800 * retry));
    };
  }
  function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  function sendJoin() { send({ t: "join", n: myName, c: myColor }); }
  connect();

  function onMessage(m) {
    if (m.t === "hello") { myId = m.id; return; }
    if (m.t === "full") {
      wantJoin = false; joinOv.hidden = false;
      joinHint.hidden = false; joinHint.textContent = "Die Arena ist voll (12 Leute). Versuch es gleich nochmal oder nimm einen anderen Raum.";
      return;
    }
    if (m.t === "roster") {
      roster.clear();
      if (Array.isArray(m.list)) for (const r of m.list) roster.set(r[0], { name: clean(r[1]) || "Jemand", color: COLORS[r[2]] || COLORS[0] });
      wins = Array.isArray(m.ws) ? m.ws : [];
      return;
    }
    if (m.t === "s") onSnapshot(m);
  }

  function nameOf(id) { if (id === myId) return "Du"; const r = roster.get(id); return r ? r.name : "Jemand"; }

  function onSnapshot(m) {
    const now = performance.now();
    const players = new Map();
    for (const p of m.p) players.set(p[0], p);
    snaps.push({ time: now, msg: m, players });
    if (snaps.length > 30) snaps.shift();
    latest = { time: now, msg: m, players };

    const key = m.g.m + "-" + m.g.z;
    if (key !== mapKey) { mapKey = key; geo = KA.geometry(m.g.m, m.g.z); buildBg(m.g.m); resize(); }

    for (const ev of m.ev) handleEvent(ev);

    // your own state: take the server's word, then replay the inputs it has not seen yet
    you = m.you;
    if (!you || you.spectator) { joined = false; pred.alive = false; return; }
    joined = true;
    const oldX = pred.x, oldY = pred.y, wasAlive = pred.alive;
    pred.x = you.x; pred.y = you.y; pred.dash = you.dash; pred.dashCd = you.dashCd; pred.alive = you.al;
    pending = pending.filter(i => i.s > you.ack);
    if (you.al && m.g.st !== "end") for (const i of pending) KA.stepMove(geo, pred, i.k, i.dt, you.tb > 0);
    if (wasAlive && you.al) {
      visOff.x += oldX - pred.x; visOff.y += oldY - pred.y;
      if (Math.hypot(visOff.x, visOff.y) > 80) { visOff.x = 0; visOff.y = 0; }
    } else { visOff.x = 0; visOff.y = 0; }

    if (m.g.st !== lastSt) { lastSt = m.g.st; if (m.g.st === "end") showEnd(); else endOv.hidden = true; }
  }

  function handleEvent(ev) {
    switch (ev.k) {
      case "kill":
        puff(ev.x, ev.y, (roster.get(ev.v) || {}).color || "#ece8dc", 22);
        if (ev.v === myId) {
          addFeed(nameOf(ev.a) + " hat dich erwischt");
          showToast("Erwischt von " + nameOf(ev.a), "Waffe weg, gleich geht's weiter", C.RESPAWN * 1000, "var(--danger)");
        } else if (ev.a === myId) {
          addFeed("Du hast " + nameOf(ev.v) + " erwischt");
          showToast("Erwischt!", nameOf(ev.v), 1100, "var(--ok)");
        } else addFeed(nameOf(ev.a) + " hat " + nameOf(ev.v) + " erwischt");
        break;
      case "hit":
        puff(ev.x, ev.y, "#ece8dc", 8);
        if (ev.v === myId) { flash = 1; if (!reduceMotion) shake = 8; }
        break;
      case "dummy": puff(ev.x, ev.y, "#ece8dc", 18); break;
      case "refl": puff(ev.x, ev.y, "#7cc4ff", 10); break;
      case "overheat":
        puff(ev.x, ev.y, "#ff7a7a", 12);
        if (ev.p === myId) showToast("Überhitzt!", "Kurz abkühlen lassen", 1400, "var(--danger)");
        break;
      case "phase": {
        const col = COLORS[ev.c] || "#9ef0ff";
        trails.push({ x1: ev.x1, y1: ev.y1, x2: ev.x2, y2: ev.y2, c: col, life: 0.5 });
        puff(ev.x1, ev.y1, "#9ef0ff", 10); puff(ev.x2, ev.y2, "#9ef0ff", 14);
        break;
      }
      case "bounce": puff(ev.x, ev.y, ev.c || "#ece8dc", 3); break;
      case "pu": {
        const p = PU[ev.u];
        if (!p) break;
        puff(ev.x, ev.y, p.color, 14);
        if (ev.p === myId) showToast(p.name + "!", p.info, 1400, p.color);
        break;
      }
      case "round": addFeed("Runde " + ev.r + ": " + (MAPS[ev.m] ? MAPS[ev.m].name : "")); break;
      case "join": if (ev.p !== myId) addFeed(nameOf(ev.p) + " ist da"); break;
      case "leave": addFeed(clean(ev.n) + " ist gegangen"); break;
    }
  }

  // ---------- feed / toast ----------
  function addFeed(t) { feed.unshift(t); if (feed.length > 7) feed.length = 7; renderFeed(); }
  function renderFeed() {
    const items = feed.length ? feed : ["Noch ruhig auf dem Hof."];
    feedEl.replaceChildren(...items.map(t => { const li = document.createElement("li"); li.textContent = t; return li; }));
  }
  renderFeed();
  let toastTimer = 0;
  function showToast(big, small, ms, color) {
    toast.replaceChildren(document.createTextNode(big));
    if (small) { const s = document.createElement("small"); s.textContent = small; toast.append(s); }
    toast.style.color = color || "var(--danger)";
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, ms);
  }
  function puff(x, y, color, n) {
    if (reduceMotion) n = Math.min(n, 3);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 40 + Math.random() * 120;
      fx.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0.4 + Math.random() * 0.3, c: color });
    }
    if (fx.length > 300) fx.splice(0, fx.length - 300);
  }

  // ---------- scoreboard & round end ----------
  function standings() {
    if (!latest) return [];
    const list = latest.msg.p.map(p => {
      const r = roster.get(p[0]) || { name: "Jemand", color: COLORS[0] };
      return { id: p[0], name: r.name, color: r.color, score: p[8], isMe: p[0] === myId };
    });
    return list.sort((a, b) => b.score - a.score);
  }
  function winsOf(name) { const e = wins.find(x => x[0] === name); return e ? e[1] : 0; }
  function renderBoard() {
    const rows = standings().map(e => {
      const li = document.createElement("li");
      if (e.isMe) li.className = "me";
      const sw = document.createElement("span"); sw.className = "sw"; sw.style.background = e.color;
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = e.name + (e.isMe ? " (du)" : "");
      const w = document.createElement("span"); w.className = "wins"; const wc = winsOf(e.name); w.textContent = wc ? "★" + wc : "";
      const pts = document.createElement("span"); pts.className = "pts"; pts.textContent = String(e.score);
      li.append(sw, nm, w, pts);
      return li;
    });
    if (!rows.length) { const li = document.createElement("li"); li.textContent = "Noch niemand im Spiel"; rows.push(li); }
    boardEl.replaceChildren(...rows);
    const n = latest ? latest.msg.p.length : 0;
    $("goal").textContent = n <= 1
      ? "Übungsmodus. Die Runde startet, sobald jemand dazukommt. Schick den Link rum!"
      : "Erster mit " + C.WIN_KILLS + " Kills oder die meisten nach 3 Minuten. ★ = gewonnene Runden.";
    if (ws && ws.readyState === 1) setStatus("online", "Online · " + n + (n === 1 ? " Person" : " Leute") + " in der Arena");
  }
  function showEnd() {
    const g = latest.msg.g;
    const s = standings();
    $("endTitle").textContent = g.wn ? (g.wn === myName ? "Du gewinnst die Runde!" : clean(g.wn) + " gewinnt die Runde") : "Unentschieden";
    $("endList").replaceChildren(...s.slice(0, 5).map((e, i) => {
      const li = document.createElement("li");
      const a = document.createElement("span"); a.textContent = (i + 1) + ". " + e.name;
      const b = document.createElement("span"); b.textContent = e.score + " Kills";
      li.append(a, b); return li;
    }));
    $("endWins").textContent = wins.length ? "Rundensiege: " + wins.slice(0, 5).map(x => clean(x[0]) + " " + x[1]).join(" · ") : "";
    endOv.hidden = false;
  }

  // ---------- input ----------
  const keys = new Set();
  const mouse = { x: 800, y: 450, down: false };
  const typing = () => document.activeElement && document.activeElement.tagName === "INPUT";
  window.addEventListener("keydown", e => {
    if (typing()) return;
    keys.add(e.code);
    if (e.code === "KeyE" || e.code === "KeyF") shCount++;
    if (e.code === "KeyQ" && !e.repeat) phCount++;
    if (joined && ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) e.preventDefault();
  });
  window.addEventListener("keyup", e => keys.delete(e.code));
  window.addEventListener("blur", () => { keys.clear(); mouse.down = false; });
  const view = { s: 1, ox: 0, oy: 0, dpr: 1 };
  function toWorld(e) {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) - view.ox) / view.s, y: ((e.clientY - r.top) - view.oy) / view.s };
  }
  cv.addEventListener("pointermove", e => { const p = toWorld(e); mouse.x = p.x; mouse.y = p.y; });
  cv.addEventListener("pointerdown", e => {
    const p = toWorld(e); mouse.x = p.x; mouse.y = p.y; cv.focus();
    if (e.button === 0) mouse.down = true;
    if (e.button === 2) shCount++;
  });
  window.addEventListener("pointerup", e => { if (e.button === 0) mouse.down = false; });
  cv.addEventListener("contextmenu", e => e.preventDefault());

  function inputBits() {
    let k = 0;
    if (keys.has("KeyW") || keys.has("ArrowUp")) k |= 1;
    if (keys.has("KeyS") || keys.has("ArrowDown")) k |= 2;
    if (keys.has("KeyA") || keys.has("ArrowLeft")) k |= 4;
    if (keys.has("KeyD") || keys.has("ArrowRight")) k |= 8;
    if (keys.has("Space") || keys.has("ShiftLeft")) k |= 16;
    return k;
  }

  // ---------- canvas sizing & background ----------
  function resize() {
    if (!geo) return;
    const r = stage.getBoundingClientRect();
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.max(1, Math.round(r.width * view.dpr));
    cv.height = Math.max(1, Math.round(r.height * view.dpr));
    view.s = Math.min(r.width / geo.W, r.height / geo.H);
    view.ox = (r.width - geo.W * view.s) / 2;
    view.oy = (r.height - geo.H * view.s) / 2;
  }
  new ResizeObserver(resize).observe(stage);

  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const bg = document.createElement("canvas");
  function buildBg(m) {
    const map = MAPS[m], W = geo.W, H = geo.H, s = geo.s;
    bg.width = W; bg.height = H;
    seed = 7 + m * 101;
    const g = bg.getContext("2d");
    g.fillStyle = map.floor; g.fillRect(0, 0, W, H);
    for (let i = 0; i < W * H / 160; i++) {
      g.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.18)" : "rgba(255,255,255,0.05)";
      g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2);
    }
    const line = (draw, color, w, alpha) => {
      for (let pass = 0; pass < 3; pass++) {
        g.save();
        g.translate((rnd() - 0.5) * 2, (rnd() - 0.5) * 2);
        g.strokeStyle = color; g.globalAlpha = alpha * (0.5 + rnd() * 0.4); g.lineWidth = w;
        g.lineCap = "round"; g.lineJoin = "round";
        g.beginPath(); draw(g); g.stroke();
        g.restore();
      }
    };
    const CH = "#ece8dc";
    if (map.deco === "court") {
      line(c => { c.moveTo(W / 2, 30); c.lineTo(W / 2, H * 0.36); c.moveTo(W / 2, H * 0.64); c.lineTo(W / 2, H - 30); }, CH, 4, 0.25);
      line(c => c.arc(W / 2, H / 2, 230 * s, 0, Math.PI * 2), CH, 4, 0.2);
      g.font = 26 * s + "px 'Permanent Marker', cursive"; g.textAlign = "center"; g.textBaseline = "middle";
      [[0, 0, 1], [0, 60, 2], [-30, 120, 3], [30, 120, 4], [0, 180, 5]].forEach(([dx, dy, n]) => {
        const x = (90 + dx) * s, y = (360 + dy) * s;
        line(c => c.rect(x, y, 60 * s, 60 * s), "#ffd95e", 3, 0.22);
        g.globalAlpha = 0.18; g.fillStyle = "#ffd95e"; g.fillText(String(n), x + 30 * s, y + 31 * s); g.globalAlpha = 1;
      });
    } else if (map.deco === "gym") {
      g.globalAlpha = 0.08; g.strokeStyle = "#000"; g.lineWidth = 2;
      for (let y = 0; y < H; y += 46 * s) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.globalAlpha = 1;
      line(c => { c.moveTo(W / 2, 30); c.lineTo(W / 2, H - 30); }, "#ffad66", 4, 0.3);
      line(c => c.arc(W / 2, H / 2, 150 * s, 0, Math.PI * 2), "#ffad66", 4, 0.3);
      line(c => c.arc(30, H / 2, 300 * s, -Math.PI / 2, Math.PI / 2), "#7cc4ff", 4, 0.25);
      line(c => c.arc(W - 30, H / 2, 300 * s, Math.PI / 2, Math.PI * 1.5), "#7cc4ff", 4, 0.25);
    } else if (map.deco === "grid") {
      g.globalAlpha = 0.07; g.strokeStyle = CH; g.lineWidth = 1;
      for (let x = 0; x < W; x += 40 * s) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = 0; y < H; y += 40 * s) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.globalAlpha = 1;
    } else if (map.deco === "cross") {
      g.setLineDash([18 * s, 22 * s]);
      line(c => { c.moveTo(40, 40); c.lineTo(W - 40, H - 40); c.moveTo(W - 40, 40); c.lineTo(40, H - 40); }, "#c3a6ff", 3, 0.22);
      g.setLineDash([]);
      line(c => c.arc(W / 2, H / 2, 290 * s, 0, Math.PI * 2), "#c3a6ff", 4, 0.25);
    } else if (map.deco === "tiles") {
      g.globalAlpha = 0.09; g.strokeStyle = CH; g.lineWidth = 2;
      for (let x = 0; x < W; x += 130 * s) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
      for (let y = 0; y < H; y += 120 * s) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
      g.globalAlpha = 1;
    }
    line(c => c.rect(24, 24, W - 48, H - 48), CH, 5, 0.3);
    for (const o of geo.OBS) {
      g.fillStyle = "rgba(0,0,0,0.35)"; g.fillRect(o[0], o[1], o[2], o[3]);
      g.save(); g.beginPath(); g.rect(o[0], o[1], o[2], o[3]); g.clip();
      line(c => { for (let k = -o[3]; k < o[2]; k += 14) { c.moveTo(o[0] + k, o[1] + o[3]); c.lineTo(o[0] + k + o[3], o[1]); } }, CH, 1.5, 0.18);
      g.restore();
      line(c => c.rect(o[0], o[1], o[2], o[3]), CH, 3.5, 0.75);
    }
  }

  // ---------- drawing ----------
  const PR = C.PR;
  function drawPlayer(x, y, a, color, name, hp, mh, o) {
    const t = performance.now() / 1000;
    const alpha = o.prot ? 0.45 + 0.35 * Math.sin(t * 18) : 1;
    if (o.dash) { ctx.globalAlpha = 0.25; ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x - Math.cos(a) * 14, y - Math.sin(a) * 14, PR, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1; }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(x, y, PR, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = alpha * 0.9; ctx.strokeStyle = "#ece8dc"; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(x + 0.8, y - 0.6, PR + 1, 0, Math.PI * 2); ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.lineWidth = o.w === 3 ? 9 : 5; ctx.lineCap = "round";
    ctx.strokeStyle = WEAP[o.w || 0].color;
    ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * (PR - 4), y + Math.sin(a) * (PR - 4)); ctx.lineTo(x + Math.cos(a) * (PR + 10), y + Math.sin(a) * (PR + 10)); ctx.stroke();
    ctx.fillStyle = "#1d2026";
    const ex = Math.cos(a) * 6, ey = Math.sin(a) * 6, px = -Math.sin(a) * 6, py = Math.cos(a) * 6;
    ctx.beginPath(); ctx.arc(x + ex + px, y + ey + py, 3, 0, Math.PI * 2); ctx.arc(x + ex - px, y + ey - py, 3, 0, Math.PI * 2); ctx.fill();
    if (o.sh) {
      ctx.strokeStyle = "#7cc4ff"; ctx.lineWidth = 4; ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.arc(x, y, PR + 9, 0, Math.PI * 2); ctx.stroke();
    }
    if (o.turbo) {
      ctx.strokeStyle = "#b8f075"; ctx.lineWidth = 2; ctx.globalAlpha = 0.6;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(a) * (PR + 6) + i * 5 * Math.sin(a), y - Math.sin(a) * (PR + 6) - i * 5 * Math.cos(a));
        ctx.lineTo(x - Math.cos(a) * (PR + 18) + i * 5 * Math.sin(a), y - Math.sin(a) * (PR + 18) - i * 5 * Math.cos(a));
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.font = "700 15px 'Atkinson Hyperlegible', system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.fillStyle = o.me ? "#ffd95e" : "#ece8dc";
    ctx.fillText(name, x, y - PR - 12);
    const pw = 8, gap = 3, total = mh * pw + (mh - 1) * gap;
    for (let i = 0; i < mh; i++) {
      ctx.fillStyle = i < hp ? color : "rgba(236,232,220,0.2)";
      ctx.fillRect(x - total / 2 + i * (pw + gap), y - PR - 9, pw, 4);
    }
  }
  function drawBullet(x, y, vx, vy, color, kind, bounced) {
    const r = WEAP[kind].rad + 1, l = Math.hypot(vx, vy) || 1;
    if (bounced) {
      ctx.strokeStyle = "#ff7a7a"; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.arc(x, y, r + 4, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.strokeStyle = color; ctx.globalAlpha = 0.35; ctx.lineWidth = r * 1.2; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x - vx / l * 22, y - vy / l * 22); ctx.lineTo(x, y); ctx.stroke();
    ctx.globalAlpha = 1; ctx.fillStyle = "#ece8dc";
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, Math.max(2, r - 2), 0, Math.PI * 2); ctx.fill();
  }
  function drawPowerup(u) {
    const p = PU[u[1]], t = performance.now() / 1000;
    if (!p) return;
    const bob = reduceMotion ? 0 : Math.sin(t * 3 + u[0]) * 3;
    const x = u[2], y = u[3] + bob;
    ctx.save();
    ctx.globalAlpha = 0.18; ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(x, y, 22, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.strokeStyle = p.color; ctx.lineWidth = 3;
    ctx.setLineDash([6, 5]); ctx.lineDashOffset = reduceMotion ? 0 : -t * 12;
    ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = p.color;
    ctx.font = "22px 'Permanent Marker', 'Segoe UI Symbol', system-ui, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(p.glyph, x, y + 1);
    ctx.font = "12px 'Atkinson Hyperlegible', system-ui, sans-serif";
    ctx.fillStyle = "#ece8dc"; ctx.globalAlpha = 0.75;
    ctx.fillText(p.name, x, y + 32);
    ctx.restore();
  }
  function bar(x, y, label, frac, colorReady) {
    ctx.font = "15px 'Atkinson Hyperlegible', system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(236,232,220,0.65)"; ctx.fillText(label, x, y);
    ctx.fillStyle = "rgba(236,232,220,0.15)"; ctx.fillRect(x + 62, y - 5, 110, 10);
    ctx.fillStyle = frac >= 1 ? colorReady : "#ffd95e"; ctx.fillRect(x + 62, y - 5, 110 * clamp(frac, 0, 1), 10);
  }

  // others are drawn ~100 ms in the past, between two server snapshots, so they move smoothly
  function interpolatedPlayers(now) {
    const out = [];
    if (!snaps.length) return out;
    const rt = now - INTERP_MS;
    let a = snaps[0], b = snaps[snaps.length - 1];
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].time <= rt && snaps[i + 1].time >= rt) { a = snaps[i]; b = snaps[i + 1]; break; }
    }
    if (rt >= snaps[snaps.length - 1].time) a = b;
    const span = b.time - a.time;
    const f = span > 0 ? clamp((rt - a.time) / span, 0, 1) : 1;
    for (const [id, pb] of b.players) {
      const pa = a.players.get(id);
      const jump = pa && Math.hypot(pb[1] - pa[1], pb[2] - pa[2]) > 120;
      const x = pa && !jump ? pa[1] + (pb[1] - pa[1]) * f : pb[1];
      const y = pa && !jump ? pa[2] + (pb[2] - pa[2]) * f : pb[2];
      out.push({ id, x, y, p: pb });
    }
    return out;
  }

  // ---------- loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;

    if (joined && geo && latest && ws && ws.readyState === 1) {
      const st = latest.msg.g.st;
      const k = inputBits();
      seq++;
      if (pred.alive && st !== "end") {
        KA.stepMove(geo, pred, k, dt, you && you.tb > 0);
        pending.push({ s: seq, k, dt });
        if (pending.length > 180) pending.shift();
      }
      const a = Math.atan2(mouse.y - pred.y, mouse.x - pred.x);
      send({ t: "in", s: seq, k, a: Math.round(a * 1000) / 1000, dt: Math.round(dt * 10000) / 10000, f: mouse.down, sh: shCount, ph: phCount });
    }
    visOff.x *= 0.85; visOff.y *= 0.85;

    for (const f of fx) { f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.9; f.vy *= 0.9; f.life -= dt; }
    for (let i = fx.length - 1; i >= 0; i--) if (fx[i].life <= 0) fx.splice(i, 1);
    for (const t of trails) t.life -= dt;
    for (let i = trails.length - 1; i >= 0; i--) if (trails[i].life <= 0) trails.splice(i, 1);
    shake = Math.max(0, shake - dt * 30); flash = Math.max(0, flash - dt * 3);

    draw(now);
    if (now - lastBoard > 250) {
      lastBoard = now;
      renderBoard();
      if (latest && latest.msg.g.st === "end") $("endNext").textContent = "Nächste Runde in " + Math.max(1, Math.ceil(latest.msg.g.e)) + " s";
    }
    requestAnimationFrame(frame);
  }

  function draw(now) {
    const d = view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1d2026"; ctx.fillRect(0, 0, cv.width, cv.height);
    if (!geo || !latest) {
      ctx.fillStyle = "#a9a79e"; ctx.font = 16 * d + "px 'Atkinson Hyperlegible', sans-serif"; ctx.textAlign = "center";
      ctx.fillText("Verbinde mit dem Server…", cv.width / 2, cv.height / 2);
      return;
    }
    const W = geo.W, H = geo.H;
    const sx = shake ? (Math.random() - 0.5) * shake : 0, sy = shake ? (Math.random() - 0.5) * shake : 0;
    ctx.setTransform(view.s * d, 0, 0, view.s * d, (view.ox + sx) * d, (view.oy + sy) * d);
    ctx.drawImage(bg, 0, 0);
    const m = latest.msg;

    for (const u of m.u) drawPowerup(u);
    for (const dm of m.d) drawPlayer(dm[0], dm[1], Math.PI / 2, "#6b7280", "Übungsziel", dm[2], C.BASE_HP, {});

    const age = clamp((now - latest.time) / 1000, 0, 0.1);
    for (const b of m.b) drawBullet(b[1] + b[3] * age, b[2] + b[4] * age, b[3], b[4], COLORS[b[7]] || "#ece8dc", b[5], b[6] === 1);

    for (const o of interpolatedPlayers(now)) {
      if (o.id === myId) continue;
      const p = o.p, fl = p[6];
      if (!(fl & 1)) continue;
      const r = roster.get(o.id) || { name: "Jemand", color: COLORS[0] };
      drawPlayer(o.x, o.y, p[3], r.color, r.name, p[4], p[5], { prot: fl & 2, dash: fl & 4, sh: fl & 8, turbo: fl & 16, w: p[7] });
    }
    if (joined && you && pred.alive) {
      const mine = latest.players.get(myId);
      const fl = mine ? mine[6] : 0;
      const a = Math.atan2(mouse.y - pred.y, mouse.x - pred.x);
      drawPlayer(pred.x + visOff.x, pred.y + visOff.y, a, COLORS[myColor], myName, you.hp, you.mh,
        { me: true, prot: fl & 2, dash: pred.dash > 0, sh: you.shT, turbo: you.tb > 0, w: you.w });
    }

    for (const f of fx) { ctx.globalAlpha = clamp(f.life * 2, 0, 1) * 0.8; ctx.fillStyle = f.c; ctx.fillRect(f.x - 2, f.y - 2, 4, 4); }
    for (const t of trails) {
      ctx.globalAlpha = clamp(t.life * 2, 0, 1) * 0.7;
      ctx.strokeStyle = "#9ef0ff"; ctx.lineWidth = PR * 1.6; ctx.lineCap = "round";
      ctx.setLineDash([2, 14]);
      ctx.beginPath(); ctx.moveTo(t.x1, t.y1); ctx.lineTo(t.x2, t.y2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = t.c; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(t.x1, t.y1); ctx.lineTo(t.x2, t.y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // timer & round info
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    if (m.g.st === "play") {
      const t = Math.ceil(m.g.t), mm = Math.floor(t / 60), ss = String(t % 60).padStart(2, "0");
      ctx.font = "34px 'Permanent Marker', cursive";
      ctx.fillStyle = m.g.t <= 30 ? "#ff7a7a" : "#ece8dc";
      ctx.fillText(mm + ":" + ss, W / 2, 30);
      ctx.font = "14px 'Atkinson Hyperlegible', system-ui, sans-serif"; ctx.fillStyle = "rgba(236,232,220,0.7)";
      ctx.fillText("Runde " + m.g.r + " · " + MAPS[m.g.m].name, W / 2, 70);
    } else if (m.g.st === "wait") {
      ctx.font = "24px 'Permanent Marker', cursive"; ctx.fillStyle = "#ffd95e";
      ctx.fillText("Warte auf Mitspieler", W / 2, 32);
      ctx.font = "14px 'Atkinson Hyperlegible', system-ui, sans-serif"; ctx.fillStyle = "rgba(236,232,220,0.7)";
      ctx.fillText(MAPS[m.g.m].name + " · Übungsmodus", W / 2, 64);
    }

    // abilities
    if (joined && you && pred.alive) {
      let y = H - 46;
      bar(40, y, "Sprint", 1 - pred.dashCd / C.DASH_CD, "#7ee8c4");
      if (you.sh) { y -= 22; bar(40, y, "Schild", 1 - you.shCd / C.SHIELD_CD, "#7cc4ff"); }
      if (you.tb > 0) { y -= 22; bar(40, y, "Turbo", you.tb / C.TURBO_T, "#b8f075"); }
      if (you.w === 2) {
        y -= 22;
        const over = you.oh > 0;
        ctx.font = "15px 'Atkinson Hyperlegible', system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillStyle = over ? "#ff7a7a" : "rgba(236,232,220,0.65)"; ctx.fillText(over ? "Heiß!" : "Hitze", 40, y);
        ctx.fillStyle = "rgba(236,232,220,0.15)"; ctx.fillRect(102, y - 5, 110, 10);
        ctx.fillStyle = over ? "#ff7a7a" : you.ht > 0.66 ? "#ffad66" : "#ffd95e";
        ctx.fillRect(102, y - 5, 110 * (over ? you.oh / C.OVERHEAT_T : clamp(you.ht, 0, 1)), 10);
      }
      if (you.ph > 0) {
        y -= 22;
        ctx.font = "15px 'Atkinson Hyperlegible', system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#9ef0ff"; ctx.fillText("Geistersprint bereit · Q", 40, y);
      }
      y -= 26;
      ctx.font = "16px 'Permanent Marker', cursive"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
      ctx.fillStyle = WEAP[you.w].color;
      ctx.fillText(WEAP[you.w].name, 40, y);
    }

    if (flash > 0) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = "rgba(255,122,122," + (flash * 0.18) + ")";
      ctx.fillRect(0, 0, cv.width, cv.height);
    }
  }

  requestAnimationFrame(frame);
})();
