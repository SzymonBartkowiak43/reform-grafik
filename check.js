// Sprawdza grafik Reform Body Studio (Fitssey) i wysyła na Telegram info o nowych zajęciach.
// Bez zależności — wymaga Node 18+ (wbudowany fetch).
//
// Zmienne środowiskowe:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  – dane bota (sekrety w GitHubie)
//   DRY_RUN=1                             – nie wysyłaj, tylko wypisz wiadomość
//   STATE_FILE                            – ścieżka pliku stanu (domyślnie state.json)

const fs = require("fs");

const API = "https://app.fitssey.com/ReformBodyStudio/api/v4/private/frontoffice/schedule";
const BOOKING_URL = "https://reformbodystudio.pl/grafik/";
const TZ = "Europe/Warsaw";
const DAYS_AHEAD = 90;
const QUIET_FROM = 23; // cisza nocna od 23:00…
const QUIET_TO = 7;    // …do 7:00
const STATE_FILE = process.env.STATE_FILE || "state.json";
const DRY_RUN = process.env.DRY_RUN === "1";

const ymd = (d) => d.toLocaleDateString("sv-SE", { timeZone: TZ }); // YYYY-MM-DD

async function fetchSchedule() {
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
  const data = await res.json();
  if (!Array.isArray(data.schedule)) throw new Error("Nieoczekiwany format odpowiedzi API");
  return data.schedule
    .flatMap((day) => day.scheduleEvents || [])
    .filter((e) => !e.isCancelled && !e.isHidden)
    .map((e) => ({
      id: e.referenceId,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      name: e.qualifiedName || e.scheduleMeta?.classService?.name || "Zajęcia",
      trainer: (e.member?.qualifiedName || "").replace(/\s*\.\.$/, ""),
      free: e.remainCapacity,
      total: e.totalCapacity,
    }));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return null; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function warsawHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));
}
const isQuiet = (h) => (QUIET_FROM > QUIET_TO ? h >= QUIET_FROM || h < QUIET_TO : h >= QUIET_FROM && h < QUIET_TO);

function formatEvent(e) {
  const d = new Date(e.startsAt);
  const day = d.toLocaleDateString("pl-PL", { timeZone: TZ, weekday: "short", day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("pl-PL", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const spots = e.free >= 0 && e.total ? ` · wolne ${e.free}/${e.total}` : "";
  const who = e.trainer ? ` (${e.trainer})` : "";
  return `• ${day} ${time} — ${e.name}${who}${spots}`;
}

async function sendTelegram(text) {
  if (DRY_RUN) { console.log("---- [DRY_RUN] wiadomość ----\n" + text + "\n-----------------------------"); return; }
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("Brak TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID");
  // Telegram ma limit 4096 znaków na wiadomość — tniemy po liniach.
  const chunks = []; let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + line).length > 3900) { chunks.push(cur); cur = ""; }
    cur += line + "\n";
  }
  if (cur.trim()) chunks.push(cur);
  for (const chunk of chunks) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: chunk, disable_web_page_preview: true }),
    });
    if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  }
}

async function main() {
  const events = await fetchSchedule();
  const now = Date.now();
  const prev = loadState();
  const state = prev || { seen: {}, pending: [], heartbeat: null };

  // Pierwsze uruchomienie: zapamiętaj obecny grafik bez spamowania.
  if (!prev) {
    for (const e of events) state.seen[e.id] = e.startsAt;
    await sendTelegram(`✅ Monitoring grafiku Reform Body Studio działa.\nZapamiętano ${events.length} zajęć — dam znać, gdy pojawią się nowe.`);
  } else {
    for (const e of events) {
      if (!state.seen[e.id]) {
        state.seen[e.id] = e.startsAt;
        state.pending.push(e);
      }
    }
  }

  // Sprzątanie: zapomnij zajęcia, które już minęły.
  for (const [id, startsAt] of Object.entries(state.seen)) {
    if (new Date(startsAt).getTime() < now - 864e5) delete state.seen[id];
  }
  // Nie wysyłaj zaległych powiadomień o zajęciach, które już się zaczęły.
  state.pending = state.pending.filter((e) => new Date(e.startsAt).getTime() > now);

  const hour = warsawHour();
  if (state.pending.length && !isQuiet(hour)) {
    const list = [...state.pending].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    const head = list.length === 1 ? "🆕 Nowe zajęcia w Reform Body Studio:" : `🆕 Nowe zajęcia w Reform Body Studio (${list.length}):`;
    await sendTelegram(`${head}\n${list.map(formatEvent).join("\n")}\n\nZapisy: ${BOOKING_URL}`);
    state.pending = [];
  } else if (state.pending.length) {
    console.log(`Cisza nocna (${hour}:00) — odkładam ${state.pending.length} powiadomień na rano.`);
  }

  // GitHub wyłącza crony w repo bez aktywności przez 60 dni — co ~3 tygodnie odśwież plik stanu.
  if (!state.heartbeat || now - new Date(state.heartbeat).getTime() > 21 * 864e5) {
    state.heartbeat = new Date(now).toISOString();
  }

  saveState(state);
  console.log(`OK: ${events.length} zajęć w grafiku, ${Object.keys(state.seen).length} zapamiętanych, ${state.pending.length} czeka na wysłanie.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
