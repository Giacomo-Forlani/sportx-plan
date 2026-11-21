# SportX Plan

Spazio di lavoro del team: https://sportx.giacomoforlani.com/

Frontend JavaScript senza framework, API Node.js e PostgreSQL persistente. Il dominio SportX è protetto da Cloudflare Access. Backlog, decisioni e documento sono condivisi.

## Comportamento

La dashboard supporta automaticamente **tema chiaro e scuro**, senza preferenze salvate nel browser. Il CSS utilizza la palette scura come base (fallback per browser privi del media feature) e applica quella chiara quando il browser segnala `prefers-color-scheme: light`. La visualizzazione segue in tempo reale i cambiamenti del sistema, anche per sidebar, tabelle, moduli, dialog e anteprima Markdown. **Limite del browser:** Chromium e altri browser possono segnalare `light` anche quando il sistema non esprime una preferenza (`no-preference`); il sito non può distinguere quel caso da una preferenza chiara effettiva. Il fallback scuro è quindi garantito quando il rilevamento non è supportato, non quando il browser segnala comunque `light`. L'implementazione è interamente CSS: non usa cookie, localStorage o API nuove.

- Backlog diviso in sezioni, ordinate per creazione. Un unico pulsante aggiunge attività scegliendo la sezione. Attività ordinate per inserimento, eliminabili, con titolo, descrizione, responsabile, priorità e stato.
- Ogni sezione ha solo un codice (es. `DISC`, `ARCH`): il precedente campo `name`, ridondante, viene rimosso con una migrazione idempotente all’avvio. Una sezione può essere eliminata **solo se vuota**, previa conferma. Per sezioni con attività, eliminare prima le singole attività: nessuna cancellazione a cascata. Le revisioni impediscono di cancellare sezioni modificate da un collega. ID, associazioni delle attività e contatori esistenti rimangono invariati.
- Ogni sezione ha un contatore atomico: `DISC-01`, `DISC-02`… Gli ID eliminati non vengono riutilizzati, **anche se la sezione viene eliminata e ricreata con lo stesso codice**: i contatori rimangono registrati separatamente. Inserimenti concorrenti e cancellazioni di sezione sono serializzati.
- Decisioni con domanda e risposta modificabili nella stessa pagina, **eliminabili con conferma e controllo della revisione**. Una risposta non vuota colloca la domanda in “Con risposta”. Gli spazi da soli sono una risposta vuota; `?` è invece testo e conta come risposta. Ogni modifica effettiva della risposta sposta la voce in fondo alla sezione corrispondente; una modifica della sola domanda conserva la posizione.
- La pagina Documento si apre direttamente in **anteprima Markdown** sanificata, aggiornata automaticamente quando i colleghi salvano nuove versioni. Le tabelle mantengono colonne leggibili senza spezzare gli identificativi e dispongono di scorrimento orizzontale dedicato, accessibile anche da tastiera; titoli, elenchi, citazioni e codice hanno una tipografia coerente in tema chiaro e scuro. **Modifica testo** apre l'editor e il Markdown viene salvato **automaticamente 600 ms dopo l'ultima modifica**, senza pulsante Salva. I salvataggi sono serializzati per non sovrascrivere digitazioni successive; quando si torna all'anteprima o si lascia la pagina, il sito tenta di salvare subito. Lo stato (modifiche in corso, salvataggio, salvato o errore) è sempre visibile. In caso di perdita di connessione, riprova automaticamente; in caso di conflitto di revisione, interrompe i salvataggi per non sovrascrivere un collega e chiede di copiare il testo locale prima di ricaricare.
- Aggiornamento automatico ogni cinque secondi. Revisioni ottimistiche impediscono che salvataggi obsoleti sovrascrivano quelli di un collega. Le bozze restano visibili in caso di conflitto; per il documento copiare il testo prima di ricaricare.

## Conversazioni tra sviluppatori e agenti

La pagina **Conversazioni** mostra tutti i thread a chi ha accesso alla dashboard tramite Cloudflare Access. La pagina è divisa in sezioni per sviluppatore. Ogni thread prende il titolo dall’oggetto del primo messaggio. Nei messaggi si vedono mittente, destinatario, data e testo.

