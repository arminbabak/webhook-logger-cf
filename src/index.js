// Webhook Inspector — Cloudflare Worker (free tier, KV storage)
//
// Endpoints:
//   POST/PUT/PATCH/GET/DELETE anything  -> logs the request
//   GET  /api/events?limit=&q=          -> JSON list, newest first
//   GET  /api/events/:id                -> single event
//   DELETE /api/events/:id              -> delete one event
//   DELETE /api/events                  -> wipe all events
//   GET  /                              -> inspector web UI
//
// Optional: `wrangler secret put WEBHOOK_TOKEN` -> senders must set header
// `x-webhook-token: <secret>`; leave unset for an open endpoint.

const MAX_BODY = 256 * 1024;
const DEFAULT_LIST = 200;
const EVENT_TTL = 90 * 24 * 3600; // 90 days, keeps free KV from filling up

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Logging: catch anything that is not an API/UI route.
    if (url.pathname.startsWith("/api/")) {
      if (request.method === "GET" && url.pathname === "/api/events") {
        return listEvents(url, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/events/")) {
        return getEvent(decodeURIComponent(url.pathname.slice("/api/events/".length)), env);
      }
      if (request.method === "DELETE" && url.pathname.startsWith("/api/events/")) {
        return deleteEvent(decodeURIComponent(url.pathname.slice("/api/events/".length)), env);
      }
      if (request.method === "DELETE" && url.pathname === "/api/events") {
        return clearEvents(env);
      }
      return json({ error: "not found" }, 404);
    }

    // The inspector UI itself.
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    // GET/HEAD are never webhooks — don't log them (keeps browser noise out).
    if (request.method === "GET" || request.method === "HEAD") {
      return json({ ok: true, ignored: "only POST/PUT/PATCH/DELETE are logged" });
    }

    // Anything else is an incoming webhook: log it.
    if (env.WEBHOOK_TOKEN) {
      const token = url.searchParams.get("token") || request.headers.get("x-webhook-token");
      if (token !== env.WEBHOOK_TOKEN) return json({ error: "unauthorized" }, 401);
    }
    return logEvent(request, env);
  },
};

// ---------- storage ----------

async function logEvent(request, env) {
  const raw = await request.text();
  const body = raw.length > MAX_BODY ? raw.slice(0, MAX_BODY) : raw;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // not JSON — keep as text
  }

  const ts = Date.now();
  // Reverse-timestamp key => KV list (lexicographic) returns newest first.
  const key = `evt:${(9999999999999 - ts).toString().padStart(13, "0")}:${crypto.randomUUID()}`;

  const headers = {};
  request.headers.forEach((v, k) => (headers[k] = v));

  const u = new URL(request.url);
  const event = {
    id: key,
    ts: new Date(ts).toISOString(),
    method: request.method,
    path: u.pathname,
    query: u.search.replace(/^\?/, ""),
    headers,
    body: parsed !== null ? parsed : body,
    truncated: raw.length > MAX_BODY,
    meta: {
      contentType: request.headers.get("content-type") || null,
      contentLength: raw.length,
      userAgent: request.headers.get("user-agent") || null,
      ip: request.headers.get("cf-connecting-ip") || null,
      country: request.headers.get("cf-ipcountry") || null,
      ray: request.headers.get("cf-ray") || null,
    },
  };

  await env.EVENTS.put(key, JSON.stringify(event), { expirationTtl: EVENT_TTL });
  return json({ ok: true, id: key });
}

async function listEvents(url, env) {
  const limit = Math.min(parseInt(url.searchParams.get("limit") || DEFAULT_LIST, 10) || DEFAULT_LIST, 1000);
  const q = (url.searchParams.get("q") || "").toLowerCase();
  let result;
  try {
    result = await env.EVENTS.list({ limit });
  } catch (e) {
    // Free tier allows only 1,000 KV list() calls/day; surface it cleanly.
    return json({ error: "kv list failed", detail: String((e && e.message) || e) }, 500);
  }
  let events = await Promise.all(
    result.keys.map((k) => env.EVENTS.get(k.name, "json").catch(() => null))
  );
  events = events.filter(Boolean);
  if (q) {
    events = events.filter((e) => {
      try {
        return JSON.stringify(e).toLowerCase().includes(q);
      } catch {
        return false;
      }
    });
  }
  return json({ count: events.length, events });
}

