// Stateless MCP Streamable HTTP endpoint for the SportX planning dashboard.
// No additional dependency: tools reuse the exact same API validations and
// optimistic revisions used by the browser.
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

class ToolInputError extends Error {}

const identity = { name: "sportx-plan", version: "1.0.0" };
const modern = "2026-07-28";
const legacy = "2025-11-25";
const str = (maxLength) => ({ type: "string", maxLength });
const pos = { type: "integer", minimum: 1 };
const props = {
  section_id: pos,
  decision_id: pos,
  id: str(80),
  revision: pos,
  code: str(16),
  title: str(180),
  description: str(20000),
  owner: str(120),
  status: { type: "string", enum: ["Da fare", "In corso", "In verifica", "Bloccato", "Completato"] },
  priority: { type: "string", enum: ["P0", "P1", "P2"] },
  question: str(10000),
  answer: str(20000),
  markdown: str(1000000),
  answered: { type: "boolean" },
  thread_id: str(36),
  name: str(120),
  developer: str(64),
  recipient: str(64),
  subject: str(180),
  reference: str(300),
  message: str(20000),
  unread_only: { type: "boolean" },
  through_id: str(19),
  last_message_id: str(19),
  confirm: { type: "boolean", const: true },
};
function tool(name, description, fields = [], required = [], write = false, destructive = false) {
  return {
    name: "sportx_" + name,
    description,
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(fields.map((f) => [f, props[f]])),
      required,
      additionalProperties: false,
    },
    annotations: {
      readOnlyHint: !write,
      destructiveHint: destructive,
      idempotentHint: !write,
      openWorldHint: false,
    },
  };
}
export const mcpTools = [
  tool("get_state", "Leggi lo stato completo: sezioni, attività, decisioni e documento."),
  tool("list_sections", "Elenca le sezioni del backlog."),
  tool("create_section", "Crea una sezione con codice univoco.", ["code"], ["code"], true),
  tool("delete_section", "Elimina definitivamente una sezione vuota: se contiene attività, l’operazione viene rifiutata. Richiede revisione e conferma.", ["section_id", "revision", "confirm"], ["section_id", "revision", "confirm"], true, true),
  tool("list_tasks", "Elenca le attività, con filtro facoltativo per sezione e stato.", ["section_id", "status"]),
  tool("create_task", "Crea un'attività nella sezione indicata; l'ID è assegnato dal server.", ["section_id", "title", "description", "owner", "status", "priority"], ["section_id", "title"], true),
  tool("update_task", "Aggiorna un'attività con revisione ottimistica. Passa section_id per spostarla senza cambiare ID.", ["id", "revision", "title", "description", "owner", "status", "priority", "section_id"], ["id", "revision", "title", "description", "owner", "status", "priority"], true),
  tool("delete_task", "Elimina un'attività solo dopo conferma esplicita e verifica della revisione.", ["id", "revision", "confirm"], ["id", "revision", "confirm"], true, true),
  tool("list_decisions", "Elenca decisioni e domande, con filtro facoltativo per risposta presente.", ["answered"]),
  tool("create_decision", "Crea una decisione (domanda e risposta facoltativa).", ["question", "answer"], ["question"], true),
  tool("update_decision", "Modifica domanda e risposta conservando il controllo delle revisioni.", ["id", "revision", "question", "answer"], ["id", "revision", "question", "answer"], true),
  tool("delete_decision", "Elimina definitivamente una decisione, solo con revisione corrente e conferma esplicita.", ["decision_id", "revision", "confirm"], ["decision_id", "revision", "confirm"], true, true),
  tool("read_document", "Leggi il documento Markdown condiviso e la sua revisione."),
  tool("update_document", "Sostituisci il documento Markdown solo se la revisione corrisponde.", ["revision", "markdown"], ["revision", "markdown"], true, true),
];

