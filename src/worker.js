// Reform Body Studio — monitor grafiku (Fitssey) + bot Telegram na Cloudflare Workers.
//
//  - cron co 5 min: nowe zajęcia w grafiku (cisza nocna 23–7) i zwolnione miejsca na obserwowanych
//  - webhook Telegrama: komendy /obserwuj, /lista, /pomoc i przyciski — odpowiedź natychmiast
//
// Bindingi (wrangler.toml / sekrety):
//   DB                   – baza D1
//   TELEGRAM_BOT_TOKEN   – sekret
//   WEBHOOK_SECRET       – sekret (weryfikacja webhooka + klucz do /setup)
//   TELEGRAM_CHAT_ID     – zmienna (czat/grupa, z którą bot rozmawia)

const API = "https://app.fitssey.com/ReformBodyStudio/api/v4/private/frontoffice/schedule";
const BOOKING_URL = "https://reformbodystudio.pl/grafik/";
const TZ = "Europe/Warsaw";
const DAYS_AHEAD = 90;
const WATCH_LIST_DAYS = 14;
const MAX_BUTTONS = 60;
const QUIET_FROM = 23;
const QUIET_TO = 7;
const DAY = 864e5;

const ymd = (d) => d.toLocaleDateString("sv-SE", { timeZone: TZ });
const shortId = (id) => id.slice(0, 16);

// ---------- Fitssey ----------

async function fetchSchedule() {
  const now = new Date();
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (schedule-watcher)" },
    body: JSON.stringify({
      category: null, startDate: ymd(now), endDate: ymd(new Date(now.getTime() + DAYS_AHEAD * DAY)),
      filters: null, view: "mobileView", loadFilters: false,
    }),
  });
  if (!res.ok) throw new Error(`Fitssey API HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.schedule)) throw new Error("Nieoczekiwany format odpowiedzi API");
  return data.schedule
    .flatMap((day) => day.scheduleEvents || [])
    .filter((e) => !e.isCancelled && !e.isHidden)
    .map((e) => ({
      id: e.referenceId,
      startsAt: e.startsAt,
      name: e.qualifiedName || e.scheduleMeta?.classService?.name || "Zajęcia",
      trainer: (e.member?.qualifiedName || "").replace(/\s*\.\.$/, ""),
      free: e.remainCapacity,
      total: e.totalCapacity,
    }));
}

// ---------- Telegram ----------

function telegram(env) {
  async function call(method, body) {
    if (env.DRY_RUN === "1") { console.log(`[DRY_RUN] ${method} ${JSON.stringify(body)}`); return { ok: true }; }
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(`Telegram ${method} HTTP ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }
  async function send(text, extra = {}) {
    const chunks = []; let cur = "";
    for (const line of text.split("\n")) {
      if ((cur + line).length > 3900) { chunks.push(cur); cur = ""; }
      cur += line + "\n";
    }
    if (cur.trim()) chunks.push(cur);
    for (const chunk of chunks) {
      await call("sendMessage", { chat_id: env.TELEGRAM_CHAT_ID, text: chunk, disable_web_page_preview: true, ...extra });
    }
  }
  return { call, send };
}

// ---------- Formatowanie ----------

function fmtWhen(iso) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("pl-PL", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
  return `${day} ${timeOf(iso)}`;
}
const timeOf = (iso) => new Date(iso).toLocaleTimeString("pl-PL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

function formatEvent(e) {
  const spots = e.free >= 0 && e.total ? ` · wolne ${e.free}/${e.total}` : "";
  const who = e.trainer ? ` (${e.trainer})` : "";
  return `• ${fmtWhen(e.startsAt)} — ${e.name}${who}${spots}`;
}
const buttonLabel = (e) => `${fmtWhen(e.startsAt)} ${e.name}`.slice(0, 60);

function warsawHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
}
const isQuiet = (h) => (QUIET_FROM > QUIET_TO ? h >= QUIET_FROM || h < QUIET_TO : h >= QUIET_FROM && h < QUIET_TO);

// ---------- Baza (D1) ----------

