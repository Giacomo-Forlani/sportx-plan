# SportX Plan

Spazio di lavoro del team: https://chatgpt.giacomoforlani.com/sportx-plan/

Frontend JavaScript senza framework, API Node.js e PostgreSQL persistente. Non è ancora prevista autenticazione, come richiesto. I dati sono condivisi da tutti i visitatori.

## Comportamento

- Backlog diviso in sezioni, ordinate per creazione. Un unico pulsante aggiunge attività scegliendo la sezione. Attività ordinate per inserimento, eliminabili, con titolo, descrizione, responsabile, priorità e stato.
- Ogni sezione ha solo un codice (es. `DISC`, `ARCH`): il precedente campo `name`, ridondante, viene rimosso con una migrazione idempotente all’avvio. ID, associazioni delle attività e contatori rimangono invariati.
- Ogni sezione ha un contatore atomico: `DISC-01`, `DISC-02`… Gli ID eliminati non vengono riutilizzati. Inserimenti concorrenti non producono duplicati.
- Decisioni con domanda e risposta modificabili nella stessa pagina. Una risposta non vuota colloca la domanda in “Con risposta”. Gli spazi da soli sono una risposta vuota; `?` è invece testo e conta come risposta. Ogni modifica effettiva della risposta sposta la voce in fondo alla sezione corrispondente; una modifica della sola domanda conserva la posizione.
- Documento Markdown modificabile con anteprima HTML sanificata e salvataggio esplicito.
- Aggiornamento automatico ogni cinque secondi. Revisioni ottimistiche impediscono che salvataggi obsoleti sovrascrivano quelli di un collega. Le bozze restano visibili in caso di conflitto; per il documento copiare il testo prima di ricaricare.

## Dati

PostgreSQL è la fonte dei dati operativi. `seed/initial.json` contiene esclusivamente i contenuti iniziali importati dal precedente sito (30 attività, 15 decisioni e documento). Viene letto una sola volta quando il database è vuoto, in una transazione; non sovrascrive mai modifiche successive. Il documento è indipendente da backlog e decisioni, che non vengono rigenerati modificando il testo.

Il precedente localStorage non viene cancellato né importato automaticamente nel database condiviso: eventuali modifiche conservate nei singoli browser vanno recuperate dalla chiave `sportx-plan-tracker-v1.5` e riconciliate prima di importarle.

I dati del DB e i log sono esclusi da Git. Git conserva codice e contenuti iniziali, non i dati operativi futuri. Per un backup usare `pg_dump` verso una posizione privata; conservare il dump separatamente dal volume.

## Deploy su Dokploy

Creare un servizio **Docker Compose** nel progetto Dokploy e collegare questo repository. Impostazioni:

| Campo | Valore |
| --- | --- |
| Repository | `Giacomo-Forlani/sportx-plan` |
| Branch | `main` |
| Tipo | Docker Compose (non Docker Stack) |
| Compose path | `./docker-compose.yml` |
| Build context | Radice del repository, già configurata nel Compose |
| Variabile obbligatoria | `POSTGRES_PASSWORD`, impostata in Environment |
| Servizio del dominio | `app` |
| Porta del container | `8791` |
| Healthcheck | `GET /api/health`, incluso nell'immagine |

1. In **Environment**, aggiungere `POSTGRES_PASSWORD` con una password generata, ad esempio con `openssl rand -hex 32`. `.env.example` elenca le variabili; non contiene credenziali. Il Compose passa esplicitamente la password ai due servizi e blocca il deploy se è vuota.
2. In **Domains**, aggiungere il dominio, selezionare `app`, porta `8791`, e abilitare HTTPS. Per un dominio dedicato usare il percorso `/`; per conservare l'indirizzo attuale usare host `chatgpt.giacomoforlani.com`, percorso `/sportx-plan`, senza rimuovere il prefisso. L'app supporta entrambi i casi e reindirizza `/sportx-plan` a `/sportx-plan/`.
3. Usare **Preview Compose** per controllare il risultato: `app` e `db` devono mantenere la rete `backend`; `app` deve inoltre avere la rete del proxy aggiunta da Dokploy. Non assegnare un dominio al servizio `db`. Non servono porte pubblicate sull'host né un Nginx aggiuntivo.
4. Avviare **Deploy**. PostgreSQL deve risultare healthy prima dell'avvio dell'app; l'healthcheck dell'app verifica anche la connessione al DB. Controllare `https://<dominio>/api/health` (oppure `/sportx-plan/api/health`), poi aprire il sito.

