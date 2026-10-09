import { DurableObject } from "cloudflare:workers";

/* ───────── konstanty ───────── */
const N = 15,
  NT = 4,
  GRACE = 90_000,
  MAX_GAMES = 2000;
const TIMES = [0, 1, 3, 5, 10, 15],
  INCS = [0, 2, 5, 10];
const SWAPS = ["none", "swap1", "swap2"],
  COLORS = ["random", "host-x", "host-o"],
  STARTS = ["host", "guest", "random"];
const MAX_POSTS = 500;
const HOWS = ["five", "time", "resign", "abandon"];
const BADGES = ["book", "good", "great", "miss", "blunder"];

const defRules = () => ({
  time: 10,
  inc: 0,
  swap: "none",
  color: "random",
  start: "host",
});
const blank = (id) => ({
  id,
  phase: "empty",
  host: 0,
  rules: defRules(),
  seats: [null, null],
  game: null,
  chat: [],
});
const cnt = (t) => t.seats.filter(Boolean).length;

/* ───────── čisté funkce ───────── */
function findWin(ms) {
  if (!ms.length) return null;
  const p = (ms.length - 1) % 2,
    set = new Set();
  ms.forEach((m, i) => {
    if (i % 2 === p) set.add(m.x + "," + m.y);
  });
  const l = ms[ms.length - 1];
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]) {
    const line = [[l.x, l.y]];
    for (const s of [1, -1]) {
      let x = l.x + dx * s,
        y = l.y + dy * s;
      while (set.has(x + "," + y)) {
        line.push([x, y]);
        x += dx * s;
        y += dy * s;
      }
    }
    if (line.length >= 5) return line;
  }
  return null;
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function cleanName(n, fb = "Hráč") {
  return (
    String(n ?? "")
      .replace(/[\u0000-\u001f<>]/g, "")
      .trim()
      .slice(0, 20) || fb
  );
}

function cleanRules(r, prev = defRules()) {
  r = r && typeof r === "object" ? r : {};
  return {
    time: TIMES.includes(+r.time) ? +r.time : prev.time,
    inc: INCS.includes(+r.inc) ? +r.inc : prev.inc,
    swap: SWAPS.includes(r.swap) ? r.swap : prev.swap,
    color: COLORS.includes(r.color) ? r.color : prev.color,
    start: STARTS.includes(r.start) ? r.start : prev.start,
  };
}

function cleanMoves(a, seen) {
  if (!Array.isArray(a) || a.length > N * N) return null;
  const out = [];
  for (const m of a) {
    if (
      !m ||
      !Number.isInteger(m.x) ||
      !Number.isInteger(m.y) ||
      m.x < 0 ||
      m.y < 0 ||
      m.x >= N ||
      m.y >= N ||
      seen.has(m.x + "," + m.y)
    )
      return null;
    seen.add(m.x + "," + m.y);
    out.push({ x: m.x, y: m.y });
  }
  return out;
}

function cleanNotes(o, len) {
  const notes = {};
  if (o && typeof o === "object")
    for (const k in o) {
      const i = +k,
        v = o[k];
      if (!Number.isInteger(i) || i < 0 || i >= len || !v) continue;
      const r = {};
      if (typeof v.b === "string" && BADGES.includes(v.b)) r.b = v.b;
      if (typeof v.t === "string" && v.t) r.t = v.t.slice(0, 2000);
      if (r.b || r.t) notes[i] = r;
    }
  return notes;
}

function cleanVars(vars, ms) {
  const out = [],
    ids = new Set();
  if (Array.isArray(vars))
    for (const v of vars.slice(0, 300)) {
      if (!v || !Number.isInteger(v.at) || v.at < 0 || v.at > ms.length)
        continue;
      const vm = cleanMoves(
        v.moves,
        new Set(ms.slice(0, v.at).map((m) => m.x + "," + m.y)),
      );
      if (!vm || !vm.length) continue;
      let id = Number.isSafeInteger(v.id)
        ? v.id
        : Date.now() * 100 + out.length;
      while (ids.has(id)) id++;
      ids.add(id);
      out.push({
        id,
        at: v.at,
        moves: vm,
        notes: cleanNotes(v.notes, vm.length),
      });
    }
  return out;
}