const db = (env) => ({
  async meta(k) { return (await env.DB.prepare("SELECT v FROM meta WHERE k = ?").bind(k).first())?.v ?? null; },
  setMeta(k, v) { return env.DB.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, String(v)).run(); },
  async seenIds() { return new Set((await env.DB.prepare("SELECT id FROM seen").all()).results.map((r) => r.id)); },
  async pending() { return (await env.DB.prepare("SELECT json FROM pending").all()).results.map((r) => JSON.parse(r.json)); },
  async watches() { return (await env.DB.prepare("SELECT * FROM watches ORDER BY starts_at").all()).results; },
  async watch(id) { return env.DB.prepare("SELECT * FROM watches WHERE id = ?").bind(id).first(); },
  addWatch(e) {
    return env.DB.prepare("INSERT OR IGNORE INTO watches (id, starts_at, name, trainer, last_free) VALUES (?, ?, ?, ?, ?)")
      .bind(e.id, e.startsAt, e.name, e.trainer, e.free).run();
  },
  removeWatch(id) { return env.DB.prepare("DELETE FROM watches WHERE id = ?").bind(id).run(); },
});

// ---------- Komendy ----------

const WEEKDAYS = { nd: 0, niedz: 0, pon: 1, wt: 2, sr: 3, "śr": 3, czw: 4, pt: 5, sob: 6 };

function parseDay(arg, now = new Date()) {
  if (!arg) return null;
  const a = arg.toLowerCase().replace(/\.$/, "");
  if (a === "dzis" || a === "dziś") return ymd(now);
  if (a === "jutro") return ymd(new Date(now.getTime() + DAY));
  const m = a.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
  if (m) {
    const y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : Number(ymd(now).slice(0, 4));
    let date = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const check = new Date(date + "T12:00:00Z");
    if (isNaN(check) || check.toISOString().slice(0, 10) !== date) return "invalid";
    if (!m[3] && date < ymd(now)) date = `${y + 1}${date.slice(4)}`;
    return date;
  }
  const key = Object.keys(WEEKDAYS).find((k) => a.startsWith(k));
  if (key !== undefined) {
    for (let i = 0; i < 7; i++) {
      const d = ymd(new Date(now.getTime() + i * DAY));
      if (new Date(d + "T12:00:00Z").getUTCDay() === WEEKDAYS[key]) return d;
    }
  }
  return "invalid";
}

