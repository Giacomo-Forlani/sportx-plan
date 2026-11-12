# SportX Plan

Spazio di lavoro del team: https://chatgpt.giacomoforlani.com/sportx-plan/

Frontend JavaScript senza framework, API Node.js e PostgreSQL persistente. Non è ancora prevista autenticazione, come richiesto. I dati sono condivisi da tutti i visitatori.

## Comportamento

- Backlog diviso in sezioni, ordinate per creazione. Un unico pulsante aggiunge attività scegliendo la sezione. Attività ordinate per inserimento, eliminabili, con titolo, descrizione, responsabile, priorità e stato.
- Ogni sezione ha un contatore atomico: `DISC-01`, `DISC-02`… Gli ID eliminati non vengono riutilizzati. Inserimenti concorrenti non producono duplicati.
- Decisioni con domanda e risposta modificabili nella stessa pagina. Una risposta non vuota colloca la domanda in “Con risposta”. Gli spazi da soli sono una risposta vuota; `?` è invece testo e conta come risposta. Ogni modifica effettiva della risposta sposta la voce in fondo alla sezione corrispondente; una modifica della sola domanda conserva la posizione.
- Documento Markdown modificabile con anteprima HTML sanificata e salvataggio esplicito.
- Aggiornamento automatico ogni cinque secondi. Revisioni ottimistiche impediscono che salvataggi obsoleti sovrascrivano quelli di un collega. Le bozze restano visibili in caso di conflitto; per il documento copiare il testo prima di ricaricare.

## Dati

PostgreSQL è la fonte dei dati operativi. `seed/initial.json` contiene esclusivamente i contenuti iniziali importati dal precedente sito (30 attività, 15 decisioni e documento). Viene letto una sola volta quando il database è vuoto, in una transazione; non sovrascrive mai modifiche successive. Il documento è indipendente da backlog e decisioni, che non vengono rigenerati modificando il testo.

Il precedente localStorage non viene cancellato né importato automaticamente nel database condiviso: eventuali modifiche conservate nei singoli browser vanno recuperate dalla chiave `sportx-plan-tracker-v1.5` e riconciliate prima di importarle.

I dati del DB e i log sono esclusi da Git. Git conserva codice e contenuti iniziali, non i dati operativi futuri. Per un backup usare `pg_dump` verso una posizione privata; conservare il dump separatamente dal volume.

## Avvio con Docker Compose

Impostare `POSTGRES_PASSWORD` nell'ambiente oppure in un `.env` locale ignorato da Git, quindi:

```sh
docker compose up -d --build
```

Aprire `http://127.0.0.1:8791/sportx-plan/`. Il database usa il volume persistente `postgres-data`; non eseguire `docker compose down -v` se si vogliono conservare i dati. L'app è esposta solo su loopback per l'uso dietro un reverse proxy. Per questa modalità instradare tutto `/sportx-plan/` all'app; il processo Node serve anche gli asset.

In alternativa, usare Node 24 e PostgreSQL 15 o successivo:

```sh
npm ci
# Impostare DATABASE_URL oppure PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.
npm start
```

## Deployment nel workspace corrente

Sorgenti: `/workspace/Website/sportx-plan`. Il servizio dedicato vive in `services/`, con dati in `services/postgres/data` sul volume persistente. PostgreSQL è raggiungibile solo tramite socket Unix privato con autenticazione peer, senza porta TCP. L'API ascolta su `127.0.0.1:8791`.

`services/startup.d/sportx-plan.sh` è scoperto all'avvio del container. Un lock impedisce avvii duplicati; il processo riavvia l'API se termina. Per l'avvio immediato eseguire lo script in un processo supervisionato o in una sessione indipendente. `PG_BIN` può selezionare una diversa installazione PostgreSQL.

Per pubblicare il frontend e configurare Nginx:

```sh
python3 build.py
cp services/nginx.conf /workspace/Website/nginx-sites/sportx-plan.conf
sudo nginx -t
sudo nginx -s reload
```

Un aggiornamento delle API richiede il riavvio del servizio; lo schema e i dati vengono conservati. La build copia solo asset e rimuove i vecchi documenti statici pubblici; non modifica PostgreSQL. Il dominio e TLS sono gestiti dal reverse proxy già esistente.

## Verifiche

I test distruggono e ricreano lo schema **solo** in un database dedicato il cui nome termina con `_test`. Non impostare il database operativo.

```sh
node --check src/app.js
node --check services/server.js
PGDATABASE=sportx_plan_test npm test
PGDATABASE=sportx_plan_test npm run test:browser
git diff --check
```

Impostare anche i parametri PostgreSQL necessari. Nel workspace: `PGHOST=/workspace/Website/sportx-plan/services/postgres/socket PGPORT=5544 PGUSER=codex`. I test browser accettano `PUPPETEER_MODULE` e `CHROME_BIN`; i valori predefiniti usano gli strumenti già installati nel workspace.

Le verifiche coprono seed idempotente, numerazione concorrente, cancellazione senza riuso, conflitti, ordine delle decisioni, persistenza al riavvio dell'app, sanificazione Markdown e due sessioni browser con layout mobile. Il Compose è fornito per portabilità; la pubblicazione corrente usa il servizio nativo del workspace.
