import http from "node:http";
import { readFile } from "node:fs/promises";
import { pool, initialize } from "./db.js";
import { handleMcp } from "./mcp.js";
import { conversationApi } from "./conversations.js";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
const statuses = [
  "Da fare",
  "In corso",
  "In verifica",
  "Bloccato",
  "Completato",
];
class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function field(body, key, max, { empty = false } = {}) {
  if (
    typeof body[key] !== "string" ||
    body[key].length > max ||
    (!empty && !body[key].trim())
  )
    throw new Problem(400, `Campo ${key} non valido.`);
  return body[key].trim();
}
function revision(b) {
  if (!Number.isInteger(b.revision) || b.revision < 1)
    throw new Problem(400, "Revisione mancante.");
  return b.revision;
}
async function body(req) {
  let data = "";
  for await (const c of req) {
    data += c;
    if (Buffer.byteLength(data) > 1100000)
      throw new Problem(413, "Contenuto troppo grande.");
  }
  try {
    const value = JSON.parse(data);
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new Error();
    return value;
  } catch {
    throw new Problem(400, "JSON non valido.");
  }
}
function taskFields(b) {
  const title = field(b, "title", 180),
    description = field(b, "description", 20000, { empty: true }),
    owner = field(b, "owner", 120, { empty: true });
  if (!statuses.includes(b.status) || !["P0", "P1", "P2"].includes(b.priority))
    throw new Problem(400, "Stato o priorità non validi.");
  return [title, description, b.status, owner, b.priority];
}
async function changed(result) {
  if (!result.rowCount)
    throw new Problem(
      409,
      "Questa voce è stata modificata o eliminata da un collega. Ricarica i dati prima di riprovare; il testo inserito è ancora disponibile.",
    );
  return result.rows[0];
}
async function snapshot() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const sections = await c.query(
      "SELECT id,code,revision FROM sections ORDER BY id",
    );
    const tasks = await c.query("SELECT * FROM tasks ORDER BY position");
    const decisions = await c.query(
      "SELECT * FROM decisions ORDER BY section_order,id",
    );
    const document = await c.query(
      "SELECT markdown,revision FROM document WHERE id=1",
    );
    await c.query("COMMIT");
    return {
      sections: sections.rows,
      tasks: tasks.rows,
      decisions: decisions.rows,
      document: document.rows[0],
    };
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function api(req, path) {
  if (path === "/conversations" || path.startsWith("/conversations/"))
    return conversationApi(req, path, { body, field, Problem });
  if (req.method === "GET" && path === "/state") return snapshot();
  if (req.method === "GET" && path === "/health") {
    await pool.query("SELECT 1");
    return { ok: true };
  }
  if (req.method === "POST" && path === "/sections") {
    const b = await body(req),
      code = field(b, "code", 16).toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,15}$/.test(code))
      throw new Problem(
        400,
        "Il codice deve iniziare con una lettera e contenere solo lettere e numeri.",
      );
    return (
      await pool.query(
        "INSERT INTO sections(code,next_number) VALUES($1,COALESCE((SELECT next_number FROM deleted_section_counters WHERE code=$1),1)) RETURNING id,code,revision",
        [code],
      )
    ).rows[0];
  }
  const section = path.match(/^\/sections\/(\d+)$/);
  if (section && req.method === "DELETE") {
    const b = await body(req);
    const expected = revision(b);
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Task creation locks this row before assigning a task ID.
      // Check tasks in a subsequent statement after acquiring this lock.
      const current = await c.query(
        "SELECT id,code,revision FROM sections WHERE id=$1 FOR UPDATE",
        [section[1]],
      );
      if (!current.rowCount || current.rows[0].revision !== expected)
        throw new Problem(409, "La sezione è stata modificata o eliminata. Aggiorna i dati prima di riprovare.");
      const inUse = await c.query(
        "SELECT 1 FROM tasks WHERE section_id=$1 LIMIT 1",
        [section[1]],
      );
      if (inUse.rowCount)
        throw new Problem(409, "La sezione contiene attività: eliminale prima di cancellare la sezione.");
      // Reserve the numbering even if this section code is recreated later.
      await c.query(
        "INSERT INTO deleted_section_counters(code,next_number) SELECT code,next_number FROM sections WHERE id=$1 ON CONFLICT(code) DO UPDATE SET next_number=GREATEST(deleted_section_counters.next_number,EXCLUDED.next_number)",
        [section[1]],
      );
      const deleted = await c.query(
        "DELETE FROM sections WHERE id=$1 RETURNING id,code",
        [section[1]],
      );
      await c.query("COMMIT");
      return deleted.rows[0];
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  if (req.method === "POST" && path === "/tasks") {
    const b = await body(req),
      values = taskFields(b);
    if (!/^\d+$/.test(String(b.section_id)))
      throw new Problem(400, "Seleziona una sezione.");
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const s = await c.query(
        "UPDATE sections SET next_number=next_number+1,revision=revision+1 WHERE id=$1 RETURNING code,next_number-1 AS number",
        [b.section_id],
      );
      if (!s.rowCount) throw new Problem(400, "Sezione inesistente.");
      const id =
        s.rows[0].code + "-" + String(s.rows[0].number).padStart(2, "0");
      const r = await c.query(
        "INSERT INTO tasks(id,section_id,title,description,status,owner,priority) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id, b.section_id, ...values],
      );
      await c.query("COMMIT");
      return r.rows[0];
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  const task = path.match(/^\/tasks\/([A-Z0-9-]+)$/);
  if (task && req.method === "PATCH") {
    const b = await body(req);
    return changed(
      await pool.query(
        "UPDATE tasks SET title=$1,description=$2,status=$3,owner=$4,priority=$5,revision=revision+1 WHERE id=$6 AND revision=$7 RETURNING *",
        [...taskFields(b), task[1], revision(b)],
      ),
    );
  }
  if (task && req.method === "DELETE") {
    const b = await body(req);
    return changed(
      await pool.query(
        "DELETE FROM tasks WHERE id=$1 AND revision=$2 RETURNING id",
        [task[1], revision(b)],
      ),
    );
  }
  if (req.method === "POST" && path === "/decisions") {
    const b = await body(req);
    return (
      await pool.query(
        "INSERT INTO decisions(question,answer) VALUES($1,$2) RETURNING *",
        [
          field(b, "question", 10000),
          field(b, "answer", 20000, { empty: true }),
        ],
      )
    ).rows[0];
  }
  const decision = path.match(/^\/decisions\/(\d+)$/);
  if (decision && req.method === "DELETE") {
    const b = await body(req);
    return changed(
      await pool.query(
        "DELETE FROM decisions WHERE id=$1 AND revision=$2 RETURNING id,code",
        [decision[1], revision(b)],
      ),
    );
  }
  if (decision && req.method === "PATCH") {
    const b = await body(req);
    return changed(
      await pool.query(
        "UPDATE decisions SET question=$1,answer=$2,section_order=CASE WHEN answer IS DISTINCT FROM $2 THEN nextval('decision_order') ELSE section_order END,revision=revision+1 WHERE id=$3 AND revision=$4 RETURNING *",
        [
          field(b, "question", 10000),
          field(b, "answer", 20000, { empty: true }),
          decision[1],
          revision(b),
        ],
      ),
    );
  }
  if (req.method === "PUT" && path === "/document") {
    const b = await body(req);
    if (typeof b.markdown !== "string" || b.markdown.length > 1000000)
      throw new Problem(400, "Documento non valido.");
    return changed(
      await pool.query(
        "UPDATE document SET markdown=$1,revision=revision+1 WHERE id=1 AND revision=$2 RETURNING markdown,revision",
        [b.markdown, revision(b)],
      ),
    );
  }
  if (req.method === "POST" && path === "/preview") {
    const b = await body(req);
    if (typeof b.markdown !== "string" || b.markdown.length > 1000000)
      throw new Problem(400, "Documento non valido.");
    return {
      html: sanitizeHtml(marked.parse(b.markdown), {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
          "h1",
          "h2",
          "img",
        ]),
        allowedAttributes: {
          ...sanitizeHtml.defaults.allowedAttributes,
          img: ["src", "alt"],
          a: ["href", "title", "rel", "target"],
        },
        allowedSchemes: ["https", "http", "mailto"],
      }),
    };
  }
  throw new Problem(404, "Risorsa non trovata.");
}
const assets = {
  "/": "index.html",
  "/index.html": "index.html",
  "/app.js": "app.js",
  "/conversations.js": "conversations.js",
  "/style.css": "style.css",
  "/favicon.svg": "favicon.svg",
};
const mime = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
};
export async function start(port = Number(process.env.PORT || 8791)) {
  await initialize();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    try {
      const url = new URL(req.url, "http://localhost");
      // Relative asset/API URLs require the trailing slash on subpath deployments.
      if (url.pathname === "/sportx-plan") {
        res.writeHead(308, { Location: "/sportx-plan/" + url.search });
        res.end();
        return;
      }
      let path = url.pathname.replace(/^\/sportx-plan(?=\/|$)/, "") || "/";
      if (path === "/mcp") {
        await handleMcp(req, res, api);
        return;
      }
      if (path.startsWith("/api/")) {
        if (!["GET", "HEAD"].includes(req.method)) {
          if (!req.headers["content-type"]?.startsWith("application/json"))
            throw new Problem(415, "Usa application/json.");
          if (
            req.headers.origin &&
            new URL(req.headers.origin).host !== req.headers.host
          )
            throw new Problem(403, "Origine non consentita.");
        }
        const result = await api(req, path.slice(4));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } else if (req.method === "GET" && assets[path]) {
        res.writeHead(200, {
          "Content-Type": mime[assets[path].split(".").pop()],
        });
        res.end(
          await readFile(new URL("../src/" + assets[path], import.meta.url)),
        );
      } else throw new Problem(404, "Risorsa non trovata.");
    } catch (e) {
      const status = e.status || (e.code === "23505" ? 409 : 500);
      if (status === 500) console.error(e.message);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: e.status
            ? e.message
            : e.code === "23505"
              ? "Questo codice esiste già."
              : "Servizio temporaneamente non disponibile.",
        }),
      );
    }
  });
  await new Promise((resolve) =>
    server.listen(port, process.env.HOST || "127.0.0.1", resolve),
  );
  return server;
}
if (process.env.NODE_ENV !== "test") {
  const server = await start();
  console.log("SportX Plan in ascolto su " + server.address().port);
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(async () => {
        await pool.end();
        process.exit(0);
      }),
    );
}