function parseTime(arg) {
  const m = (arg || "").match(/^(\d{1,2})(?:[:.]?(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2] || 0) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2] || "00"}`;
}

const HELP = [
  "Komendy:",
  "/obserwuj — pełne zajęcia z najbliższych 2 tygodni do wyboru",
  "/obserwuj 20.11 (albo: pt, jutro) — pełne zajęcia z danego dnia",
  "/obserwuj 18.11 16:30 — od razu obserwuj konkretne zajęcia",
  "/lista — obserwowane zajęcia (z opcją usunięcia)",
  "",
  "Gdy zwolni się miejsce na obserwowanych zajęciach, dostaniesz powiadomienie.",
].join("\n");

async function addWatch(e, store) {
  if (await store.watch(e.id)) return `Już obserwujesz: ${fmtWhen(e.startsAt)} — ${e.name}`;
  await store.addWatch(e);
  const who = e.trainer ? ` (${e.trainer})` : "";
  return e.free > 0
    ? `👀 Obserwuję: ${fmtWhen(e.startsAt)} — ${e.name}${who}. Uwaga: już teraz są wolne miejsca (${e.free})! ${BOOKING_URL}`
    : `👀 Obserwuję: ${fmtWhen(e.startsAt)} — ${e.name}${who}. Dam znać, gdy zwolni się miejsce.`;
}

async function handleCommand(text, env) {
  const tg = telegram(env), store = db(env);
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@\w+$/, "");
  const now = Date.now();

  if (cmd === "/obserwuj" || cmd === "/watch") {
    const day = parseDay(args[0], new Date(now));
    if (day === "invalid") return tg.send(`Nie rozumiem daty „${args[0]}”. Przykłady: /obserwuj 20.11, /obserwuj pt, /obserwuj 18.11 16:30`);
    const events = await fetchSchedule();
    const upcoming = events.filter((e) => new Date(e.startsAt).getTime() > now);

    if (day && args[1]) {
      const time = parseTime(args[1]);
      if (!time) return tg.send(`Nie rozumiem godziny „${args[1]}”. Przykład: /obserwuj 18.11 16:30`);
      const sameDay = upcoming.filter((e) => ymd(new Date(e.startsAt)) === day).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      const hits = sameDay.filter((e) => timeOf(e.startsAt) === time);
      if (hits.length === 1) return tg.send(await addWatch(hits[0], store));
      if (hits.length > 1) {
        return tg.send(`O ${time} jest kilka zajęć — kliknij, które obserwować:`, {
          reply_markup: { inline_keyboard: hits.map((e) => [{ text: buttonLabel(e), callback_data: `w:${shortId(e.id)}` }]) },
        });
      }
      const label = `${day.slice(8, 10)}.${day.slice(5, 7)}`;
      if (!sameDay.length) return tg.send(`Brak (nadchodzących) zajęć ${label}.`);
      return tg.send(`Brak zajęć ${label} o ${time}. Tego dnia są:\n${sameDay.map(formatEvent).join("\n")}`);
    }

    const watched = new Set((await store.watches()).map((w) => w.id));
    const full = upcoming
      .filter((e) => e.free <= 0 && !watched.has(e.id))
      .filter((e) => (day ? ymd(new Date(e.startsAt)) === day : new Date(e.startsAt).getTime() < now + WATCH_LIST_DAYS * DAY))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const when = day ? `na ${day.slice(8, 10)}.${day.slice(5, 7)}` : "w najbliższych 2 tygodniach";
    if (!full.length) return tg.send(`Brak pełnych zajęć ${when} — wszędzie są wolne miejsca (albo już je obserwujesz).`);
    const shown = full.slice(0, MAX_BUTTONS);
    const more = full.length > shown.length ? `\n(pokazuję ${shown.length} z ${full.length} — zawęź datą, np. /obserwuj pt)` : "";
    return tg.send(`Pełne zajęcia ${when}. Kliknij, które obserwować:${more}`, {
      reply_markup: { inline_keyboard: shown.map((e) => [{ text: buttonLabel(e), callback_data: `w:${shortId(e.id)}` }]) },
    });
  }

  if (cmd === "/lista" || cmd === "/list") {
    const list = (await store.watches()).filter((w) => new Date(w.starts_at).getTime() > now);
    if (!list.length) return tg.send("Nic nie obserwujesz. Użyj /obserwuj.");
    return tg.send(`Obserwowane zajęcia (${list.length}). Kliknij, żeby przestać obserwować:`, {
      reply_markup: { inline_keyboard: list.map((w) => [{ text: `❌ ${buttonLabel({ startsAt: w.starts_at, name: w.name })}`, callback_data: `u:${shortId(w.id)}` }]) },
    });
  }

  if (cmd === "/start" || cmd === "/pomoc" || cmd === "/help") return tg.send(HELP);
}

async function handleCallback(cq, env) {
  const tg = telegram(env), store = db(env);
  const [action, sid] = (cq.data || "").split(":");
  let reply;
  if (action === "w") {
    const e = (await fetchSchedule()).find((x) => shortId(x.id) === sid);
    reply = e ? await addWatch(e, store) : "Tych zajęć nie ma już w grafiku.";
  } else if (action === "u") {
    const w = (await store.watches()).find((x) => shortId(x.id) === sid);
    if (!w) reply = "Tych zajęć już nie obserwujesz.";
    else { await store.removeWatch(w.id); reply = `Przestałem obserwować: ${fmtWhen(w.starts_at)} — ${w.name}`; }
  }
  await tg.call("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  if (reply) await tg.send(reply);
}

async function handleUpdate(u, env) {
  const chat = String(env.TELEGRAM_CHAT_ID);
  if (u.message?.text?.startsWith("/") && String(u.message.chat.id) === chat) return handleCommand(u.message.text, env);
  if (u.callback_query && String(u.callback_query.message?.chat?.id) === chat) return handleCallback(u.callback_query, env);
  if (u.callback_query) {
    await telegram(env).call("answerCallbackQuery", { callback_query_id: u.callback_query.id }).catch(() => {});
  }
}

// ---------- Cron: sprawdzanie grafiku ----------

async function checkSchedule(env) {
  const tg = telegram(env), store = db(env);
  const events = await fetchSchedule();
  const now = Date.now();
  const quiet = isQuiet(warsawHour());

  // Nowe zajęcia.
  if (!(await store.meta("initialized"))) {
    await env.DB.batch(events.map((e) => env.DB.prepare("INSERT OR IGNORE INTO seen (id, starts_at) VALUES (?, ?)").bind(e.id, e.startsAt)));
    await store.setMeta("initialized", new Date(now).toISOString());
    await tg.send(`✅ Monitoring grafiku Reform Body Studio działa.\nZapamiętano ${events.length} zajęć — dam znać, gdy pojawią się nowe.\n\n${HELP}`);
  } else {
    const seen = await store.seenIds();
    const fresh = events.filter((e) => !seen.has(e.id));
    if (fresh.length) {
      await env.DB.batch(fresh.flatMap((e) => [
        env.DB.prepare("INSERT OR IGNORE INTO seen (id, starts_at) VALUES (?, ?)").bind(e.id, e.startsAt),
        env.DB.prepare("INSERT OR IGNORE INTO pending (id, json) VALUES (?, ?)").bind(e.id, JSON.stringify(e)),
      ]));
    }
  }
  const cutoff = new Date(now - DAY).toISOString();
  await env.DB.prepare("DELETE FROM seen WHERE starts_at < ?").bind(cutoff).run();

  const pending = (await store.pending()).filter((e) => new Date(e.startsAt).getTime() > now);
  if (pending.length && !quiet) {
    pending.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const head = pending.length === 1 ? "🆕 Nowe zajęcia w Reform Body Studio:" : `🆕 Nowe zajęcia w Reform Body Studio (${pending.length}):`;
    await tg.send(`${head}\n${pending.map(formatEvent).join("\n")}\n\nZapisy: ${BOOKING_URL}`);
    await env.DB.prepare("DELETE FROM pending").run();
  } else if (!pending.length) {
    await env.DB.prepare("DELETE FROM pending").run(); // sprząta przeterminowane
  }

  // Zwolnione miejsca.
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const w of await store.watches()) {
    if (new Date(w.starts_at).getTime() <= now) { await store.removeWatch(w.id); continue; }
    const e = byId.get(w.id);
    if (!e) {
      await tg.send(`⚠️ Obserwowane zajęcia zniknęły z grafiku (odwołane?): ${fmtWhen(w.starts_at)} — ${w.name}`);
      await store.removeWatch(w.id);
      continue;
    }
    if (e.free > 0 && w.last_free <= 0) {
      await tg.send(`🔔 Zwolniło się miejsce!\n${formatEvent(e)}\n\nZapisy: ${BOOKING_URL}\n(obserwuję dalej — /lista, żeby wyłączyć)`, { disable_notification: quiet });
    }
    if (e.free !== w.last_free) await env.DB.prepare("UPDATE watches SET last_free = ? WHERE id = ?").bind(e.free, w.id).run();
  }

  await store.setMeta("lastCheck", new Date(now).toISOString());
  return { events: events.length, pending: quiet ? pending.length : 0 };
}

// ---------- Wejścia ----------

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkSchedule(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Webhook Telegrama.
    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env).catch((err) => console.error("update", err)));
      return new Response("ok");
    }

    // Jednorazowa konfiguracja: rejestruje webhook i komendy. Wymaga klucza.
    if (url.pathname === "/setup" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      const tg = telegram(env);
      const hook = await tg.call("setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      });
      await tg.call("setMyCommands", { commands: [
        { command: "obserwuj", description: "Obserwuj zajęcia, np. /obserwuj 18.11 16:30" },
        { command: "lista", description: "Obserwowane zajęcia" },
        { command: "pomoc", description: "Jak to działa" },
      ] });
      return Response.json({ webhook: hook, commands: "ok" });
    }

    // Ręczne sprawdzenie (do testów).
    if (url.pathname === "/check" && url.searchParams.get("key") === env.WEBHOOK_SECRET) {
      return Response.json(await checkSchedule(env));
    }

    return new Response("Reform Body Studio watcher", { status: 200 });
  },
};