- Ogni thread mostra il numero di messaggi da leggere per lo sviluppatore della sezione, anche quando è zero. Le risposte in attesa hanno un indicatore separato. Aprire un thread è una consultazione. Per inviare, rispondere o aggiornare la lettura, seleziona il mittente nel relativo modulo.
- Imposta `SPORTX_CONVERSATION_TEAM` nell’ambiente dell’app in Dokploy o nel file locale `.env` per Docker Compose. È una lista di nomi separati da virgole, nell’ordine delle sezioni. Le sezioni configurate sono visibili anche se vuote. All’avvio i profili mancanti vengono creati con il nome della sezione, così sono subito disponibili come mittenti e destinatari. I profili già registrati vengono abbinati al nome di battesimo o al prefisso del loro identificativo. I thread senza partecipanti del team restano consultabili in **Archivio**.
- Via MCP tutti usano il token condiviso già previsto per l'accesso al server. **Non configurare variabili, header d'identità o identificativi dello sviluppatore sul computer dell'agente.** Se l'agente non conosce il nome della persona con cui sta lavorando, deve chiederglielo nella chat: «Con quale sviluppatore sto lavorando su SportX?».
- Dopo la risposta, l'agente chiama `sportx_list_developers` per trovare l'identificativo del profilo; se il nome non è registrato, usa `sportx_register_developer` con il nome ricevuto. Passa poi l'ID nel parametro `developer` di **ogni** tool Conversazioni. L'ID resta soltanto nel contesto della chat in corso, senza variabili d'ambiente né file di configurazione. Alla prossima chat l'agente può chiedere nuovamente, se non sa chi sta operando.
- Il server salva i profili in PostgreSQL per associare i messaggi alle caselle. Il nome non verifica l'identità della persona: chi ha accesso all'MCP può dichiarare un qualsiasi profilo registrato. Anche nella dashboard la selezione del mittente non viene più conservata tra i caricamenti della pagina.

Dopo aver identificato lo sviluppatore, al primo utilizzo delle conversazioni l'agente chiama `sportx_list_conversations` con `developer: "<ID>"` e `unread_only: true`. Usa `sportx_read_conversation` per aprire un thread e `sportx_mark_conversation_read` per aggiornare la lettura fino all'ID effettivamente letto. Per inviare una domanda o un avviso, usa `sportx_send_message` con `developer` e l'ID del destinatario, restituito dall'elenco. Le risposte usano `sportx_reply_conversation`.

Per concordare un contratto, scambiate messaggi fino a trovare un accordo e scrivete il riepilogo nello stesso thread. **Solo lo sviluppatore apre la pull request, quando la sua implementazione è pronta.** Può collegare il thread nella descrizione della PR.

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

## Deployment legacy nel workspace (archivio operativo)

Questa sezione descrive la precedente modalità di hosting nel container di lavoro, non la distribuzione primaria attuale su Dokploy.\n\nSorgenti legacy: `/workspace/Website/sportx-plan`. Il servizio dedicato vive in `services/`, con dati in `services/postgres/data` sul volume persistente. PostgreSQL è raggiungibile solo tramite socket Unix privato con autenticazione peer, senza porta TCP. L'API ascolta su `127.0.0.1:8791`.

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

