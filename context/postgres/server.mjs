#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { z } from "zod";
import { existsSync } from "node:fs";

const ENV_FILE = new URL(".env", import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const DATABASE_URL = process.env.DATABASE_URL;
const MAX_ROWS = Number(process.env.MCP_DB_MAX_ROWS ?? 200);
const TIMEOUT_MS = Number(process.env.MCP_DB_TIMEOUT_MS ?? 10000);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "db", "postgres"]);

const log = (...args) => console.error("[detro-db]", ...args);

function assertSafeTarget(url) {
  if (!url) throw new Error("DATABASE_URL não definida.");
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.MCP_DB_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Host "${host}" não é local. Este MCP só conecta no banco de desenvolvimento. ` +
        "Defina MCP_DB_ALLOW_REMOTE=1 apenas se tiver certeza.",
    );
  }
}

assertSafeTarget(DATABASE_URL);
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

function assertSingleReadStatement(sql) {
  const body = sql.trim().replace(/;\s*$/, "");
  if (!body) throw new Error("SQL vazio.");
  if (body.includes(";")) throw new Error("Envie apenas um comando por vez.");
  if (!/^(select|with|values|table|show|explain)\b/i.test(body)) {
    throw new Error("Somente consultas de leitura (SELECT, WITH, VALUES, SHOW, EXPLAIN).");
  }
  return body;
}

async function readOnly(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.trunc(TIMEOUT_MS)}`);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
}

const run = (client, text, values = []) =>
  client.query({ text, values, queryMode: "extended" });

