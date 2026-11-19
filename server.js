const http = require("http");
const fs = require("fs");
const path = require("path");

const API_KEY = process.env.API_KEY || "dev-key-change-me";
const PORT = Number(process.env.PORT || 8787);
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

const CHARACTERS = ["A", "B", "C"];
const MODES = ["fog", "vhs", "glitch", "purple", "vibrate", "flash"];

function loadShow() {
  const file = path.join(__dirname, "show.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function freshState() {
  return {
    revision: 0,
    characterId: "A",
    actionId: "1",
    effects: { vhs: 0.45, fog: 0.55, glitch: 0.12 },
    burstRevision: 0,
    burstEffect: ""
  };
}

function freshConcert() {
  return {
    revision: 0,
    character: "",
    fog: false,
    vhs: false,
    glitch: false,
    purple: false,
    vibrate: false,
    flash: false,
    updatedAt: 0
  };
}

const memory = {
  "upside-down-state": freshState(),
  "nova-concert": freshConcert()
};

function useKv() {
  return Boolean(KV_URL && KV_TOKEN);
}

async function kv(args) {
  const response = await fetch(KV_URL, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + KV_TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });
  if (!response.ok) {
    throw new Error("KV respondió " + response.status);
  }
  const data = await response.json();
  return data.result;
}

async function read(key, fresh) {
  if (!useKv()) return memory[key];
  const raw = await kv(["GET", key]);
  if (!raw) return fresh();
  try {
    return Object.assign(fresh(), JSON.parse(raw));
  } catch (error) {
    return fresh();
  }
}

async function write(key, value) {
  memory[key] = value;
  if (!useKv()) return;
  await kv(["SET", key, JSON.stringify(value)]);
}

function applyCommand(state, id, show) {
  const next = JSON.parse(JSON.stringify(state));
  next.revision += 1;
  next.burstEffect = "";

  const character = (show.characters || []).find((item) => item.id === id);
  if (character) {
    next.characterId = id;
    return next;
  }

  const action = (show.actions || []).find((item) => item.id === id);
  if (!action) return null;

  if (action.kind === "effect") {
    const effect = action.effect || "";
    if (effect === "vhs") {
      next.effects.vhs = next.effects.vhs > 0.7 ? 0.45 : 1;
    } else if (effect === "fog") {
      next.effects.fog = next.effects.fog > 0.75 ? 0.55 : 1;
    } else {
      next.burstRevision += 1;
      next.burstEffect = effect || "glitch";
      next.effects.glitch = 0.12;
    }
    return next;
  }

  next.actionId = id;
  return next;
}

/**
 * Personajes: tocar uno lo muestra, tocar el que ya esta lo esconde.
 * Modos: cada uno se prende y apaga por separado; "on" fuerza el valor.
 * "reset" apaga todo.
 */
function applyConcert(state, id, on) {
  const next = Object.assign(freshConcert(), state);
  if (id === "reset") {
    Object.assign(next, freshConcert());
  } else if (CHARACTERS.includes(id)) {
    const show = typeof on === "boolean" ? on : next.character !== id;
    next.character = show ? id : next.character === id ? "" : next.character;
  } else if (MODES.includes(id)) {
    next[id] = typeof on === "boolean" ? on : !next[id];
  } else {
    return null;
  }
  next.revision = (state.revision || 0) + 1;
  next.updatedAt = Date.now();
  return next;
}

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function send(res, status, body, cache) {
  const json = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": cache || "no-store"
  }, HEADERS));
  res.end(json);
}

function authorized(req) {
  return req.headers["x-api-key"] === API_KEY;
}

function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === "string" ? req.body : JSON.stringify(req.body));
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req, res) {
  try {
    return JSON.parse((await readBody(req)) || "{}");
  } catch (error) {
    send(res, 400, { error: "json" });
    return null;
  }
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }

  const url = new URL(req.url, "http://localhost");
  // En Vercel todo se reescribe a /api/index y la ruta pedida llega en ?path=.
  const routed = url.searchParams.get("path");
  if (routed) url.pathname = routed.replace(/\/+$/, "") || "/";
  else if (url.pathname === "/api/index") url.pathname = "/";

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/panel")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(__dirname, "panel.html"), "utf8"));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true, storage: useKv() ? "upstash" : "memoria" });
    return;
  }

  if (url.pathname === "/api/concert") {
    if (req.method === "GET") {
      // Miles de celulares preguntan cada segundo: el CDN de Vercel responde
      // y la funcion corre como mucho una vez por segundo.
      const state = await read("nova-concert", freshConcert);
      send(res, 200, Object.assign({ serverTime: Date.now() }, state),
        "public, max-age=0, s-maxage=1, stale-while-revalidate=1");
      return;
    }
    if (req.method === "POST") {
      if (!authorized(req)) {
        send(res, 401, { error: "api key" });
        return;
      }
      const payload = await readJson(req, res);
      if (!payload) return;
      const id = String(payload.id || "");
      const next = applyConcert(await read("nova-concert", freshConcert), id, payload.on);
      if (!next) {
        send(res, 400, { error: "id desconocido", ids: CHARACTERS.concat(MODES, ["reset"]) });
        return;
      }
      await write("nova-concert", next);
      send(res, 200, Object.assign({ serverTime: Date.now() }, next));
      return;
    }
  }

  if (url.pathname !== "/api/command" && url.pathname !== "/api/state") {
    send(res, 404, { error: "no existe" });
    return;
  }

  if (!authorized(req)) {
    send(res, 401, { error: "api key" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    send(res, 200, await read("upside-down-state", freshState));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/command") {
    const payload = await readJson(req, res);
    if (!payload) return;
    const id = String(payload.id || "");
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      send(res, 400, { error: "id" });
      return;
    }
    const next = applyCommand(await read("upside-down-state", freshState), id, loadShow());
    if (!next) {
      send(res, 404, { error: "id desconocido" });
      return;
    }
    await write("upside-down-state", next);
    send(res, 200, next);
    return;
  }

  send(res, 404, { error: "no existe" });
}

function run(req, res) {
  handler(req, res).catch((error) => {
    send(res, 500, { error: error.message });
  });
}

if (require.main === module) {
  http.createServer(run).listen(PORT, () => {
    console.log("NOVA API en http://127.0.0.1:" + PORT + " (" + (useKv() ? "upstash" : "memoria") + ")");
  });
}

module.exports = run;
module.exports.applyConcert = applyConcert;