async function getEvent(id, env) {
  const event = await env.EVENTS.get(id, "json").catch(() => null);
  return event ? json(event) : json({ error: "not found" }, 404);
}

async function deleteEvent(id, env) {
  await env.EVENTS.delete(id);
  return json({ ok: true });
}

async function clearEvents(env) {
  const result = await env.EVENTS.list({ limit: 1000 });
  await Promise.all(result.keys.map((k) => env.EVENTS.delete(k.name)));
  return json({ ok: true, deleted: result.keys.length });
}

// ---------- helpers ----------

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------- web UI ----------

function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%230d1117'/%3E%3Crect x='0.5' y='0.5' width='23' height='23' rx='4.5' fill='none' stroke='%2330363d'/%3E%3Cpolygon points='13%202%203%2014%2012%2014%2011%2022%2021%2010%2012%2010%2013%202' transform='translate(1.2%201.2)%20scale(0.9)' fill='%2358a6ff'/%3E%3C/svg%3E">
<title>Webhook Inspector</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1117; --panel: #161b22; --panel2: #1c2129; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --post: #3fb950; --get: #58a6ff; --put: #d29922; --patch: #db6d28; --delete: #f85149;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); color: var(--text); display: flex; flex-direction: column; }

  header {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: var(--panel); border-bottom: 1px solid var(--border); flex-wrap: wrap;
  }
  .logo { font-weight: bold; font-size: 14px; white-space: nowrap; }
  .logo .dot { color: var(--accent); }
  .endpoint {
    background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    padding: 5px 10px; color: var(--muted); display: flex; align-items: center; gap: 8px;
    max-width: 420px; overflow: hidden;
  }
  .endpoint .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .endpoint .method-hint { color: var(--post); font-weight: bold; }
  .spacer { flex: 1; }
  input[type=search] {
    background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
    color: var(--text); padding: 5px 10px; font: inherit; width: 200px;
  }
  input[type=search]:focus { outline: none; border-color: var(--accent); }
  button {
    background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit;
  }
  button:hover { background: var(--border); }
  button.primary { background: #1f6feb22; border-color: #1f6feb; color: var(--accent); }
  button.danger:hover { border-color: var(--delete); color: var(--delete); }
  .toggle { display: flex; align-items: center; gap: 5px; color: var(--muted); font-size: 12px; cursor: pointer; user-select: none; }

  .layout { flex: 1; display: flex; min-height: 0; }

  /* ---- request list ---- */
  .list-pane {
    width: 340px; min-width: 260px; border-right: 1px solid var(--border);
    overflow-y: auto; background: var(--panel);
  }
  .req {
    padding: 10px 12px; border-bottom: 1px solid var(--border); cursor: pointer;
    display: flex; flex-direction: column; gap: 3px;
  }
  .req:hover { background: var(--panel2); }
  .req.selected { background: var(--panel2); box-shadow: inset 3px 0 0 var(--accent); }
  .req .row1 { display: flex; align-items: center; gap: 8px; }
  .req .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .req .snippet { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .req time { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .badge {
    font-weight: bold; font-size: 11px; padding: 1px 6px; border-radius: 4px; white-space: nowrap;
  }
  .m-POST { background: #3fb95022; color: var(--post); }
  .m-GET { background: #58a6ff22; color: var(--get); }
  .m-PUT { background: #d2992222; color: var(--put); }
  .m-PATCH { background: #db6d2822; color: var(--patch); }
  .m-DELETE { background: #f8514922; color: var(--delete); }
  .m-other { background: #8b949e22; color: var(--muted); }
  .list-empty { color: var(--muted); text-align: center; padding: 32px 16px; }
  .list-count { padding: 6px 12px; color: var(--muted); font-size: 11px; border-bottom: 1px solid var(--border); background: var(--panel2); position: sticky; top: 0; }

  /* ---- detail pane ---- */
  .detail-pane { flex: 1; overflow-y: auto; min-width: 0; }
  .detail-head {
    padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--panel);
    display: flex; flex-direction: column; gap: 8px;
  }
  .detail-head .title-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .detail-head .path { font-size: 15px; font-weight: bold; word-break: break-all; }
  .detail-head .ts { color: var(--muted); font-size: 12px; }
  .detail-head .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); background: var(--panel); padding: 0 12px; }
  .tab {
    padding: 8px 14px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent;
    font-size: 12px; user-select: none;
  }
  .tab:hover { color: var(--text); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); }
  .tab-content { padding: 16px 18px; }
  pre.body-view {
    margin: 0; white-space: pre-wrap; word-break: break-word;
    font: 12.5px/1.55 ui-monospace, monospace;
  }
  .j-key { color: #79c0ff; }
  .j-str { color: #a5d6ff; }
  .j-num { color: #f2cc60; }
  .j-kw { color: #ff7b72; }
  table.kv { border-collapse: collapse; width: 100%; }
  table.kv td { border: 1px solid var(--border); padding: 6px 10px; vertical-align: top; }
  table.kv td.k { color: var(--accent); white-space: nowrap; width: 1%; }
  table.kv td.v { word-break: break-all; color: var(--text); }
  .overview-grid { display: grid; grid-template-columns: 160px 1fr; gap: 6px 14px; }
  .overview-grid .k { color: var(--muted); }
  .overview-grid .v { word-break: break-all; }
  .flag { background: #8b949e22; color: var(--muted); border-radius: 4px; padding: 1px 6px; font-size: 11px; }
  .detail-empty {
    height: 100%; display: flex; align-items: center; justify-content: center;
    color: var(--muted); flex-direction: column; gap: 10px; padding: 40px; text-align: center;
  }
  .detail-empty .big { font-size: 34px; opacity: .5; }

  /* ---- toasts ---- */
  #toasts { position: fixed; bottom: 18px; right: 18px; display: flex; flex-direction: column; gap: 8px; z-index: 50; }
  .toast {
    background: var(--panel2); border: 1px solid var(--border); border-left: 3px solid var(--accent);
    padding: 10px 14px; border-radius: 6px; animation: slidein .18s ease-out; box-shadow: 0 4px 16px #00000066;
  }
  .toast.success { border-left-color: var(--post); }
  .toast.error { border-left-color: var(--delete); }
  @keyframes slidein { from { transform: translateY(12px); opacity: 0; } to { transform: none; opacity: 1; } }

  @media (max-width: 760px) {
    .layout { flex-direction: column; }
    .list-pane { width: 100%; max-height: 40%; border-right: none; border-bottom: 1px solid var(--border); }
    input[type=search] { width: 130px; }
  }
</style>
</head>
<body>
<header>
  <span class="logo">Webhook Inspector<span class="dot">_</span></span>
  <span class="endpoint" id="endpoint">
    <span class="method-hint">ANY</span>
    <span class="url" id="endpoint-url"></span>
  </span>
  <button id="copy-endpoint" title="Copy webhook URL">Copy URL</button>
  <span class="spacer"></span>
  <input type="search" id="search" placeholder="Filter events...">
  <label class="toggle"><input type="checkbox" id="auto" checked> live</label>
  <button id="refresh" title="Check for new events now">&#8635; Refresh</button>
  <button id="clear" class="danger">Clear all</button>
</header>

<div class="layout">
  <div class="list-pane" id="list-pane">
    <div class="list-count" id="list-count"></div>
    <div id="list"></div>
  </div>
  <div class="detail-pane" id="detail-pane">
    <div class="detail-empty" id="detail-empty">
      <div class="big">&#9889;</div>
      <div>Send any request to the endpoint URL above.</div>
      <div>Events appear here automatically.</div>
    </div>
    <div id="detail" style="display:none"></div>
  </div>
</div>

<div id="toasts"></div>

<script>
var state = { events: [], selectedId: null, q: "", auto: true, timer: null, tab: "body" };

function $(id) { return document.getElementById(id); }

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function toast(msg, kind) {
  var el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(function () { el.remove(); }, 2600);
}

function relTime(iso) {
  var s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return "now";
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function methodClass(m) {
  return { POST: "m-POST", GET: "m-GET", PUT: "m-PUT", PATCH: "m-PATCH", DELETE: "m-DELETE" }[m] || "m-other";
}

function bodyText(e) {
  return typeof e.body === "string" ? e.body : JSON.stringify(e.body, null, 2);
}

function snippet(e) {
  var b = e.body;
  if (b && typeof b === "object") {
    var hint = b.event || b.type || b.action || b.topic;
    if (typeof hint === "string") return hint;
  }
  var t = bodyText(e).replace(/\\s+/g, " ").trim();
  return t.length > 90 ? t.slice(0, 90) + "..." : t;
}

function hiJSON(s) {
  return esc(s).replace(/("(?:\\\\.|[^"\\\\])*")(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/g,
    function (m, str, colon, kw) {
      if (str) return colon
        ? '<span class="j-key">' + str + '</span>' + colon
        : '<span class="j-str">' + str + '</span>';
      if (kw) return '<span class="j-kw">' + m + '</span>';
      return '<span class="j-num">' + m + '</span>';
    });
}

function parseQuery(qs) {
  var out = [];
  qs.split("&").forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf("=");
    var k = i < 0 ? pair : pair.slice(0, i);
    var v = i < 0 ? "" : pair.slice(i + 1);
    try { k = decodeURIComponent(k.replace(/\\+/g, " ")); } catch (e2) {}
    try { v = decodeURIComponent(v.replace(/\\+/g, " ")); } catch (e3) {}
    out.push([k, v]);
  });
  return out;
}

function buildCurl(e) {
  var parts = ["curl -X " + e.method + " '" + location.origin + e.path + (e.query ? "?" + e.query : "") + "'"];
  Object.keys(e.headers || {}).forEach(function (k) {
    var kl = k.toLowerCase();
    if (kl === "content-length" || kl === "host" || kl === "accept-encoding") return;
    parts.push("  -H '" + k + ": " + String(e.headers[k]).replace(/'/g, "'\\\\''") + "'");
  });
  var t = bodyText(e);
  if (t && e.method !== "GET" && e.method !== "HEAD") {
    parts.push("  --data '" + t.replace(/'/g, "'\\\\''") + "'");
  }
  return parts.join(" \\\\\\n");
}

// ---------- list ----------

function filtered() {
  if (!state.q) return state.events;
  var q = state.q.toLowerCase();
  return state.events.filter(function (e) {
    return JSON.stringify(e).toLowerCase().indexOf(q) !== -1;
  });
}

function renderList() {
  var evs = filtered();
  $("list-count").textContent = evs.length + " request" + (evs.length === 1 ? "" : "s") +
    (state.q ? " (filtered from " + state.events.length + ")" : "");
  if (!evs.length) {
    $("list").innerHTML = '<div class="list-empty">' +
      (state.q ? "No events match your filter." : "No requests yet.<br>Send anything to the endpoint.") + '</div>';
    return;
  }
  $("list").innerHTML = evs.map(function (e) {
    var sel = e.id === state.selectedId ? " selected" : "";
    return '<div class="req' + sel + '" data-id="' + esc(e.id) + '">' +
      '<div class="row1">' +
        '<span class="badge ' + methodClass(e.method) + '">' + esc(e.method) + '</span>' +
        '<span class="path">' + esc(e.path) + (e.query ? "?" + esc(e.query) : "") + '</span>' +
        '<time data-ts="' + esc(e.ts) + '">' + relTime(e.ts) + '</time>' +
      '</div>' +
      '<div class="snippet">' + esc(snippet(e)) + '</div>' +
    '</div>';
  }).join("");
  Array.prototype.forEach.call($("list").children, function (el) {
    el.addEventListener("click", function () { select(el.getAttribute("data-id")); });
  });
}

function tickTimes() {
  var now = Date.now();
  Array.prototype.forEach.call(document.querySelectorAll("time[data-ts]"), function (el) {
    el.textContent = relTime(el.getAttribute("data-ts"));
  });
}

// ---------- detail ----------

function kvTable(rows) {
  if (!rows.length) return '<em style="color:var(--muted)">none</em>';
  return '<table class="kv">' + rows.map(function (r) {
    return '<tr><td class="k">' + esc(r[0]) + '</td><td class="v">' + esc(r[1]) + '</td></tr>';
  }).join("") + '</table>';
}

function renderDetail() {
  var e = null;
  for (var i = 0; i < state.events.length; i++) if (state.events[i].id === state.selectedId) { e = state.events[i]; break; }
  if (!e) {
    $("detail").style.display = "none";
    $("detail-empty").style.display = "flex";
    return;
  }
  $("detail").style.display = "";
  $("detail-empty").style.display = "none";

  var tabs = ["body", "headers", "query", "overview", "curl"];
  var labels = { body: "Body", headers: "Headers", query: "Query Params", overview: "Overview", curl: "cURL" };
  var counts = {
    headers: Object.keys(e.headers || {}).length,
    query: parseQuery(e.query || "").length,
  };

  var html = '';
  html += '<div class="detail-head">';
  html += '<div class="title-row">' +
    '<span class="badge ' + methodClass(e.method) + '" style="font-size:13px;padding:3px 10px">' + esc(e.method) + '</span>' +
    '<span class="path">' + esc(e.path) + (e.query ? "?" + esc(e.query) : "") + '</span>' +
    (e.truncated ? '<span class="flag">truncated</span>' : '') +
  '</div>';
  html += '<div class="ts">' + esc(e.ts) + ' &middot; ' + relTime(e.ts) + '</div>';
  html += '<div class="actions">' +
    '<button data-act="copy-json">Copy JSON</button>' +
    '<button data-act="copy-curl">Copy cURL</button>' +
    '<button data-act="copy-url">Copy URL</button>' +
    '<button data-act="delete" class="danger">Delete</button>' +
  '</div>';
  html += '</div>';
  html += '<div class="tabs">' + tabs.map(function (t) {
    var c = ' class="tab' + (state.tab === t ? " active" : "") + '" data-tab="' + t + '"';
    return '<span' + c + '>' + labels[t] + (counts[t] !== undefined ? ' (' + counts[t] + ')' : '') + '</span>';
  }).join("") + '</div>';
  html += '<div class="tab-content" id="tab-content">';
  html += renderTab(e);
  html += '</div>';

  $("detail").innerHTML = html;

  Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (el) {
    el.addEventListener("click", function () {
      state.tab = el.getAttribute("data-tab");
      renderDetail();
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-act]"), function (el) {
    el.addEventListener("click", function () { doAction(el.getAttribute("data-act"), e); });
  });
}

function renderTab(e) {
  var t = state.tab;
  if (t === "body") {
    var txt = bodyText(e);
    if (!txt) return '<em style="color:var(--muted)">empty body</em>';
    var ct = ((e.meta || {}).contentType || "");
    if (ct.indexOf("x-www-form-urlencoded") !== -1 && typeof e.body === "string") {
      return kvTable(parseQuery(e.body));
    }
    return '<pre class="body-view">' + hiJSON(txt) + '</pre>';
  }
  if (t === "headers") {
    return kvTable(Object.keys(e.headers || {}).map(function (k) { return [k, e.headers[k]]; }));
  }
  if (t === "query") {
    return kvTable(parseQuery(e.query || ""));
  }
  if (t === "curl") {
    return '<pre class="body-view">' + esc(buildCurl(e)) + '</pre>';
  }
  // overview
  var m = e.meta || {};
  var rows = [
    ["Timestamp", e.ts],
    ["Method", e.method],
    ["Path", e.path],
    ["Query", e.query || "—"],
    ["Content-Type", m.contentType || "—"],
    ["Body Size", m.contentLength != null ? m.contentLength + " bytes" : "—"],
    ["User-Agent", m.userAgent || "—"],
    ["Client IP", m.ip || "—"],
    ["Country", m.country || "—"],
    ["CF-Ray", m.ray || "—"],
    ["Event ID", e.id],
  ];
  return '<div class="overview-grid">' + rows.map(function (r) {
    return '<div class="k">' + r[0] + '</div><div class="v">' + esc(r[1]) + '</div>';
  }).join("") + '</div>';
}

function doAction(act, e) {
  if (act === "copy-json") {
    copy(JSON.stringify(e, null, 2)); toast("Event JSON copied", "success");
  } else if (act === "copy-curl") {
    copy(buildCurl(e)); toast("cURL command copied", "success");
  } else if (act === "copy-url") {
    copy(location.origin + e.path + (e.query ? "?" + e.query : "")); toast("URL copied", "success");
  } else if (act === "delete") {
    fetch("/api/events/" + encodeURIComponent(e.id), { method: "DELETE" }).then(function () {
      var next = filtered().filter(function (x) { return x.id !== e.id; })[0];
      state.selectedId = null;
      return load(true).then(function () {
        if (next) select(next.id);
        toast("Request deleted", "success");
      });
    }).catch(function () { toast("Delete failed", "error"); });
  }
}

function copy(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text);
  } else {
    var ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand("copy"); ta.remove();
  }
}

// ---------- data ----------

function select(id) {
  state.selectedId = id;
  renderList();
  renderDetail();
}

function load(keepSelection) {
  var prevFirst = state.events.length ? state.events[0].id : null;
  return fetch("/api/events?limit=200")
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data || data.error) {
        toast("Couldn't load events: " + ((data && (data.detail || data.error)) || "load failed"), "error");
        return false;
      }
      state.events = data.events || [];
      if (!keepSelection || (state.selectedId && !state.events.some(function (e) { return e.id === state.selectedId; }))) {
        if (!state.selectedId || !state.events.some(function (e) { return e.id === state.selectedId; })) {
          state.selectedId = state.events.length ? state.events[0].id : null;
        }
      }
      // Skip DOM rebuild when nothing changed, so hover/clicks aren't disturbed.
      var sig = state.events.length + ":" + (state.events[0] ? state.events[0].id : "") +
        ":" + (state.selectedId || "") + ":" + state.q;
      if (sig === state.lastSig) { tickTimes(); return; }
      state.lastSig = sig;
      renderList();
      renderDetail();
      if (!keepSelection && state.events.length && state.events[0].id !== prevFirst) {
        var pane = $("list-pane");
        pane.scrollTop = 0;
      }
      return true;
    })
    .catch(function () { /* dev server restart etc. */ return false; });
}

function setAuto(on) {
  if (state.timer) clearInterval(state.timer);
  // 60s + skip while tab hidden: free KV allows only 1,000 list()/day.
  // Use the Refresh button for instant checks between polls.
  state.timer = on ? setInterval(function () { if (!document.hidden) { load(true); tickTimes(); } }, 60000) : null;
}

// ---------- wiring ----------

$("endpoint-url").textContent = location.host + "/<any-path>";
$("copy-endpoint").addEventListener("click", function () {
  copy(location.origin + "/orbit/webhook");
  toast("Webhook URL copied", "success");
});
$("search").addEventListener("input", function (e) {
  state.q = e.target.value.trim();
  renderList();
});
$("auto").addEventListener("change", function (e) { setAuto(e.target.checked); });
$("refresh").addEventListener("click", function () {
  load(true).then(function (ok) { if (ok) toast("Refreshed", "success"); tickTimes(); });
});
$("clear").addEventListener("click", function () {
  if (!confirm("Delete ALL logged requests?")) return;
  fetch("/api/events", { method: "DELETE" }).then(function () { return load(); })
    .then(function () { toast("All requests cleared", "success"); });
});

document.addEventListener("keydown", function (ev) {
  if (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA") return;
  var evs = filtered();
  if (!evs.length) return;
  var idx = -1;
  for (var i = 0; i < evs.length; i++) if (evs[i].id === state.selectedId) { idx = i; break; }
  if (ev.key === "ArrowDown" || ev.key === "j") {
    ev.preventDefault();
    if (idx < evs.length - 1) select(evs[idx + 1].id);
  } else if (ev.key === "ArrowUp" || ev.key === "k") {
    ev.preventDefault();
    if (idx > 0) select(evs[idx - 1].id);
  } else if (ev.key === "Delete" && state.selectedId) {
    var cur = null;
    for (var j = 0; j < state.events.length; j++) if (state.events[j].id === state.selectedId) { cur = state.events[j]; break; }
    if (cur) doAction("delete", cur);
  }
});

setInterval(tickTimes, 30000);
load();
setAuto(true);
</script>
</body>
</html>`;
}
