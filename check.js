// Monitor grafiku Reform Body Studio (Fitssey) z powiadomieniami na Telegram.
//  - nowe zajęcia w grafiku → powiadomienie (z ciszą nocną 23–7, potem zbiorczo rano)
//  - /obserwuj → wybierasz pełne zajęcia, bot da znać, gdy zwolni się miejsce
// Bez zależności — wymaga Node 18+ (wbudowany fetch).
//
// Zmienne środowiskowe:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  – dane bota (sekrety w GitHubie)
//   DRY_RUN=1                             – nic nie wysyłaj, wypisuj na konsolę
//   FAKE_UPDATES=plik.json                – (test) użyj tych update'ów zamiast getUpdates
//   FAKE_SCHEDULE=plik.json               – (test) użyj tego grafiku zamiast API
//   STATE_FILE                            – ścieżka pliku stanu (domyślnie state.json)

const fs = require("fs");

const API = "https://app.fitssey.com/ReformBodyStudio/api/v4/private/frontoffice/schedule";
const BOOKING_URL = "https://reformbodystudio.pl/grafik/";
const TZ = "Europe/Warsaw";
const DAYS_AHEAD = 90;
const WATCH_LIST_DAYS = 14;  // /obserwuj bez daty pokazuje pełne zajęcia z tylu dni
const MAX_BUTTONS = 60;
const QUIET_FROM = 23; // cisza nocna od 23:00…
const QUIET_TO = 7;    // …do 7:00
const COMMANDS_VERSION = 1;
const STATE_FILE = process.env.STATE_FILE || "state.json";
const DRY_RUN = process.env.DRY_RUN === "1";
const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || "");

const ymd = (d) => d.toLocaleDateString("sv-SE", { timeZone: TZ }); // YYYY-MM-DD
const shortId = (id) => id.slice(0, 16);

// ---------- Fitssey ----------

async function fetchSchedule() {
  let data;
  if (process.env.FAKE_SCHEDULE) {
    data = JSON.parse(fs.readFileSync(process.env.FAKE_SCHEDULE, "utf8"));
  } else {
    const now = new Date();
    const end = new Date(now.getTime() + DAYS_AHEAD * 864e5);
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (schedule-watcher)" },
      body: JSON.stringify({
        category: null, startDate: ymd(now), endDate: ymd(end),
        filters: null, view: "mobileView", loadFilters: false,
      }),
    });
    if (!res.ok) throw new Error(`Fitssey API HTTP ${res.status}`);
    data = await res.json();
  }
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

async function tg(method, body) {
  if (DRY_RUN) {
    console.log(`[DRY_RUN] ${method}: ${JSON.stringify(body, null, 1)}`);
    return { ok: true, result: [] };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !CHAT_ID) throw new Error("Brak TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Telegram ${method} HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function send(text, extra = {}) {
  // Telegram ma limit 4096 znaków na wiadomość — tniemy po liniach.
  const chunks = []; let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line).length > 3900) { chunks.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur.trim()) chunks.push(cur);
  for (const chunk of chunks) {
    await tg("sendMessage", { chat_id: CHAT_ID, text: chunk, disable_web_page_preview: true, ...extra });
  }
}

async function getUpdates(offset) {
  if (process.env.FAKE_UPDATES) return JSON.parse(fs.readFileSync(process.env.FAKE_UPDATES, "utf8"));
  if (DRY_RUN) return [];
  const json = await tg("getUpdates", { offset, timeout: 0, allowed_updates: ["message", "callback_query"] });
  return json.result || [];
}

// ---------- Formatowanie ----------