function asTable(rows) {
  if (rows.length === 0) return "(0 linhas)";
  const cols = Object.keys(rows[0]);
  const cell = (v) =>
    v === null ? "NULL" : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  const lines = [cols.join(" | "), cols.map(() => "---").join(" | ")];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c]).replace(/\|/g, "\\|")).join(" | "));
  return lines.join("\n");
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (err) => ({ content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const server = new McpServer({ name: "detro-db", version: "1.0.0" });

server.registerTool(
  "listar_tabelas",
  {
    title: "Listar tabelas",
    description:
      "Lista tabelas, views e materialized views do banco de desenvolvimento do detrorjweb, com estimativa de linhas. Use para descobrir onde um dado mora antes de consultar. A estimativa vem das estatísticas do Postgres e pode estar desatualizada ou desconhecida: nunca conclua que uma tabela está vazia por ela; para afirmar quantidade, use consultar com count(*).",
    inputSchema: {
      filtro: z.string().optional().describe("Parte do nome para filtrar, ex.: 'refuel', 'student'"),
    },
    annotations: READ_ONLY,
  },
  async ({ filtro }) => {
    try {
      const { rows } = await readOnly((c) =>
        run(
          c,
          `SELECT n.nspname AS schema, c.relname AS nome,
                  CASE c.relkind WHEN 'r' THEN 'tabela' WHEN 'v' THEN 'view'
                                 WHEN 'm' THEN 'materialized view' WHEN 'p' THEN 'tabela particionada' END AS tipo,
                  CASE WHEN c.reltuples < 0 THEN 'desconhecido (sem ANALYZE)'
                       ELSE c.reltuples::bigint::text END AS linhas_estimadas
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind IN ('r','v','m','p')
              AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'
              AND ($1::text IS NULL OR c.relname ILIKE '%' || $1 || '%')
            ORDER BY 1, 2`,
          [filtro ?? null],
        ),
      );
      return ok(asTable(rows));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "descrever_tabela",
  {
    title: "Descrever tabela",
    description:
      "Mostra colunas (tipo, nulo, default), constraints (PK, FK, UNIQUE, CHECK) e índices de uma tabela ou view. Use antes de escrever query, migration ou tradução em pg-errors.ts.",
    inputSchema: {
      tabela: z.string().describe("Nome da tabela, opcionalmente com schema: 'vehicle_refuels' ou 'public.vehicle_refuels'"),
    },
    annotations: READ_ONLY,
  },
  async ({ tabela }) => {
    try {
      const [schema, name] = tabela.includes(".") ? tabela.split(".", 2) : ["public", tabela];
      const out = await readOnly(async (c) => {
        const cols = await run(
          c,
          `SELECT a.attname AS coluna, format_type(a.atttypid, a.atttypmod) AS tipo,
                  CASE WHEN a.attnotnull THEN 'não' ELSE 'sim' END AS aceita_nulo,
                  pg_get_expr(d.adbin, d.adrelid) AS default
             FROM pg_attribute a
             JOIN pg_class t ON t.oid = a.attrelid JOIN pg_namespace n ON n.oid = t.relnamespace
             LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
            WHERE n.nspname = $1 AND t.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum`,
          [schema, name],
        );
        if (cols.rows.length === 0) throw new Error(`Tabela ${schema}.${name} não encontrada.`);
        const cons = await run(
          c,
          `SELECT con.conname AS nome,
                  CASE con.contype WHEN 'p' THEN 'PK' WHEN 'f' THEN 'FK' WHEN 'u' THEN 'UNIQUE'
                                   WHEN 'c' THEN 'CHECK' WHEN 'x' THEN 'EXCLUDE' END AS tipo,
                  pg_get_constraintdef(con.oid) AS definicao
             FROM pg_constraint con
             JOIN pg_class t ON t.oid = con.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = $1 AND t.relname = $2
            ORDER BY 2, 1`,
          [schema, name],
        );
        const idx = await run(
          c,
          `SELECT indexname AS nome, indexdef AS definicao FROM pg_indexes
            WHERE schemaname = $1 AND tablename = $2 ORDER BY 1`,
          [schema, name],
        );
        return [
          `## ${schema}.${name}`,
          "### Colunas", asTable(cols.rows),
          "### Constraints", asTable(cons.rows),
          "### Índices", asTable(idx.rows),
        ].join("\n\n");
      });
      return ok(out);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "consultar",
  {
    title: "Consultar (somente leitura)",
    description:
      `Executa UMA consulta de leitura no banco de desenvolvimento, dentro de uma transação READ ONLY com timeout de ${TIMEOUT_MS / 1000}s. Retorna no máximo ${MAX_ROWS} linhas. Escritas são bloqueadas pelo próprio Postgres. Lembre de filtrar por tenant quando fizer sentido. Colunas PostGIS (geometry/geography) voltam em formato binário: use ST_AsText(coluna) ou ST_AsGeoJSON(coluna).`,
    inputSchema: {
      sql: z.string().describe("Uma única consulta SELECT/WITH. Use $1, $2… para valores."),
      parametros: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
        .describe("Valores para $1, $2…"),
    },
    annotations: READ_ONLY,
  },
  async ({ sql, parametros }) => {
    try {
      const body = assertSingleReadStatement(sql);
      const res = await readOnly((c) => run(c, body, parametros ?? []));
      const rows = res.rows ?? [];
      const cut = rows.length > MAX_ROWS;
      const shown = cut ? rows.slice(0, MAX_ROWS) : rows;
      const footer = cut
        ? `\n\n(${rows.length} linhas; mostrando as primeiras ${MAX_ROWS}. Use LIMIT, filtros ou agregação.)`
        : `\n\n(${rows.length} linha${rows.length === 1 ? "" : "s"})`;
      return ok(asTable(shown) + footer);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "explicar_consulta",
  {
    title: "Plano de execução",
    description:
      "Mostra o plano de execução (EXPLAIN ANALYZE, BUFFERS) de uma consulta de leitura, para investigar lentidão e índices faltando. Roda numa transação READ ONLY.",
    inputSchema: {
      sql: z.string().describe("Uma única consulta SELECT/WITH, sem o EXPLAIN na frente."),
      parametros: z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
    },
    annotations: READ_ONLY,
  },
  async ({ sql, parametros }) => {
    try {
      const body = assertSingleReadStatement(sql);
      if (/^explain\b/i.test(body)) throw new Error("Envie a consulta sem EXPLAIN; ele é adicionado aqui.");
      const res = await readOnly((c) => run(c, `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${body}`, parametros ?? []));
      return ok(res.rows.map((r) => r["QUERY PLAN"]).join("\n"));
    } catch (e) {
      return fail(e);
    }
  },
);

const shutdown = async () => {
  await pool.end().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log(`pronto (${new URL(DATABASE_URL).hostname}, máx. ${MAX_ROWS} linhas, timeout ${TIMEOUT_MS}ms)`);
