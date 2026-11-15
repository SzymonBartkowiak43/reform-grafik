# Reform Body Studio: powiadomienia o zajęciach

Bot na Telegramie (@FitnesiaraBot) działający na Cloudflare Workers, w darmowym planie.

- **Nowe zajęcia:** co minutę bot pobiera grafik z Fitssey (system za
  https://reformbodystudio.pl/grafik/) na 90 dni do przodu. Gdy pojawią się nowe zajęcia,
  pisze do grupy. Między 23:00 a 7:00 jest cisza nocna, a nocne nowości przychodzą zbiorczo o 7:00.
- **Zwolnione miejsca:** obserwujesz pełne zajęcia, a bot da znać, gdy zwolni się miejsce.
  Te powiadomienia idą od razu, w nocy bez dźwięku.

## Komendy (w grupie)
| Komenda | Co robi |
|---|---|
| `/obserwuj` | pełne zajęcia z najbliższych 2 tygodni jako przyciski |
| `/obserwuj 20.11` / `pt` / `jutro` | pełne zajęcia z danego dnia |
| `/obserwuj 18.11 16:30` | od razu obserwuje konkretne zajęcia |
| `/lista` | obserwowane zajęcia; kliknięcie ❌ wyłącza obserwowanie |
| `/pomoc` | lista komend |

Bot odpowiada od razu (webhook Telegrama) i reaguje tylko na czat z `TELEGRAM_CHAT_ID`.

## Jak to jest zbudowane
- `src/worker.js`: cały bot. `scheduled()` to cron co minutę, `fetch()` obsługuje webhook Telegrama.
- `schema.sql`: tabele w bazie D1 (`seen`, `pending`, `watches`, `meta`).
- `wrangler.toml`: konfiguracja (cron, ID czatu, baza D1).
- Sekrety w Cloudflare: `TELEGRAM_BOT_TOKEN` i `WEBHOOK_SECRET`.

Endpointy pomocnicze (wymagają `?key=<WEBHOOK_SECRET>`):
- `/setup`: rejestruje webhook i listę komend w Telegramie (po zmianie tokenu albo adresu).
- `/check`: ręczne sprawdzenie grafiku.

## Wdrażanie zmian
```bash
npx wrangler@4 deploy
```

Logi na żywo:
```bash
npx wrangler@4 tail
```

## Zmiana czatu albo tokenu
- Inna grupa: zmień `TELEGRAM_CHAT_ID` w `wrangler.toml` i zrób `deploy`.
- Nowy token (np. po `/revoke` w BotFatherze): `npx wrangler@4 secret put TELEGRAM_BOT_TOKEN`,
  potem otwórz `/setup?key=...`.

## Test lokalny
Plik `.dev.vars` z `DRY_RUN=1`, `WEBHOOK_SECRET=testkey` i `TELEGRAM_BOT_TOKEN=dummy`, potem:
```bash
npx wrangler@4 d1 execute reform-grafik --local --file schema.sql
npx wrangler@4 dev --local
```
Z `DRY_RUN=1` wiadomości do Telegrama są tylko wypisywane w konsoli.