Il server serve le revisioni MCP `2026-07-28` (stateless) e `2025-11-25` (compatibilità). Espone strumenti per leggere lo stato, elencare/creare/**eliminare sezioni vuote**, elencare/creare/aggiornare/eliminare attività, elencare/creare/aggiornare/**eliminare decisioni** e leggere/aggiornare il documento Markdown. Gli strumenti riutilizzano le API applicative e le revisioni ottimistiche: un aggiornamento con revisione obsoleta fallisce e va ripetuto dopo aver riletto la voce. La cancellazione di un'attività, di una sezione vuota o di una decisione richiede `confirm: true`; tutte le eliminazioni includono la revisione corrente.

**Abilitazione:** generare un segreto casuale, ad esempio `openssl rand -hex 32`, e impostarlo come variabile privata `SPORTX_MCP_TOKEN` nell'ambiente di Dokploy del servizio Compose, quindi ridistribuire il servizio. Il Compose inoltra il segreto solo al container `app`, mai al database. Se la variabile manca o contiene meno di 32 byte, l'endpoint restituisce HTTP 503 senza offrire strumenti. Le chiamate senza token restituiscono HTTP 401. Non mettere il token in Git, nel frontend, nei log o in URL; usa HTTPS e trasmettilo tramite `Authorization: Bearer <TOKEN>`.

### Codex GUI (app desktop) — configurazione permanente

**Metodo consigliato per un computer personale:** configurazione globale del server in `~/.codex/config.toml`. Non utilizzare `export`, che in genere non viene ereditato dalle applicazioni GUI avviate separatamente dal terminale.

1. Aprire Codex nell'app desktop. In **Settings > MCP servers > Add server** scegliere **Streamable HTTP**, nome `sportx`, URL `https://sportx.giacomoforlani.com/mcp`, poi salvare. Se si preferisce, creare direttamente la configurazione nel file indicato al punto seguente.
2. Aprire il file globale `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`). Se esiste già `[mcp_servers.sportx]`, **modificare quella sezione** senza duplicarla; altrimenti aggiungerla.
3. Configurare l'header Bearer con `http_headers`, sostituendo **solo** `INCOLLA_QUI_IL_TOKEN` con il valore completo di `SPORTX_MCP_TOKEN` impostato su Dokploy:

```toml
[mcp_servers.sportx]
url = "https://sportx.giacomoforlani.com/mcp"
http_headers = { Authorization = "Bearer INCOLLA_QUI_IL_TOKEN" }
```

4. Salvare il file, usare **Restart** dalla schermata MCP o riavviare completamente Codex e verificare che `sportx` risulti connesso e mostri gli strumenti disponibili. Verificare con una **lettura non distruttiva**, ad esempio chiedendo di elencare le sezioni SportX.

`http_headers` invia il valore letterale su ogni richiesta e rimane salvato tra i riavvii; **non** va impostato `bearer_token_env_var` contemporaneamente per lo stesso header. Lo spazio dopo `Bearer` è obbligatorio. Il metodo salva il token **in chiaro sul computer**, quindi proteggere `config.toml` con i permessi del proprio utente, non condividerlo e non copiarlo nella repository.

**Alternativa se si usa già un gestore di segreti o una variabile di ambiente permanente visibile alla GUI:** sostituire `http_headers` con `bearer_token_env_var = "SPORTX_MCP_TOKEN"` nello stesso blocco e configurare la variabile nell'ambiente del processo Codex. Un semplice `export` in un terminale non basta per un'app desktop avviata altrove. La variabile contiene il token vero; il TOML contiene **solo il nome** della variabile.

Documentazione ufficiale: [OpenAI – Collegare Codex a MCP](https://learn.chatgpt.com/docs/extend/mcp) e [OpenAI – Riferimento config.toml](https://learn.chatgpt.com/docs/config-file/config-reference).

### Claude Desktop (Chat/Cowork) — connettore remoto persistente

Per Claude nella **GUI Chat/Desktop**, usare un **Custom connector Web**, non `claude_desktop_config.json` e non un bridge `npx`, perché SportX è un server remoto HTTPS:

1. Aprire **Customize > Connectors** (o la sezione Connectors in Claude Desktop), poi **Add > Custom > Web** / **Add custom connector**; la dicitura varia leggermente tra le versioni.
2. Impostare nome `SportX` e URL `https://sportx.giacomoforlani.com/mcp`; proseguire.
3. Alla voce **Authentication** selezionare **No sign-in**: il server SportX attuale **non supporta OAuth**, ma richiede una credenziale fissa tramite header.
4. Se disponibile, aprire **Request headers** e aggiungere un header **Required**:
   - Nome: `Authorization` (o `authorization`)
   - Valore **completo**: `Bearer INCOLLA_QUI_IL_TOKEN`
   Sostituire il segnaposto con lo stesso token di Dokploy; Claude **non** aggiunge automaticamente il prefisso `Bearer `.
5. Salvare con **Add**. In chat abilitare **SportX** dal menu `+` > **Connectors**, quindi provare una richiesta di sola lettura, ad esempio «Elenca le sezioni SportX». Il connettore rimane configurato nell'account Claude anche dopo il riavvio; può essere necessario riabilitarlo in singole conversazioni.

**Disponibilità:** secondo la documentazione Anthropic, **Request headers** è in **beta** e può non essere disponibile in tutti gli account/organizzazioni. Se il campo non appare, **Claude Chat/Cowork non può collegarsi direttamente a questa implementazione SportX con sola autenticazione Bearer**. Non scegliere «Sign in now» sperando che funzioni: richiederebbe l'aggiunta di un vero authorization server OAuth a SportX. Le connessioni Claude remote partono dall'infrastruttura cloud Anthropic, quindi il dominio deve essere pubblicamente raggiungibile su HTTPS porta 443.

**Claude Desktop, scheda Code (Claude Code):** i connettori legati al proprio account Claude sono utilizzabili anche nelle sessioni Code compatibili. Se **Request headers** non è disponibile ma serve esclusivamente la scheda Code, si può in alternativa configurare **una sola volta** Claude Code, con installazione locale e token persistente:

```bash
claude mcp add --transport http --scope user sportx https://sportx.giacomoforlani.com/mcp --header "Authorization: Bearer INCOLLA_QUI_IL_TOKEN"
```

Il comando aggiunge la connessione all'ambito utente (`~/.claude.json`) e la rende disponibile alle sessioni **Claude Code**, inclusa la scheda Code desktop; **non** è un metodo per abilitarla nella chat Claude Desktop. Sostituire il segnaposto con il token e considerare che il comando e la configurazione possono esporlo in chiaro nella cronologia shell e nei file locali. Verificare dalla scheda Code o con `claude mcp list`. Non inserire la configurazione con token in `.mcp.json` della repository.

Fonti ufficiali: [Anthropic – Aggiungere un connettore personalizzato](https://claude.com/docs/connectors/custom/add-unlisted), [Anthropic – Connettori MCP remoti](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Anthropic – Claude Code Desktop](https://code.claude.com/docs/en/desktop) e [Anthropic – Configurazione MCP Claude Code](https://code.claude.com/docs/en/mcp).

### Verifica e protezione del token

- Il token configurato sui client deve essere **identico** a `SPORTX_MCP_TOKEN` nell'ambiente Dokploy del servizio `app`. Se viene rigenerato, aggiornare Dokploy **e tutti i client**, poi ridistribuire il servizio.
- La chiave **non va mai** inserita in Git, negli URL, negli esempi condivisi o nei log. L'esempio `INCOLLA_QUI_IL_TOKEN` non è una chiave reale.
- In caso di errore **401** verificare header, prefisso `Bearer ` e corrispondenza del token; **503** indica che il token non è configurato correttamente lato server; **404** suggerisce un URL/deploy errato.
- Queste istruzioni riguardano la **configurazione dei client**. Il funzionamento esterno end-to-end va verificato dopo il deploy su Dokploy; il merge Git da solo non prova che l'endpoint sia attivo.

L'MCP utilizza connessioni HTTPS dirette al dominio, senza porte Docker extra e senza connessioni dirette a PostgreSQL. I client HTTP con `Origin` differente dall'host sono rifiutati; le richieste da agenti desktop non devono impostare un'origine web.

**Limite importante:** l'autenticazione di questo endpoint protegge solo l'MCP. Le normali API e la dashboard web restano, per scelta progettuale preesistente, prive di login. **Non considerare il sito nel suo complesso protetto**: per dati riservati o uso multiutente va introdotta l'autenticazione delle API web con ruoli e autorizzazioni prima di un'esposizione non controllata.

Test MCP isolati (nessun database richiesto): `node --test tests/mcp.test.js`. Test integrati delle API: `npm test` con un DB separato `_test` come descritto sopra.
