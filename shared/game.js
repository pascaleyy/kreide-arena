// Kreide-Arena: rules and map data shared by the server (Node) and the browser.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KA = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const C = {
    PR: 18, SPEED: 270, DASH_MULT: 3.1, DASH_T: 0.16, DASH_CD: 1.4,
    BASE_HP: 3, MAX_HP_CAP: 5, WIN_KILLS: 10, ROUND_T: 180, END_T: 7,
    RESPAWN: 2, SPAWN_PROT: 1.5, MAX_B: 14,
    SHIELD_T: 0.9, SHIELD_CD: 4, TURBO_T: 8, TURBO_MULT: 1.35,
    MAX_PLAYERS: 12, TICK: 30
  };

  const COLORS = ["#ff8fb1", "#ffd95e", "#7ee8c4", "#7cc4ff", "#c3a6ff", "#ffad66", "#b8f075", "#ff7a7a"];
  const SIZES = [[1280, 720], [1600, 900], [1920, 1080]];

  const WEAP = [
    { name: "Kreide",       cd: 0.24, n: 1, spread: 0,    jit: 0,    spd: 720, life: 1.4,  bn: 1, dmg: 1, rad: 4,  color: "#ece8dc" },
    { name: "Schrotkreide", cd: 0.62, n: 5, spread: 0.28, jit: 0.03, spd: 650, life: 0.55, bn: 0, dmg: 1, rad: 4,  color: "#ffad66" },
    { name: "Schnellfeuer", cd: 0.1,  n: 1, spread: 0,    jit: 0.07, spd: 780, life: 1.0,  bn: 0, dmg: 1, rad: 3,  color: "#ffd95e" },
    { name: "Riesenkreide", cd: 0.72, n: 1, spread: 0,    jit: 0,    spd: 520, life: 2.0,  bn: 2, dmg: 2, rad: 10, color: "#c3a6ff" }
  ];

  const PU = [
    { name: "Heilung",      glyph: "+", color: "#7ee8c4", w: 3, info: "2 Leben zurück" },
    { name: "Extraleben",   glyph: "♥", color: "#ff8fb1", w: 2, info: "+1 maximales Leben (bis 5)" },
    { name: "Schild",       glyph: "◐", color: "#7cc4ff", w: 2, info: "Mit E wirfst du Würfe zurück" },
    { name: "Schrotkreide", glyph: "S", color: "#ffad66", w: 2, info: "5 Würfe im Fächer, kurze Reichweite" },
    { name: "Schnellfeuer", glyph: "R", color: "#ffd95e", w: 2, info: "Wirft sehr schnell" },
    { name: "Riesenkreide", glyph: "K", color: "#c3a6ff", w: 2, info: "2 Schaden, prallt zweimal ab" },
    { name: "Turbo",        glyph: "»", color: "#b8f075", w: 2, info: "8 Sekunden schneller laufen" },
    { name: "Geistersprint", glyph: "G", color: "#9ef0ff", w: 2, info: "Einmal mit Q durch Wände sprinten" }
  ];

  // Ghost sprint: where do you land? Never inside a wall or outside the arena.
  // Aim for PHASE_DIST; if that spot is blocked, keep going until the far side of the wall,
  // otherwise fall back to the last free spot before it. Returns null if there is no free spot.
  const PHASE_DIST = 230, PHASE_OVERSHOOT = 160;
  function phaseTarget(geo, x, y, dx, dy) {
    const r = C.PR + 1, step = 4;
    for (let d = PHASE_DIST; d <= PHASE_DIST + PHASE_OVERSHOOT; d += step) {
      const tx = x + dx * d, ty = y + dy * d;
      if (tx < r || tx > geo.W - r || ty < r || ty > geo.H - r) break;
      if (!blocked(geo, tx, ty, r)) return [tx, ty];
    }
    for (let d = PHASE_DIST - step; d >= 40; d -= step) {
      const tx = x + dx * d, ty = y + dy * d;
      if (!blocked(geo, tx, ty, r)) return [tx, ty];
    }
    return null;
  }

  // Maps are laid out on a 1600x900 grid and scaled to the round's size.
  const pillars = [];
  for (const x of [260, 520, 780, 1040, 1300]) for (const y of [180, 420, 660]) {
    if (x === 780 && y === 420) pillars.push([750, 390, 100, 120]); else pillars.push([x, y, 56, 56]);
  }
  const MAPS = [
    { name: "Pausenhof", floor: "#2b3038", deco: "court", obs: [
      [250, 170, 170, 56], [1180, 170, 170, 56], [250, 674, 170, 56], [1180, 674, 170, 56],
      [735, 360, 130, 180], [560, 90, 56, 190], [984, 620, 56, 190], [450, 430, 110, 40], [1040, 430, 110, 40]] },
    { name: "Turnhalle", floor: "#33291f", deco: "gym", obs: [
      [200, 200, 420, 36], [980, 200, 420, 36], [200, 664, 420, 36], [980, 664, 420, 36],
      [600, 420, 400, 60], [110, 410, 70, 80], [1420, 410, 70, 80]] },
    { name: "Labyrinth", floor: "#243029", deco: "grid", obs: [
      [320, 110, 40, 300], [320, 560, 40, 230], [560, 240, 300, 40], [760, 280, 40, 200],
      [560, 620, 520, 40], [1040, 110, 40, 250], [1040, 460, 40, 160], [1280, 300, 40, 400],
      [1120, 440, 160, 40], [110, 440, 150, 40]] },
    { name: "Kreuzung", floor: "#2c2836", deco: "cross", obs: [
      [740, 250, 120, 400], [590, 390, 420, 120],
      [150, 110, 190, 130], [1260, 110, 190, 130], [150, 660, 190, 130], [1260, 660, 190, 130]] },
    { name: "Säulenhalle", floor: "#302b29", deco: "tiles", obs: pillars }
  ];

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function geometry(m, z) {
    const W = SIZES[z][0], H = SIZES[z][1], s = W / 1600;
    return { W, H, s, OBS: MAPS[m].obs.map(o => o.map(v => v * s)) };
  }

  function blocked(geo, x, y, r) {
    if (x < r || x > geo.W - r || y < r || y > geo.H - r) return true;
    for (const o of geo.OBS) if (x > o[0] - r && x < o[0] + o[2] + r && y > o[1] - r && y < o[1] + o[3] + r) return true;
    return false;
  }

  function pushOut(geo, p) {
    const PR = C.PR;
    p.x = clamp(p.x, PR, geo.W - PR); p.y = clamp(p.y, PR, geo.H - PR);
    for (const o of geo.OBS) {
      const cx = clamp(p.x, o[0], o[0] + o[2]), cy = clamp(p.y, o[1], o[1] + o[3]);
      const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
      if (d2 >= PR * PR) continue;
      if (d2 > 1e-6) { const d = Math.sqrt(d2); p.x = cx + dx / d * PR; p.y = cy + dy / d * PR; }
      else {
        const l = p.x - o[0], r = o[0] + o[2] - p.x, t = p.y - o[1], b = o[1] + o[3] - p.y, mn = Math.min(l, r, t, b);
        if (mn === l) p.x = o[0] - PR; else if (mn === r) p.x = o[0] + o[2] + PR; else if (mn === t) p.y = o[1] - PR; else p.y = o[1] + o[3] + PR;
      }
    }
  }

  // Input bits: 1 up, 2 down, 4 left, 8 right, 16 dash held.
  // Same function on server and client, so the client can predict its own movement.
  function stepMove(geo, p, k, dt, turbo) {
    p.dash -= dt; p.dashCd -= dt;
    let mx = 0, my = 0;
    if (k & 1) my -= 1;
    if (k & 2) my += 1;
    if (k & 4) mx -= 1;
    if (k & 8) mx += 1;
    if ((k & 16) && p.dashCd <= 0 && (mx || my)) { p.dash = C.DASH_T; p.dashCd = C.DASH_CD; p.dashed = true; }
    const len = Math.hypot(mx, my) || 1;
    const sp = C.SPEED * (p.dash > 0 ? C.DASH_MULT : 1) * (turbo ? C.TURBO_MULT : 1);
    p.x += mx / len * sp * dt; pushOut(geo, p);
    p.y += my / len * sp * dt; pushOut(geo, p);
  }

  function segDist(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay, l2 = vx * vx + vy * vy;
    const t = clamp(l2 ? ((px - ax) * vx + (py - ay) * vy) / l2 : 0, 0, 1);
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  }

  // a throw that bounced off a wall or a shield hits harder
  const dmgOf = (kind, bounced) => bounced ? Math.max(2, WEAP[kind].dmg) : WEAP[kind].dmg;

  return { C, COLORS, SIZES, WEAP, PU, MAPS, clamp, geometry, blocked, pushOut, stepMove, segDist, dmgOf, phaseTarget };
});