function fmtWhen(iso, withWeekday = true) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("pl-PL", { timeZone: TZ, ...(withWeekday && { weekday: "short" }), day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("pl-PL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${day} ${time}`;
}

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

// ---------- Stan ----------

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}
const saveState = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");

// ---------- Komendy ----------

const WEEKDAYS = { nd: 0, niedz: 0, pon: 1, wt: 2, sr: 3, "śr": 3, czw: 4, pt: 5, sob: 6 };

// Zwraca YYYY-MM-DD dla argumentu typu "20.11", "20.11.2026", "pt", "jutro", "dzis" — albo null.
function parseDay(arg, now = new Date()) {
  if (!arg) return null;
  const a = arg.toLowerCase().replace(/\.$/, "");
  if (a === "dzis" || a === "dziś") return ymd(now);
  if (a === "jutro") return ymd(new Date(now.getTime() + 864e5));
  const m = a.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
  if (m) {
    const todayY = Number(ymd(now).slice(0, 4));
    let y = m[3] ? Number(m[3].length === 2 ? "20" + m[3] : m[3]) : todayY;
    let date = `${y}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    const check = new Date(date + "T12:00:00Z");
    if (isNaN(check) || check.toISOString().slice(0, 10) !== date) return "invalid";
    if (!m[3] && date < ymd(now)) date = `${y + 1}${date.slice(4)}`; // np. 05.01 w grudniu → przyszły rok
    return date;
  }
  const key = Object.keys(WEEKDAYS).find((k) => a.startsWith(k));
  if (key !== undefined) {
    for (let i = 0; i < 7; i++) {
      const d = new Date(now.getTime() + i * 864e5);
      if (new Date(ymd(d) + "T12:00:00Z").getUTCDay() === WEEKDAYS[key]) return ymd(d);
    }
  }
  return "invalid";
}

const HELP = [
  "Komendy:",
  "/obserwuj — pełne zajęcia z najbliższych 2 tygodni do wyboru",
  "/obserwuj 20.11 (albo: pt, jutro) — pełne zajęcia z danego dnia",
  "/lista — obserwowane zajęcia (z opcją usunięcia)",
  "",
  "Gdy zwolni się miejsce na obserwowanych zajęciach, dostaniesz powiadomienie.",
  "Bot odczytuje komendy co ~5 minut, więc odpowiedź przychodzi z małym opóźnieniem.",
].join("\n");

async function handleCommand(text, events, state, now) {
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/@\w+$/, "");

  if (cmd === "/obserwuj" || cmd === "/watch") {
    const day = parseDay(args[0], new Date(now));
    if (day === "invalid") return send(`Nie rozumiem daty „${args[0]}”. Przykłady: /obserwuj 20.11, /obserwuj pt, /obserwuj jutro`);
    const limit = now + WATCH_LIST_DAYS * 864e5;
    const full = events
      .filter((e) => new Date(e.startsAt).getTime() > now && e.free <= 0 && !state.watches[e.id])
      .filter((e) => (day ? ymd(new Date(e.startsAt)) === day : new Date(e.startsAt).getTime() < limit))
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const when = day ? `na ${fmtWhen(day + "T12:00:00", true).split(" ").slice(0, 2).join(" ")}` : "w najbliższych 2 tygodniach";
    if (!full.length) return send(`Brak pełnych zajęć ${when} — wszędzie są wolne miejsca (albo już je obserwujesz).`);
    const shown = full.slice(0, MAX_BUTTONS);
    const more = full.length > shown.length ? `\n(pokazuję ${shown.length} z ${full.length} — zawęź datą, np. /obserwuj pt)` : "";
    return send(`Pełne zajęcia ${when}. Kliknij, które obserwować:${more}`, {
      reply_markup: { inline_keyboard: shown.map((e) => [{ text: buttonLabel(e), callback_data: `w:${shortId(e.id)}` }]) },
    });
  }

  if (cmd === "/lista" || cmd === "/list") {
    const list = Object.entries(state.watches).sort((a, b) => a[1].startsAt.localeCompare(b[1].startsAt));
    if (!list.length) return send("Nic nie obserwujesz. Użyj /obserwuj.");
    return send(`Obserwowane zajęcia (${list.length}). Kliknij, żeby przestać obserwować:`, {
      reply_markup: { inline_keyboard: list.map(([id, w]) => [{ text: `❌ ${buttonLabel(w)}`, callback_data: `u:${shortId(id)}` }]) },
    });
  }

  if (cmd === "/start" || cmd === "/pomoc" || cmd === "/help") return send(HELP);
}

async function handleCallback(cq, events, state) {
  const [action, sid] = (cq.data || "").split(":");
  let reply;
  if (action === "w") {
    const e = events.find((x) => shortId(x.id) === sid);
    if (!e) reply = "Tych zajęć nie ma już w grafiku.";
    else if (state.watches[e.id]) reply = `Już obserwujesz: ${fmtWhen(e.startsAt)} ${e.name}`;
    else {
      state.watches[e.id] = { startsAt: e.startsAt, name: e.name, trainer: e.trainer, lastFree: e.free };
      reply = e.free > 0
        ? `👀 Obserwuję: ${fmtWhen(e.startsAt)} — ${e.name}. Uwaga: już teraz są wolne miejsca (${e.free})! ${BOOKING_URL}`
        : `👀 Obserwuję: ${fmtWhen(e.startsAt)} — ${e.name}${e.trainer ? ` (${e.trainer})` : ""}. Dam znać, gdy zwolni się miejsce.`;
    }
  } else if (action === "u") {
    const id = Object.keys(state.watches).find((x) => shortId(x) === sid);
    if (!id) reply = "Tych zajęć już nie obserwujesz.";
    else {
      const w = state.watches[id];
      delete state.watches[id];
      reply = `Przestałem obserwować: ${fmtWhen(w.startsAt)} — ${w.name}`;
    }
  }
  // Odpowiedź na kliknięcie może być już przeterminowana (bot czyta co kilka minut) — ignorujemy błąd.
  await tg("answerCallbackQuery", { callback_query_id: cq.id }).catch(() => {});
  if (reply) await send(reply);
}

async function processUpdates(events, state, now) {
  const updates = await getUpdates(state.tgOffset || 0);
  for (const u of updates) {
    state.tgOffset = u.update_id + 1;
    try {
      const msg = u.message;
      const cq = u.callback_query;
      // Reagujemy tylko na nasz czat (grupę) — reszta świata jest ignorowana.
      if (msg?.text?.startsWith("/") && String(msg.chat.id) === CHAT_ID) await handleCommand(msg.text, events, state, now);
      else if (cq && String(cq.message?.chat?.id) === CHAT_ID) await handleCallback(cq, events, state);
    } catch (err) {
      console.error("Błąd obsługi update'u", u.update_id, err);
    }
  }
}

// ---------- Główna logika ----------

async function main() {
  const events = await fetchSchedule();
  const now = Date.now();
  const quiet = isQuiet(warsawHour());
  const prev = loadState();
  const state = prev || {};
  state.seen ??= {};
  state.pending ??= [];
  state.watches ??= {};
  state.tgOffset ??= 0;

  if (state.commandsVersion !== COMMANDS_VERSION) {
    await tg("setMyCommands", { commands: [
      { command: "obserwuj", description: "Obserwuj pełne zajęcia (np. /obserwuj pt)" },
      { command: "lista", description: "Obserwowane zajęcia" },
      { command: "pomoc", description: "Jak to działa" },
    ] }).catch((err) => console.error("setMyCommands:", err.message));
    state.commandsVersion = COMMANDS_VERSION;
  }

  // 1. Komendy i kliknięcia z Telegrama.
  await processUpdates(events, state, now);

  // 2. Nowe zajęcia.
  if (!prev) {
    for (const e of events) state.seen[e.id] = e.startsAt;
    await send(`✅ Monitoring grafiku Reform Body Studio działa.\nZapamiętano ${events.length} zajęć — dam znać, gdy pojawią się nowe.\n\n${HELP}`);
  } else {
    for (const e of events) {
      if (!state.seen[e.id]) { state.seen[e.id] = e.startsAt; state.pending.push(e); }
    }
  }
  for (const [id, startsAt] of Object.entries(state.seen)) {
    if (new Date(startsAt).getTime() < now - 864e5) delete state.seen[id];
  }
  state.pending = state.pending.filter((e) => new Date(e.startsAt).getTime() > now);
  if (state.pending.length && !quiet) {
    const list = [...state.pending].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const head = list.length === 1 ? "🆕 Nowe zajęcia w Reform Body Studio:" : `🆕 Nowe zajęcia w Reform Body Studio (${list.length}):`;
    await send(`${head}\n${list.map(formatEvent).join("\n")}\n\nZapisy: ${BOOKING_URL}`);
    state.pending = [];
  } else if (state.pending.length) {
    console.log(`Cisza nocna — odkładam ${state.pending.length} powiadomień o nowych zajęciach na rano.`);
  }

  // 3. Zwolnione miejsca na obserwowanych zajęciach.
  //    Wysyłamy od razu (miejsca szybko znikają), w nocy jako ciche powiadomienie.
  const byId = new Map(events.map((e) => [e.id, e]));
  for (const [id, w] of Object.entries(state.watches)) {
    const e = byId.get(id);
    if (new Date(w.startsAt).getTime() <= now) { delete state.watches[id]; continue; }
    if (!e) {
      await send(`⚠️ Obserwowane zajęcia zniknęły z grafiku (odwołane?): ${fmtWhen(w.startsAt)} — ${w.name}`);
      delete state.watches[id];
      continue;
    }
    if (e.free > 0 && w.lastFree <= 0) {
      await send(
        `🔔 Zwolniło się miejsce!\n${formatEvent(e)}\n\nZapisy: ${BOOKING_URL}\n(obserwuję dalej — /lista, żeby wyłączyć)`,
        { disable_notification: quiet },
      );
    }
    w.lastFree = e.free;
  }

  // GitHub wyłącza crony w repo bez aktywności przez 60 dni — co ~3 tygodnie odśwież plik stanu.
  if (!state.heartbeat || now - new Date(state.heartbeat).getTime() > 21 * 864e5) {
    state.heartbeat = new Date(now).toISOString();
  }

  saveState(state);
  console.log(`OK: ${events.length} zajęć, ${Object.keys(state.seen).length} zapamiętanych, ` +
    `${state.pending.length} czeka, ${Object.keys(state.watches).length} obserwowanych.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