const inboxTools = [
  tool("list_developers", "Elenca i profili degli sviluppatori con i relativi ID. Prima di usare una casella, chiedi il nome alla persona se non è noto nella chat e cerca qui il profilo corrispondente."),
  tool("register_developer", "Registra un nuovo nome sviluppatore solo dopo averlo chiesto alla persona e aver verificato che non esista già. Restituisce il suo ID, senza configurazioni o variabili d'ambiente.", ["name"], ["name"], true),
  tool("list_conversations", "Controlla la casella dello sviluppatore indicato, elenca i destinatari e i thread. Usa unread_only per filtrare i messaggi nuovi.", ["developer", "unread_only"], ["developer"]),
  tool("send_message", "Avvia una conversazione a nome di developer con il destinatario indicato dal suo ID. Collega l'attività o la decisione pertinente in reference.", ["developer", "recipient", "subject", "message", "reference"], ["developer", "recipient", "subject", "message"], true),
  tool("read_conversation", "Leggi i messaggi della conversazione per developer.", ["developer", "thread_id"], ["developer", "thread_id"]),
  tool("reply_conversation", "Rispondi a nome di developer nella conversazione esistente.", ["developer", "thread_id", "message"], ["developer", "thread_id", "message"], true),
  tool("mark_conversation_read", "Segna come letti per developer i messaggi fino all'ID effettivamente letto, dopo averli riportati o presi in carico.", ["developer", "thread_id", "through_id"], ["developer", "thread_id", "through_id"], true),
  tool("delete_conversation", "Elimina il thread come partecipante dopo conferma esplicita. Leggi il thread e passa l’ID corrente dell’ultimo messaggio: i nuovi messaggi bloccano l’eliminazione.", ["developer", "thread_id", "last_message_id", "confirm"], ["developer", "thread_id", "last_message_id", "confirm"], true, true),
];
const inboxInstructions = "Quando usi le conversazioni SportX, se non conosci già il nome dello sviluppatore in questa chat, chiediglielo direttamente prima di leggere o inviare messaggi; non indovinarlo. Poi usa sportx_list_developers per trovare il suo ID; se il profilo non esiste, registralo con sportx_register_developer usando il nome comunicato. Passa quell'ID nel parametro developer di OGNI tool Conversazioni per tutta la chat. Non richiedere né memorizzare SPORTX_DEVELOPER, header di identità, impostazioni locali o variabili persistenti. Dopo l'identificazione controlla i messaggi non letti con sportx_list_conversations. Per concordare un contratto, scambia messaggi e scrivi l’accordo raggiunto nello stesso thread. Solo lo sviluppatore apre una PR, quando la sua implementazione è pronta.";
const instructions = "Usa i tool SportX per gestire dati condivisi. Prima di modificare una voce leggi la revisione corrente.";

