import pg from "pg";
import { readFile } from "node:fs/promises";
export const pool = new pg.Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {},
);
export async function initialize() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(731092)");
    await client.query(
      await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    const exists = await client.query("SELECT id FROM document WHERE id=1");
    if (!exists.rowCount) {
      const seed = JSON.parse(
        await readFile(
          new URL("../seed/initial.json", import.meta.url),
          "utf8",
        ),
      );
      for (const task of seed.tasks) {
        const code = task.id.replace(/-\d+$/, "");
        const number = Number(task.id.match(/\d+$/)[0]);
        const s = await client.query(
          "INSERT INTO sections(code,name,next_number) VALUES($1,$1,$2) ON CONFLICT(code) DO UPDATE SET next_number=GREATEST(sections.next_number,$2) RETURNING id",
          [code, number + 1],
        );
        await client.query(
          "INSERT INTO tasks(id,section_id,title,description,priority) VALUES($1,$2,$3,$4,$5)",
          [
            task.id,
            s.rows[0].id,
            task.title,
            [
              task.acceptance,
              task.dependency && "Dipendenze: " + task.dependency,
            ]
              .filter(Boolean)
              .join("\n\n"),
            task.priority,
          ],
        );
      }
      for (const d of seed.decisions)
        await client.query(
          "INSERT INTO decisions(code,question,answer) VALUES($1,$2,$3)",
          [d.id, d.question, d.answer],
        );
      await client.query("INSERT INTO document(id,markdown) VALUES(1,$1)", [
        seed.document,
      ]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