/* kdo je právě na řadě (index sedadla) */
function actor(t) {
  const g = t.game;
  switch (g.stage) {
    case "opening":
      return g.opener;
    case "choice":
    case "extra":
      return 1 - g.opener;
    case "choice2":
      return g.opener;
    case "play":
      return g.colors[g.moves.length % 2 === 0 ? "X" : "O"];
    default:
      return null;
  }
}

/* ───────── Worker ───────── */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket")
        return new Response("Expected WebSocket", { status: 426 });
      return env.LOBBY.get(env.LOBBY.idFromName("main")).fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

/* ───────── Durable Object: celá herna ───────── */
export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
    ctx.blockConcurrencyWhile(async () => {
      this.tables =
        (await ctx.storage.get("tables")) ||
        Array.from({ length: NT }, (_, i) => blank(i));
      const m = await ctx.storage.list({ prefix: "g:" });
      this.games = new Map([...m.values()].map((g) => [g.id, g]));
      const p = await ctx.storage.list({ prefix: "n:" });
      this.posts = new Map([...p.values()].map((x) => [x.id, x]));
      this.last = new Map();
      for (const t of this.tables) {
        t.chat = t.chat || [];
        t.rules = { ...defRules(), ...t.rules };
      }
    });
  }

  async fetch(request) {
    const o = request.headers.get("Origin");
    if (o && new URL(o).host !== new URL(request.url).host)
      return new Response("Forbidden", { status: 403 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ── odesílání ── */
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* zavřeno */
    }
  }

  view(t, cid) {
    const g = t.game;
    return {
      id: t.id,
      phase: t.phase,
      host: t.host,
      rules: t.rules,
      seats: t.seats.map(
        (s) => s && { name: s.name, me: s.cid === cid, disc: !!s.disc },
      ),
      game: g && {
        stage: g.stage,
        opener: g.opener,
        colors: g.colors,
        moves: g.moves,
        clock: g.clock,
        since: g.since,
        actor: g.stage === "over" ? null : actor(t),
        result: g.result,
        savedId: g.savedId,
        undoReq: g.undoReq || null,
        base: g.base ?? (t.rules.swap !== "none" ? 3 : 0),
      },
    };
  }

  pushTable(t) {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.cid)
        this.send(ws, { t: "table", now, table: this.view(t, a.cid) });
    }
  }

  broadcast(msg, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && a.cid) this.send(ws, msg);
    }
  }

  /* ── chat u stolu ── */
  sendLog(ws, t) {
    this.send(ws, { t: "chatlog", table: t.id, msgs: t.chat });
  }
  sendLogWatchers(t) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a && a.watch === t.id && this.seatOf(t, a.cid) < 0)
        this.sendLog(ws, t);
    }
  }
  resetTable(t) {
    Object.assign(t, blank(t.id));
    this.sendLogWatchers(t);
  }
  limited(cid, kind, ms) {
    const k = cid + kind,
      now = Date.now();
    if (now - (this.last.get(k) || 0) < ms) return true;
    if (this.last.size > 2000) this.last.clear();
    this.last.set(k, now);
    return false;
  }

  /* ── persistence + budík (časovače, odpojení) ── */
  async commit() {
    await this.ctx.storage.put("tables", this.tables);
    let next = Infinity;
    for (const t of this.tables) {
      if (t.phase !== "play") continue;
      for (const s of t.seats)
        if (s && s.disc) next = Math.min(next, s.disc + GRACE);
      if (t.rules.time)
        next = Math.min(next, t.game.since + t.game.clock[actor(t)]);
    }
    if (next === Infinity) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 25));
  }

  async alarm() {
    const now = Date.now();
    for (const t of this.tables) {
      if (t.phase !== "play") continue;
      const g = t.game;
      const dead = t.seats
        .map((s, i) => (s && s.disc && now - s.disc >= GRACE ? i : -1))
        .filter((i) => i >= 0);
      if (dead.length === 2) {
        this.finish(t, null, "abandon", now);
        this.resetTable(t);
      } else if (dead.length === 1) {
        this.finish(t, 1 - dead[0], "abandon", now);
        t.seats[dead[0]] = null;
      } else if (t.rules.time) {
        const a = actor(t);
        if (g.clock[a] - (now - g.since) <= 30) {
          g.clock[a] = 0;
          this.finish(t, 1 - a, "time", now);
        }
      }
      this.pushTable(t);
    }
    await this.commit();
  }

  /* ── WebSocket události ── */
  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 250_000) return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (!m || typeof m !== "object") return;
    try {
      if (m.t === "hello") return await this.hello(ws, m);
      const a = ws.deserializeAttachment();
      if (!a || !a.cid) return;
      await this.handle(ws, a.cid, m);
    } catch (e) {
      this.send(ws, { t: "err", msg: e && e.message ? e.message : "Chyba" });
    }
  }

  async webSocketClose(ws) {
    await this.dropped(ws);
    try {
      ws.close();
    } catch {
      /* */
    }
  }
  async webSocketError(ws) {
    await this.dropped(ws);
  }

  async hello(ws, m) {
    if (typeof m.cid !== "string" || !/^[\w-]{8,64}$/.test(m.cid))
      throw new Error("Neplatné ID klienta");
    ws.serializeAttachment({ cid: m.cid });
    let touched = false;
    for (const t of this.tables)
      for (const s of t.seats)
        if (s && s.cid === m.cid && s.disc) {
          delete s.disc;
          touched = true;
        }
    this.send(ws, {
      t: "init",
      now: Date.now(),
      you: hash(m.cid),
      tables: this.tables.map((t) => this.view(t, m.cid)),
      games: [...this.games.values()],
      posts: [...this.posts.values()],
    });
    const mine = this.myTable(m.cid);
    if (mine) this.sendLog(ws, mine);
    if (touched) {
      for (const t of this.tables) this.pushTable(t);
      await this.commit();
    }
  }

  async dropped(ws) {
    const a = ws.deserializeAttachment();
    if (!a || !a.cid) return;
    const still = this.ctx
      .getWebSockets()
      .some(
        (w) =>
          w !== ws &&
          w.readyState === 1 &&
          (w.deserializeAttachment() || {}).cid === a.cid,
      );
    if (still) return;
    const now = Date.now();
    for (const t of this.tables) {
      const i = this.seatOf(t, a.cid);
      if (i < 0) continue;
      if (t.phase === "play") t.seats[i].disc = now;
      else this.unseat(t, i);
      this.pushTable(t);
    }
    await this.commit();
  }

  /* ── pomocné ── */
  seatOf(t, cid) {
    return t.seats.findIndex((s) => s && s.cid === cid);
  }
  myTable(cid) {
    return this.tables.find((t) => this.seatOf(t, cid) >= 0);
  }

  unseat(t, i) {
    t.seats[i] = null;
    if (cnt(t) === 0) {
      this.resetTable(t);
      return;
    }
    if (t.phase === "waiting" || t.phase === "setup") {
      t.phase = "waiting";
      t.host = t.seats.findIndex(Boolean);
      t.game = null;
    }
  }

  spend(t, now) {
    const g = t.game;
    if (!t.rules.time) {
      g.since = now;
      return true;
    }
    const a = actor(t);
    g.clock[a] -= now - g.since;
    g.since = now;
    return g.clock[a] > 0;
  }

  addGame(rec) {
    if (this.games.size >= MAX_GAMES) {
      let o = null;
      for (const g of this.games.values())
        if (!o || (g.ts || 0) < (o.ts || 0)) o = g;
      if (o) {
        this.games.delete(o.id);
        this.ctx.storage.delete("g:" + o.id);
        this.broadcast({ t: "gameDel", id: o.id });
      }
    }
    this.games.set(rec.id, rec);
    this.ctx.storage.put("g:" + rec.id, rec);
  }

  finish(t, winSeat, how, now) {
    const g = t.game;
    if (!g.colors) {
      const o = g.opener ?? 0;
      g.colors = { X: o, O: 1 - o };
    }
    const wc = winSeat == null ? null : g.colors.X === winSeat ? "X" : "O";
    g.result = { win: wc || (how === "abandon" ? "open" : "draw"), how };
    g.stage = "over";
    t.phase = "over";
    g.since = now;
    g.undoReq = null;
    if (g.moves.length) {
      const p1 = t.seats[g.colors.X].name,
        p2 = t.seats[g.colors.O].name;
      const rec = {
        id: crypto.randomUUID(),
        name: `${p1} vs ${p2}`,
        p1,
        p2,
        moves: g.moves.map((m) => ({ x: m.x, y: m.y })),
        notes: {},
        vars: [],
        res:
          wc === "X" ? 0 : wc === "O" ? 1 : how === "abandon" ? "open" : "draw",
        how,
        ts: now,
        rules: { ...t.rules },
      };
      this.addGame(rec);
      g.savedId = rec.id;
      this.broadcast({ t: "game", game: rec });
    }
  }

  cleanGame(g) {
    if (!g || typeof g !== "object") return null;
    const ms = cleanMoves(g.moves, new Set());
    if (!ms || !ms.length) return null;
    const p1 = cleanName(g.p1, "Hráč 1"),
      p2 = cleanName(g.p2, "Hráč 2");
    const win = findWin(ms),
      auto = win ? (ms.length - 1) % 2 : ms.length === N * N ? "draw" : "open";
    const how = HOWS.includes(g.how) ? g.how : undefined;
    const res = win
      ? auto
      : (how === "time" || how === "resign" || how === "abandon") &&
          (g.res === 0 || g.res === 1)
        ? g.res
        : auto;
    const id =
      typeof g.id === "string" &&
      /^[\w-]{8,64}$/.test(g.id) &&
      !this.games.has(g.id)
        ? g.id
        : crypto.randomUUID();
    return {
      id,
      name: `${p1} vs ${p2}`,
      p1,
      p2,
      moves: ms,
      notes: cleanNotes(g.notes, ms.length),
      vars: cleanVars(g.vars, ms),
      res,
      how,
      cat: g.cat === "theory" ? "theory" : undefined,
      ts: Number.isFinite(g.ts) ? g.ts : Date.now(),
      date: typeof g.date === "string" ? g.date.slice(0, 40) : undefined,
      rules: g.rules ? cleanRules(g.rules) : undefined,
    };
  }

  /* ── zprávy od klienta ── */
  async handle(ws, cid, m) {
    const now = Date.now();
    const done = async (t) => {
      this.pushTable(t);
      await this.commit();
    };

    /* uložené hry (sdílená hromada) */
    if (m.t === "add") {
      for (const g of (Array.isArray(m.games) ? m.games : []).slice(0, 50)) {
        const rec = this.cleanGame(g);
        if (rec) {
          this.addGame(rec);
          this.broadcast({ t: "game", game: rec }, ws);
        }
      }
      return;
    }
    if (m.t === "cat") {
      const g = this.games.get(String(m.id));
      if (!g) return;
      g.cat = m.cat === "theory" ? "theory" : undefined;
      this.ctx.storage.put("g:" + g.id, g);
      this.broadcast({ t: "game", game: g });
      return;
    }
    if (m.t === "del") {
      const id = String(m.id);
      if (this.games.delete(id)) {
        this.ctx.storage.delete("g:" + id);
        this.broadcast({ t: "gameDel", id }, ws);
      }
      return;
    }
    if (m.t === "annot") {
      const g = this.games.get(String(m.id));
      if (!g) return;
      g.notes = cleanNotes(m.notes, g.moves.length);
      g.vars = cleanVars(m.vars, g.moves);
      this.ctx.storage.put("g:" + g.id, g);
      this.broadcast({ t: "game", game: g }, ws);
      return;
    }

    /* nástěnka nápadů */
    if (m.t === "post") {
      const text = String(m.text ?? "")
        .replace(/\r/g, "")
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, 1000);
      if (!text) return;
      if (this.limited(cid, "post", 1500))
        throw new Error("Pomalu, píšeš moc rychle.");
      if (this.posts.size >= MAX_POSTS) {
        let o = null;
        for (const x of this.posts.values()) if (!o || x.ts < o.ts) o = x;
        if (o) {
          this.posts.delete(o.id);
          this.ctx.storage.delete("n:" + o.id);
          this.broadcast({ t: "postDel", id: o.id });
        }
      }
      const rec = {
        id: crypto.randomUUID(),
        name: cleanName(m.name),
        text,
        ts: now,
      };
      this.posts.set(rec.id, rec);
      this.ctx.storage.put("n:" + rec.id, rec);
      this.broadcast({ t: "post", post: rec });
      return;
    }
    if (m.t === "postDel") {
      const id = String(m.id);
      if (this.posts.delete(id)) {
        this.ctx.storage.delete("n:" + id);
        this.broadcast({ t: "postDel", id });
      }
      return;
    }

    /* sledování stolu + chat */
    if (m.t === "watch") {
      const a = ws.deserializeAttachment() || { cid };
      const t = Number.isInteger(m.table) ? this.tables[m.table] : null;
      if (t && !this.myTable(cid)) {
        a.watch = t.id;
        a.wname = cleanName(m.name);
        ws.serializeAttachment(a);
        this.sendLog(ws, t);
      } else {
        delete a.watch;
        ws.serializeAttachment(a);
      }
      return;
    }
    if (m.t === "chat") {
      const a = ws.deserializeAttachment() || { cid };
      const mt = this.myTable(cid);
      const t = mt || (Number.isInteger(a.watch) ? this.tables[a.watch] : null);
      if (!t) return;
      const text = String(m.text ?? "")
        .replace(/[\u0000-\u001f]/g, " ")
        .trim()
        .slice(0, 300);
      if (!text) return;
      if (this.limited(cid, "chat", 500)) return;
      const i = mt ? this.seatOf(t, cid) : -1;
      const msg = {
        name: i >= 0 ? t.seats[i].name : cleanName(a.wname),
        text,
        ts: now,
        role: i >= 0 ? "p" : "w",
        by: hash(cid),
      };
      t.chat.push(msg);
      if (t.chat.length > 100) t.chat.shift();
      for (const w of this.ctx.getWebSockets()) {
        const x = w.deserializeAttachment();
        if (x && x.cid && (this.seatOf(t, x.cid) >= 0 || x.watch === t.id))
          this.send(w, { t: "chat", table: t.id, msg });
      }
      await this.ctx.storage.put("tables", this.tables);
      return;
    }

    /* stoly */
    if (m.t === "sit") {
      if (this.myTable(cid)) throw new Error("Už sedíš u stolu.");
      const t = Number.isInteger(m.table) ? this.tables[m.table] : null;
      if (!t) throw new Error("Neznámý stůl.");
      const i = m.seat === 1 ? 1 : 0;
      if (t.seats[i]) throw new Error("Místo je obsazené.");
      t.seats[i] = { cid, name: cleanName(m.name) };
      {
        const a = ws.deserializeAttachment() || { cid };
        delete a.watch;
        ws.serializeAttachment(a);
      }
      if (t.phase !== "over") {
        if (cnt(t) === 1) {
          t.phase = "waiting";
          t.host = i;
          t.game = null;
        } else t.phase = "setup";
      }
      this.sendLog(ws, t);
      return done(t);
    }

    const t = this.myTable(cid);
    if (!t) return;
    const me = this.seatOf(t, cid),
      g = t.game;

    switch (m.t) {
      case "leave":
        if (t.phase === "play") {
          this.finish(t, 1 - me, "resign", now);
          t.seats[me] = null;
        } else this.unseat(t, me);
        return done(t);

      case "rules":
        if (t.phase !== "setup" || me !== t.host) return;
        t.rules = cleanRules(m.rules, t.rules);
        return done(t);

      case "start": {
        if (t.phase !== "setup" || me !== t.host || cnt(t) !== 2) return;
        const R = t.rules;
        const ng = {
          opener: null,
          colors: null,
          stage: "opening",
          moves: [],
          clock: [R.time * 60000, R.time * 60000],
          since: now,
          result: null,
          savedId: null,
        };
        if (R.swap === "none") {
          const hx =
            R.color === "host-x" ||
            (R.color === "random" && Math.random() < 0.5);
          ng.colors = {
            X: hx ? t.host : 1 - t.host,
            O: hx ? 1 - t.host : t.host,
          };
          ng.stage = "play";
          ng.base = 0;
        } else
          ng.opener =
            R.start === "guest"
              ? 1 - t.host
              : R.start === "random"
                ? Math.random() < 0.5
                  ? t.host
                  : 1 - t.host
                : t.host;
        t.game = ng;
        t.phase = "play";
        return done(t);
      }

      case "again": {
        if (t.phase !== "over") return;
        t.game = null;
        t.host = me;
        t.phase = cnt(t) === 2 ? "setup" : "waiting";
        return done(t);
      }

      case "resign":
        if (t.phase !== "play") return;
        this.finish(t, 1 - me, "resign", now);
        return done(t);

      case "undo": {
        if (t.phase !== "play" || g.stage !== "play" || g.undoReq) return;
        const k = actor(t) === me ? 2 : 1,
          base = g.base ?? (t.rules.swap !== "none" ? 3 : 0);
        if (g.moves.length - k < base) throw new Error("Není co vracet.");
        g.undoReq = { seat: me, k };
        return done(t);
      }

      case "undoCancel":
        if (t.phase !== "play" || !g.undoReq || g.undoReq.seat !== me) return;
        g.undoReq = null;
        return done(t);

      case "undoAns": {
        if (
          t.phase !== "play" ||
          g.stage !== "play" ||
          !g.undoReq ||
          g.undoReq.seat === me
        )
          return;
        const r = g.undoReq,
          ask = t.seats[r.seat];
        g.undoReq = null;
        if (m.ok) {
          if (!this.spend(t, now)) {
            this.finish(t, 1 - me, "time", now);
            return done(t);
          }
          g.moves.splice(g.moves.length - r.k, r.k);
          g.since = now;
        }
        for (const w of this.ctx.getWebSockets()) {
          const x = w.deserializeAttachment();
          if (x && ask && x.cid === ask.cid)
            this.send(w, {
              t: "info",
              msg: m.ok
                ? "Soupeř souhlasil – tah je vrácen."
                : "Soupeř vrácení tahu odmítl.",
            });
        }
        return done(t);
      }

      case "move": {
        if (
          t.phase !== "play" ||
          !["opening", "extra", "play"].includes(g.stage)
        )
          throw new Error("Teď se netáhne.");
        if (actor(t) !== me) throw new Error("Nejsi na tahu.");
        const x = m.x,
          y = m.y;
        if (
          !Number.isInteger(x) ||
          !Number.isInteger(y) ||
          x < 0 ||
          y < 0 ||
          x >= N ||
          y >= N
        )
          return;
        if (g.moves.some((q) => q.x === x && q.y === y)) return;
        if (!this.spend(t, now)) {
          this.finish(t, 1 - me, "time", now);
          return done(t);
        }
        const st = g.stage;
        g.moves.push({ x, y });
        g.undoReq = null;
        if (st === "opening" && g.moves.length === 3) g.stage = "choice";
        else if (st === "extra" && g.moves.length === 5) g.stage = "choice2";
        else if (st === "play") {
          if (findWin(g.moves)) this.finish(t, me, "five", now);
          else if (g.moves.length === N * N) this.finish(t, null, "draw", now);
          else if (t.rules.time && t.rules.inc)
            g.clock[me] += t.rules.inc * 1000;
        }
        return done(t);
      }

      case "choose": {
        if (
          t.phase !== "play" ||
          (g.stage !== "choice" && g.stage !== "choice2")
        )
          throw new Error("Teď nelze vybírat.");
        if (actor(t) !== me) throw new Error("Nejsi na řadě.");
        if (!this.spend(t, now)) {
          this.finish(t, 1 - me, "time", now);
          return done(t);
        }
        const pick = m.pick;
        if (g.stage === "choice" && pick === "more") {
          if (t.rules.swap !== "swap2")
            throw new Error("Tohle pravidlo to nedovoluje.");
          g.stage = "extra";
        } else if (pick === "X" || pick === "O") {
          g.colors = { X: null, O: null };
          g.colors[pick] = me;
          g.colors[pick === "X" ? "O" : "X"] = 1 - me;
          g.base = g.moves.length;
          g.stage = "play";
        } else throw new Error("Neplatná volba.");
        return done(t);
      }
    }
  }
}