function send(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}
function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function constantTimeTokenEquals(expected, actual) {
  if (typeof actual !== "string" || !actual.startsWith("Bearer ")) return false;
  const supplied = actual.slice(7);
  // Hash first so the comparison never leaks the length of the expected token.
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
}
async function readMessage(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > 1100000) {
      const e = new Error("Messaggio troppo grande.");
      e.status = 413;
      throw e;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((x) => Buffer.from(x))).toString("utf8"));
  } catch {
    const e = new Error("JSON non valido.");
    e.status = 400;
    throw e;
  }
}
function inputObject(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ToolInputError("Argomenti non validi.");
  return value;
}
function identifier(value, type) {
  if (type === "task") {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(value))
      throw new ToolInputError("ID attività non valido.");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 1) throw new ToolInputError("ID non valido.");
  return String(value);
}
function conversationId(id) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    throw new ToolInputError("ID conversazione non valido.");
  return id;
}
function requireRevision(a) {
  if (!Number.isSafeInteger(a.revision) || a.revision < 1) throw new ToolInputError("Revisione non valida.");
}
function validateArguments(def, args) {
  const schema = def.inputSchema;
  for (const key of schema.required) if (!(key in args)) throw new ToolInputError("Campo richiesto: " + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new ToolInputError("Campo sconosciuto: " + key);
    if (rule.type === "string" && (typeof value !== "string" || value.length > rule.maxLength))
      throw new ToolInputError("Campo non valido: " + key);
    if (rule.type === "integer" && (!Number.isSafeInteger(value) || value < rule.minimum))
      throw new ToolInputError("Campo non valido: " + key);
    if (rule.type === "boolean" && typeof value !== "boolean")
      throw new ToolInputError("Campo non valido: " + key);
    if (rule.enum && !rule.enum.includes(value)) throw new ToolInputError("Campo non valido: " + key);
    if (rule.const !== undefined && value !== rule.const) throw new ToolInputError("Conferma esplicita richiesta.");
  }
}
async function runTool(name, args, callApi) {
  const def = mcpTools.find((x) => x.name === name) ?? inboxTools.find((x) => x.name === name);
  if (!def) throw new ToolInputError("Strumento sconosciuto: " + name);
  validateArguments(def, args);
  const needsDeveloper = inboxTools.some((entry) => entry.name === name)
    && !["sportx_register_developer", "sportx_list_developers"].includes(name);
  const developer = needsDeveloper ? args.developer : undefined;
  async function call(method, path, data) {
    const request = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
    request.method = method;
    request.headers = developer ? { "x-sportx-developer": developer } : {};
    return callApi(request, path);
  }
  const state = () => call("GET", "/state");
  switch (name) {
    case "sportx_get_state": return state();
    case "sportx_list_sections": return (await state()).sections;
    case "sportx_create_section": return call("POST", "/sections", { code: args.code });
    case "sportx_delete_section":
      requireRevision(args);
      return call("DELETE", "/sections/" + args.section_id, { revision: args.revision });
    case "sportx_list_tasks": {
      let tasks = (await state()).tasks;
      if (args.section_id !== undefined) tasks = tasks.filter((x) => Number(x.section_id) === args.section_id);
      if (args.status !== undefined) tasks = tasks.filter((x) => x.status === args.status);
      return tasks;
    }
    case "sportx_create_task":
      return call("POST", "/tasks", {
        section_id: args.section_id, title: args.title, description: args.description ?? "",
        owner: args.owner ?? "", status: args.status ?? "Da fare", priority: args.priority ?? "P1",
      });
    case "sportx_update_task":
      identifier(args.id, "task"); requireRevision(args);
      return call("PATCH", "/tasks/" + args.id, args);
    case "sportx_delete_task":
      identifier(args.id, "task"); requireRevision(args);
      return call("DELETE", "/tasks/" + args.id, { revision: args.revision });
    case "sportx_list_decisions": {
      let decisions = (await state()).decisions;
      if (args.answered !== undefined) decisions = decisions.filter((x) => Boolean(x.answer.trim()) === args.answered);
      return decisions;
    }
    case "sportx_create_decision":
      return call("POST", "/decisions", { question: args.question, answer: args.answer ?? "" });
    case "sportx_update_decision":
      identifier(args.id, "numeric"); requireRevision(args);
      return call("PATCH", "/decisions/" + args.id, args);
    case "sportx_delete_decision":
      requireRevision(args);
      return call("DELETE", "/decisions/" + args.decision_id, { revision: args.revision });
    case "sportx_read_document": return (await state()).document;
    case "sportx_update_document":
      requireRevision(args);
      return call("PUT", "/document", { revision: args.revision, markdown: args.markdown });
    case "sportx_list_developers":
      return call("GET", "/conversations/developers");
    case "sportx_register_developer":
      return call("POST", "/conversations/developers", { name: args.name });
    case "sportx_list_conversations": {
      const inbox = await call("GET", "/conversations");
      if (args.unread_only) inbox.threads = inbox.threads.filter(({ unread }) => unread);
      return inbox;
    }
    case "sportx_send_message":
      return call("POST", "/conversations", args);
    case "sportx_read_conversation":
      return call("GET", "/conversations/" + conversationId(args.thread_id));
    case "sportx_reply_conversation":
      return call("POST", "/conversations/" + conversationId(args.thread_id) + "/replies", { message: args.message });
    case "sportx_mark_conversation_read":
      return call("POST", "/conversations/" + conversationId(args.thread_id) + "/read", { through_id: args.through_id });
    case "sportx_delete_conversation":
      return call("DELETE", "/conversations/" + conversationId(args.thread_id),
        { last_message_id: args.last_message_id, confirm: args.confirm });
    default: throw new ToolInputError("Strumento sconosciuto.");
  }
}
function toolResult(data, failed = false) {
  if (failed) return { content: [{ type: "text", text: String(data) }], isError: true };
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data } : {}),
  };
}
function decorate(result, isModern) {
  return isModern
    ? { ...result, resultType: "complete", _meta: { "io.modelcontextprotocol/serverInfo": identity, "io.modelcontextprotocol/protocolVersion": modern } }
    : result;
}
export async function handleMcp(req, res, callApi) {
  const secret = process.env.SPORTX_MCP_TOKEN;
  if (!secret || Buffer.byteLength(secret) < 32) {
    send(res, 503, { error: "MCP non configurato." });
    return;
  }
  if (!constantTimeTokenEquals(secret, req.headers.authorization)) {
    send(res, 401, { error: "Token MCP richiesto." }, { "WWW-Authenticate": 'Bearer realm="sportx-mcp"' });
    return;
  }
  if (req.headers.origin) {
    try {
      const origin = new URL(req.headers.origin);
      if (!["http:", "https:"].includes(origin.protocol) || origin.host !== req.headers.host)
        throw new ToolInputError();
    } catch {
      send(res, 403, { error: "Origine non consentita." });
      return;
    }
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "Usa POST per MCP Streamable HTTP." }, { Allow: "POST" });
    return;
  }
  if (!req.headers["content-type"]?.startsWith("application/json")) {
    send(res, 415, { error: "Usa application/json." });
    return;
  }
  let msg;
  try { msg = await readMessage(req); }
  catch (e) { send(res, e.status || 400, { error: e.message }); return; }
  if (!msg || Array.isArray(msg) || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    send(res, 400, err(null, -32600, "Richiesta JSON-RPC non valida."));
    return;
  }
  const requestId = msg.id ?? null;
  const metaVersion = msg.params?._meta?.["io.modelcontextprotocol/protocolVersion"];
  const headerVersion = req.headers["mcp-protocol-version"];
  const version = headerVersion || metaVersion || legacy;
  const isModern = version === modern;
  if (![modern, legacy, "2025-06-18", "2025-03-26"].includes(version)
    || (headerVersion && metaVersion && headerVersion !== metaVersion)) {
    send(res, 400, err(requestId, -32602, "Versione MCP non supportata o incoerente."));
    return;
  }
  if (isModern && (req.headers["mcp-method"] !== msg.method
    || (msg.method === "tools/call" && req.headers["mcp-name"] !== msg.params?.name))) {
    send(res, 400, err(requestId, -32600, "Header MCP-Method/Mcp-Name non validi."));
    return;
  }
  if (requestId === null) {
    if (msg.method === "notifications/initialized" || msg.method === "notifications/cancelled") {
      res.writeHead(202); res.end(); return;
    }
    send(res, 400, err(null, -32600, "Notifica non supportata."));
    return;
  }
  try {
    let result;
    switch (msg.method) {
      case "initialize":
        if (isModern) throw new ToolInputError("Initialize non previsto nel protocollo 2026.");
        result = {
          protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26"].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : legacy,
          capabilities: { tools: { listChanged: false } }, serverInfo: identity,
          instructions: inboxInstructions + " " + instructions,
        };
        break;
      case "server/discover":
        if (!isModern) throw new ToolInputError("Discovery richiede il protocollo 2026-07-28.");
        result = {
          supportedVersions: [modern, legacy],
          capabilities: { tools: { listChanged: false } },
          instructions: inboxInstructions + " " + instructions,
          ttlMs: 0, cacheScope: "private",
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: [...mcpTools, ...inboxTools], ...(isModern ? { ttlMs: 0, cacheScope: "private" } : {}) };
        break;
      case "tools/call":
        if (!msg.params || typeof msg.params.name !== "string") {
          send(res, 200, err(requestId, -32602, "Nome strumento mancante.")); return;
        }
        try {
          result = toolResult(await runTool(msg.params.name, inputObject(msg.params.arguments), callApi));
        } catch (e) {
          result = toolResult((e instanceof ToolInputError || (e.status && e.status < 500)) ? e.message : "Servizio temporaneamente non disponibile.", true);
        }
        break;
      default:
        send(res, 200, err(requestId, -32601, "Metodo MCP sconosciuto.")); return;
    }
    send(res, 200, { jsonrpc: "2.0", id: requestId, result: decorate(result, isModern) });
  } catch (e) {
    send(res, 200, err(requestId, -32602, e.message));
  }
}
