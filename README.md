# FantaFormazione – dati automatici

Ogni mattina GitHub scarica i dati di Serie A da BSD – Bzzoiro Sports Data (calcio gratuito), calcola titolarità, fantamedie stimate, rigoristi, infortuni e gol attesi dalle quote, e pubblica il file `docs/data.json`. L'app scarica quel file. Nei pomeriggi, ogni ora, controlla se sono uscite le formazioni ufficiali delle partite in arrivo.

Costo: zero. BSD non ha limiti di richieste per il calcio; lo script ne fa circa 70 al giorno (di più solo la prima volta, per recuperare la stagione).

## Attivazione (una volta sola, circa 15 minuti, meglio dal Mac)

1. **Chiave BSD**
   Registrati su sports.bzzoiro.com/register (gratis, senza carta) e copia la tua chiave.

2. **Repository GitHub**
   Su github.com crea un repository **pubblico** chiamato `fantaformazione-dati` e caricaci tutti i file di questa cartella, mantenendo le sottocartelle (`.github/workflows`, `scripts`, `docs`).
   Deve essere pubblico perché GitHub Pages gratis funziona solo così; la chiave resta comunque segreta.

3. **Chiave nel repository**
   *Settings → Secrets and variables → Actions → New repository secret*
   Nome: `BSD_API_KEY` · Valore: la chiave del punto 1.

4. **Permessi di scrittura**
   *Settings → Actions → General → Workflow permissions* → scegli **Read and write permissions** → Save.

5. **Pubblicazione del file**
   *Settings → Pages* → Source: **Deploy from a branch** → Branch: `main`, cartella `/docs` → Save.
   L'indirizzo sarà `https://TUONOME.github.io/fantaformazione-dati/data.json`.

6. **Primo avvio**
   Tab *Actions* → *Aggiorna dati* → **Run workflow**. Dopo un paio di minuti deve diventare verde.

7. **Nell'app**
   *Impostazioni → Dati automatici* → incolla l'indirizzo del punto 5 → **Aggiorna ora**.

## Da sapere

- Voti e fantamedie sono **stime** calcolate dal rating per partita di BSD e dalle statistiche (gol, assist, cartellini, rigori, gol subiti), non i voti ufficiali dei giornali.
- La titolarità viene da stagione e ultime 5 partite, poi da infortuni e squalifiche; quando escono le formazioni ufficiali comandano quelle.
- I ruoli sono quelli di BSD (portiere, difensore, centrocampista, attaccante) e a volte non coincidono con quelli del fantacalcio.
- Se una corsa diventa rossa, apri il dettaglio: di solito è la chiave sbagliata o il limite giornaliero raggiunto. Il giorno dopo riparte da sola.
- Prima di pubblicare l'app sugli store, rileggi la licenza dei dati BSD (sports.bzzoiro.com/docs/api-license): consente di pubblicare valori calcolati, non i dati grezzi.