Dokploy gestisce etichette Traefik e rete del proxy tramite la configurazione Domains: [documentazione domini](https://docs.dokploy.com/docs/core/docker-compose/domains). Variabili e volumi seguono la [documentazione Docker Compose](https://docs.dokploy.com/docs/core/docker-compose).

### Persistenza e dati esistenti

Il volume Docker `postgres-data` conserva il database tra restart e redeploy dello stesso servizio. Mantenere invariati il progetto Compose e il volume; non usare `down -v` per aggiornare il sito. Cambiare `POSTGRES_PASSWORD` nell'ambiente non cambia la password di un database già inizializzato: una rotazione richiede anche l'aggiornamento del ruolo PostgreSQL.

**Un primo deploy su Dokploy crea un nuovo database con i dati iniziali del repository. Non trasferisce automaticamente i dati del sito attuale.** Per portarli sul nuovo server, eseguire un dump consistente prima del passaggio del dominio, conservarlo fuori dal repository e ripristinarlo nel database Dokploy con l'app ferma. Durante il trasferimento finale sospendere le scritture sul sito di origine.

Dal workspace attuale, salvare il dump in una cartella privata:

```sh
umask 077
PGHOST=/workspace/Website/sportx-plan/services/postgres/socket \
PGPORT=5544 PGUSER=codex \
pg_dump --format=custom --no-owner --no-acl --dbname=sportx_plan \
  --file=/percorso/privato/sportx-plan.dump
```

Sul server Dokploy, nella directory del checkout del servizio, usare il **nome progetto Compose effettivo mostrato da Dokploy** (non eseguire questi comandi nel container dell'app):

```sh
# Impostare DOKPLOY_COMPOSE_PROJECT con il nome del progetto esistente.
# Il database di destinazione deve essere nuovo e destinato alla migrazione.
docker compose -p "$DOKPLOY_COMPOSE_PROJECT" -f docker-compose.yml stop app
docker compose -p "$DOKPLOY_COMPOSE_PROJECT" -f docker-compose.yml exec -T db \
  pg_restore -U sportx -d sportx_plan --clean --if-exists \
  --no-owner --no-acl --exit-on-error --single-transaction \
  < /percorso/privato/sportx-plan.dump
docker compose -p "$DOKPLOY_COMPOSE_PROJECT" -f docker-compose.yml start app
```

Il restore sostituisce i contenuti del DB di destinazione; eseguirlo solo sul nuovo servizio predisposto per ricevere i dati. Verificare attività, decisioni e documento prima di spostare il traffico. Il seed non sovrascrive un database ripristinato. Usare `pg_dump` anche per i backup periodici dei dati operativi, separati dal volume.

## Avvio locale con Docker Compose

Copiare `.env.example` in `.env` e compilare `POSTGRES_PASSWORD`, quindi:

```sh
docker compose -f docker-compose.yml -f compose.local.yaml up -d --build
```

Aprire `http://127.0.0.1:8791/` oppure `http://127.0.0.1:8791/sportx-plan/`. L'override locale pubblica la porta solo su loopback; non va selezionato in Dokploy. `SPORTX_PORT` permette di cambiare la porta locale se è già occupata.

Per validare la configurazione prima del deploy:

```sh
docker compose -f docker-compose.yml config --quiet
```

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

Le verifiche coprono seed idempotente, numerazione concorrente, cancellazione senza riuso, conflitti, ordine delle decisioni, persistenza al riavvio dell'app, sanificazione Markdown e due sessioni browser con layout mobile. Il Compose è predisposto per Dokploy; il sito attuale usa ancora il servizio nativo del workspace. La preparazione del repository non esegue un deploy o una migrazione su Dokploy.

## MCP remoto (agenti su altri computer)

L'app fornisce un endpoint **Streamable HTTP** sul dominio esistente:

- `https://sportx.giacomoforlani.com/mcp` (dominio dedicato)
- `https://<dominio>/sportx-plan/mcp` (installazione con prefisso)

Il server serve le revisioni MCP `2026-07-28` (stateless) e `2025-11-25` (compatibilità). Espone strumenti per leggere lo stato, elencare e creare sezioni, elencare/creare/aggiornare/eliminare attività, elencare/creare/aggiornare decisioni e leggere/aggiornare il documento Markdown. Gli strumenti riutilizzano le API applicative e le revisioni ottimistiche: un aggiornamento con revisione obsoleta fallisce e va ripetuto dopo aver riletto la voce. La cancellazione di un'attività richiede `confirm: true`.

**Abilitazione:** generare un segreto casuale, ad esempio `openssl rand -hex 32`, e impostarlo come variabile privata `SPORTX_MCP_TOKEN` nell'ambiente di Dokploy del servizio Compose, quindi ridistribuire il servizio. Il Compose inoltra il segreto solo al container `app`, mai al database. Se la variabile manca o contiene meno di 32 byte, l'endpoint restituisce HTTP 503 senza offrire strumenti. Le chiamate senza token restituiscono HTTP 401. Non mettere il token in Git, nel frontend, nei log o in URL; usa HTTPS e trasmettilo tramite `Authorization: Bearer <TOKEN>`.

In un client MCP remoto che supporta intestazioni HTTP personalizzate, configurare l'URL e l'header Bearer. Esempio schematico (sostituire il segnaposto con un riferimento sicuro al segreto):

```json
{
  "mcpServers": {
    "sportx": {
      "type": "http",
      "url": "https://sportx.giacomoforlani.com/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN_DA_GESTORE_SEGRETI>"
      }
    }
  }
}
```

Per **Codex CLI** su ciascun computer, impostare il token come variabile d'ambiente locale e configurare `~/.codex/config.toml`:

```toml
[mcp_servers.sportx]
url = "https://sportx.giacomoforlani.com/mcp"
bearer_token_env_var = "SPORTX_MCP_TOKEN"
```

Il valore di `SPORTX_MCP_TOKEN` sul computer client deve coincidere con quello impostato nel servizio Dokploy. Non scrivere il valore del segreto nel TOML; va caricato dall'ambiente o da un gestore di segreti.

Per i client che non consentono header Bearer configurabili occorre aggiungere un'autenticazione OAuth appropriata: l'endpoint attuale **non** implementa un authorization server OAuth. L'MCP utilizza connessioni HTTPS dirette al dominio, senza porte Docker extra e senza connessioni dirette a PostgreSQL. I client HTTP con `Origin` differente dall'host sono rifiutati; le richieste da agenti desktop non devono impostare un'origine web.

**Limite importante:** l'autenticazione di questo endpoint protegge solo l'MCP. Le normali API e la dashboard web restano, per scelta progettuale preesistente, prive di login. **Non considerare il sito nel suo complesso protetto**: per dati riservati o uso multiutente va introdotta l'autenticazione delle API web con ruoli e autorizzazioni prima di un'esposizione non controllata.

Test MCP isolati (nessun database richiesto): `node --test tests/mcp.test.js`. Test integrati delle API: `npm test` con un DB separato `_test` come descritto sopra.
