// Stateless MCP Streamable HTTP endpoint for the SportX planning dashboard.
// No additional dependency: tools reuse the exact same API validations and
// optimistic revisions used by the browser.
import { createHash, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";

const identity = { name: "sportx-plan", version: "1.0.0" };
const modern = "2026-07-28";
const legacy = "2025-11-25";
const str = (maxLength) => ({ type: "string", maxLength });
const pos = { type: "integer", minimum: 1 };
const props = {
  section_id: pos,
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
  tool("list_tasks", "Elenca le attività, con filtro facoltativo per sezione e stato.", ["section_id", "status"]),
  tool("create_task", "Crea un'attività nella sezione indicata; l'ID è assegnato dal server.", ["section_id", "title", "description", "owner", "status", "priority"], ["section_id", "title"], true),
  tool("update_task", "Aggiorna un'attività con revisione ottimistica; richiede tutti i campi modificabili.", ["id", "revision", "title", "description", "owner", "status", "priority"], ["id", "revision", "title", "description", "owner", "status", "priority"], true),
  tool("delete_task", "Elimina un'attività solo dopo conferma esplicita e verifica della revisione.", ["id", "revision", "confirm"], ["id", "revision", "confirm"], true, true),
  tool("list_decisions", "Elenca decisioni e domande, con filtro facoltativo per risposta presente.", ["answered"]),
  tool("create_decision", "Crea una decisione (domanda e risposta facoltativa).", ["question", "answer"], ["question"], true),
  tool("update_decision", "Modifica domanda e risposta conservando il controllo delle revisioni.", ["id", "revision", "question", "answer"], ["id", "revision", "question", "answer"], true),
  tool("read_document", "Leggi il documento Markdown condiviso e la sua revisione."),
  tool("update_document", "Sostituisci il documento Markdown solo se la revisione corrisponde.", ["revision", "markdown"], ["revision", "markdown"], true, true),
];

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
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Argomenti non validi.");
  return value;
}
function identifier(value, type) {
  if (type === "task") {
    if (typeof value !== "string" || !/^[A-Z][A-Z0-9]*-[0-9]+$/.test(value))
      throw new Error("ID attività non valido.");
    return value;
  }
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("ID non valido.");
  return String(value);
}
function requireRevision(a) {
  if (!Number.isSafeInteger(a.revision) || a.revision < 1) throw new Error("Revisione non valida.");
}
function validateArguments(def, args) {
  const schema = def.inputSchema;
  for (const key of schema.required) if (!(key in args)) throw new Error("Campo richiesto: " + key);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new Error("Campo sconosciuto: " + key);
    if (rule.type === "string" && (typeof value !== "string" || value.length > rule.maxLength))
      throw new Error("Campo non valido: " + key);
    if (rule.type === "integer" && (!Number.isSafeInteger(value) || value < rule.minimum))
      throw new Error("Campo non valido: " + key);
    if (rule.type === "boolean" && typeof value !== "boolean")
      throw new Error("Campo non valido: " + key);
    if (rule.enum && !rule.enum.includes(value)) throw new Error("Campo non valido: " + key);
    if (rule.const !== undefined && value !== rule.const) throw new Error("Conferma esplicita richiesta.");
  }
}
async function runTool(name, args, callApi) {
  const def = mcpTools.find((x) => x.name === name);
  if (!def) throw new Error("Strumento sconosciuto: " + name);
  validateArguments(def, args);
  async function call(method, path, data) {
    const request = Readable.from(data === undefined ? [] : [JSON.stringify(data)]);
    request.method = method;
    return callApi(request, path);
  }
  const state = () => call("GET", "/state");
  switch (name) {
    case "sportx_get_state": return state();
    case "sportx_list_sections": return (await state()).sections;
    case "sportx_create_section": return call("POST", "/sections", { code: args.code });
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
    case "sportx_read_document": return (await state()).document;
    case "sportx_update_document":
      requireRevision(args);
      return call("PUT", "/document", { revision: args.revision, markdown: args.markdown });
    default: throw new Error("Strumento sconosciuto.");
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
  // Fail closed: the endpoint is disabled until a strong secret is configured.
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
        throw new Error();
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
        if (isModern) throw new Error("Initialize non previsto nel protocollo 2026.");
        result = {
          protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26"].includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : legacy,
          capabilities: { tools: { listChanged: false } }, serverInfo: identity,
          instructions: "Usa i tool SportX per gestire dati condivisi. Prima di modificare una voce leggi la revisione corrente.",
        };
        break;
      case "server/discover":
        if (!isModern) throw new Error("Discovery richiede il protocollo 2026-07-28.");
        result = {
          supportedVersions: [modern, legacy],
          capabilities: { tools: { listChanged: false } },
          instructions: "Usa le revisioni correnti quando modifichi o elimini dati.",
          ttlMs: 0, cacheScope: "private",
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: mcpTools, ...(isModern ? { ttlMs: 0, cacheScope: "private" } : {}) };
        break;
      case "tools/call":
        if (!msg.params || typeof msg.params.name !== "string") {
          send(res, 200, err(requestId, -32602, "Nome strumento mancante.")); return;
        }
        try {
          result = toolResult(await runTool(msg.params.name, inputObject(msg.params.arguments), callApi));
        } catch (e) {
          result = toolResult(e.status && e.status < 500 ? e.message : (e.status ? "Servizio temporaneamente non disponibile." : e.message), true);
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
