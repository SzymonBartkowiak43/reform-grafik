# Reform Body Studio: powiadomienia o nowych zajęciach

Co 5 minut GitHub Actions pobiera grafik z Fitssey (system, na którym działa
https://reformbodystudio.pl/grafik/) na 90 dni do przodu. Jeśli pojawią się nowe zajęcia,
dostajesz wiadomość na Telegramie. Między 23:00 a 7:00 jest cisza nocna: powiadomienia
z nocy przychodzą zbiorczo o 7:00.

## Obserwowanie pełnych zajęć
- `/obserwuj` pokazuje pełne zajęcia z najbliższych 2 tygodni jako przyciski.
- `/obserwuj 20.11`, `/obserwuj pt` albo `/obserwuj jutro` pokazuje pełne zajęcia z danego dnia.
- Klikasz zajęcia, a gdy zwolni się na nich miejsce, przychodzi 🔔 powiadomienie.
  Te powiadomienia idą od razu, także w nocy, bo miejsca szybko znikają. W nocy są tylko wyciszone.
- `/lista` pokazuje obserwowane zajęcia, a kliknięcie wyłącza obserwowanie.

Bot odczytuje komendy przy każdym uruchomieniu, czyli co ~5 minut, więc odpowiedzi przychodzą
z kilkuminutowym opóźnieniem. Reaguje tylko na czat ustawiony w `TELEGRAM_CHAT_ID`.

## Konfiguracja (ok. 10 minut)

### 1. Bot na Telegramie
1. W Telegramie otwórz **@BotFather**, wyślij `/newbot`, podaj nazwę i login bota.
   Skopiuj **token** (wygląda tak: `123456:ABC-...`).
2. Otwórz rozmowę ze swoim nowym botem i wyślij mu dowolną wiadomość, np. `hej`.
3. W przeglądarce wejdź na `https://api.telegram.org/bot<TOKEN>/getUpdates`
   (wstaw swój token). Znajdź `"chat":{"id": 123456789` i skopiuj tę liczbę, to **chat ID**.

### 2. Repozytorium na GitHubie
1. Utwórz nowe repo, np. `reform-grafik`. Polecam **publiczne**, bo wtedy minuty Actions są
   bez limitu. W prywatnym darmowy limit to 2000 min/mies., a sprawdzanie co 20 minut zużywa
   ok. 2160 min, więc tam zmień cron na `*/30`. W repo nie ma żadnych danych osobowych:
   token i chat ID trzymasz w sekretach, nie w kodzie.
2. Wrzuć do repo pliki `check.js`, `README.md` i `.github/workflows/check.yml`.
3. **Settings → Secrets and variables → Actions → New repository secret**, dodaj:
   - `TELEGRAM_BOT_TOKEN`: token od BotFathera
   - `TELEGRAM_CHAT_ID`: liczba z kroku 1.3
4. **Actions → „Sprawdź grafik” → Run workflow**, żeby uruchomić od razu.
   Powinieneś dostać wiadomość „✅ Monitoring grafiku Reform Body Studio działa”.
   Od tej chwili workflow uruchamia się sam co 20 minut.

## Jak to działa
- `state.json` (tworzony automatycznie) przechowuje ID zajęć, które już widziałeś.
  Workflow commituje go z powrotem do repo.
- Pierwsze uruchomienie tylko zapamiętuje obecny grafik i nie wysyła listy wszystkich zajęć.
- Odwołane i ukryte zajęcia są pomijane. Zajęcia, które już minęły, są usuwane ze stanu.
- Jeśli API Fitssey przestanie odpowiadać, workflow zakończy się błędem, a GitHub wyśle
  Ci maila o nieudanym uruchomieniu.

## Test lokalny
```bash
DRY_RUN=1 STATE_FILE=test-state.json node check.js
```
