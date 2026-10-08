#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import sql from "mssql";
import { z } from "zod";
import { existsSync } from "node:fs";

const ENV_FILE = new URL(".env", import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const DATABASE_URL = process.env.DATABASE_URL;
const MAX_ROWS = Number(process.env.MCP_DB_MAX_ROWS ?? 200);
const TIMEOUT_MS = Number(process.env.MCP_DB_TIMEOUT_MS ?? 10000);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "db", "mssql", "sqlserver"]);

const log = (...args) => console.error("[detro-sqlserver]", ...args);

function configFrom(url) {
  if (!url) throw new Error("DATABASE_URL não definida.");
  const u = new URL(url);
  if (!LOCAL_HOSTS.has(u.hostname) && process.env.MCP_DB_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Host "${u.hostname}" não é local. Este MCP só conecta no banco de desenvolvimento. ` +
        "Defina MCP_DB_ALLOW_REMOTE=1 apenas se tiver certeza.",
    );
  }
  return {
    server: u.hostname,
    port: Number(u.port || 1433),
    database: decodeURIComponent(u.pathname.slice(1)),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    requestTimeout: TIMEOUT_MS,
    pool: { max: 2 },
    options: {
      encrypt: u.searchParams.get("encrypt") !== "false",
      trustServerCertificate: u.searchParams.get("trustServerCertificate") !== "false",
    },
  };
}

const pool = new sql.ConnectionPool(configFrom(DATABASE_URL));
const ready = pool.connect();

function assertSingleReadStatement(text) {
  const body = text.trim().replace(/;\s*$/, "");
  if (!body) throw new Error("SQL vazio.");
  if (body.includes(";")) throw new Error("Envie apenas um comando por vez.");
  if (!/^(select|with)\b/i.test(body)) throw new Error("Somente consultas de leitura (SELECT, WITH).");
  return body;
}

async function rolledBack(fn) {
  await ready;
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    return await fn((text, values = []) => {
      const req = new sql.Request(tx);
      values.forEach((v, i) => req.input(`p${i + 1}`, v));
      return req.query(text);
    });
  } finally {
    await tx.rollback().catch(() => {});
  }
}

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
const PARAMS = z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional();

const server = new McpServer({ name: "detro-sqlserver", version: "1.0.0" });

server.registerTool(
  "listar_tabelas",
  {
    title: "Listar tabelas",
    description:
      "Lista tabelas e views do banco SQL Server de desenvolvimento, com quantidade aproximada de linhas (sys.partitions). Use para descobrir onde um dado mora antes de consultar; para afirmar quantidade, use consultar com COUNT(*).",
    inputSchema: {
      filtro: z.string().optional().describe("Parte do nome para filtrar, ex.: 'aluno', 'veiculo'"),
    },
    annotations: READ_ONLY,
  },
  async ({ filtro }) => {
    try {
      const { recordset } = await rolledBack((q) =>
        q(
          `SELECT s.name AS [schema], o.name AS nome,
                  CASE o.type WHEN 'U' THEN 'tabela' ELSE 'view' END AS tipo,
                  CAST(SUM(CASE WHEN p.index_id IN (0, 1) THEN p.rows END) AS bigint) AS linhas_aproximadas
             FROM sys.objects o
             JOIN sys.schemas s ON s.schema_id = o.schema_id
             LEFT JOIN sys.partitions p ON p.object_id = o.object_id
            WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
              AND (@p1 IS NULL OR o.name LIKE '%' + @p1 + '%')
            GROUP BY s.name, o.name, o.type
            ORDER BY 1, 2`,
          [filtro ?? null],
        ),
      );
      return ok(asTable(recordset));
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
      "Mostra colunas (tipo, nulo, default, identity), constraints (PK, FK, UNIQUE, CHECK) e índices de uma tabela ou view do SQL Server.",
    inputSchema: {
      tabela: z.string().describe("Nome da tabela, opcionalmente com schema: 'Alunos' ou 'dbo.Alunos'"),
    },
    annotations: READ_ONLY,
  },
  async ({ tabela }) => {
    try {
      const [schema, name] = tabela.includes(".") ? tabela.split(".", 2) : ["dbo", tabela];
      const out = await rolledBack(async (q) => {
        const id = (await q("SELECT OBJECT_ID(QUOTENAME(@p1) + '.' + QUOTENAME(@p2)) AS id", [schema, name]))
          .recordset[0].id;
        if (id === null) throw new Error(`Tabela ${schema}.${name} não encontrada.`);
        const cols = await q(
          `SELECT c.name AS coluna,
                  t.name COLLATE DATABASE_DEFAULT + CASE
                    WHEN t.name IN ('varchar', 'char', 'varbinary', 'binary')
                      THEN '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length AS varchar)) + ')'
                    WHEN t.name IN ('nvarchar', 'nchar')
                      THEN '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length / 2 AS varchar)) + ')'
                    WHEN t.name IN ('decimal', 'numeric')
                      THEN '(' + CAST(c.precision AS varchar) + ',' + CAST(c.scale AS varchar) + ')'
                    ELSE '' END AS tipo,
                  IIF(c.is_nullable = 1, 'sim', 'não') AS aceita_nulo,
                  dc.definition COLLATE DATABASE_DEFAULT AS [default],
                  IIF(c.is_identity = 1, 'sim', 'não') AS [identity]
             FROM sys.columns c
             JOIN sys.types t ON t.user_type_id = c.user_type_id
             LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
            WHERE c.object_id = @p1
            ORDER BY c.column_id`,
          [id],
        );
        const cons = await q(
          `SELECT kc.name AS nome, IIF(kc.type = 'PK', 'PK', 'UNIQUE') AS tipo,
                  '(' + (SELECT STRING_AGG(c.name COLLATE DATABASE_DEFAULT, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)
                           FROM sys.index_columns ic
                           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                          WHERE ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id) + ')' AS definicao
             FROM sys.key_constraints kc
            WHERE kc.parent_object_id = @p1
           UNION ALL
           SELECT fk.name, 'FK',
                  '(' + STRING_AGG(pc.name COLLATE DATABASE_DEFAULT, ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) + ') REFERENCES ' +
                  OBJECT_SCHEMA_NAME(fk.referenced_object_id) COLLATE DATABASE_DEFAULT + '.' +
                  OBJECT_NAME(fk.referenced_object_id) COLLATE DATABASE_DEFAULT +
                  ' (' + STRING_AGG(rc.name COLLATE DATABASE_DEFAULT, ', ') WITHIN GROUP (ORDER BY fkc.constraint_column_id) + ') ON DELETE ' +
                  REPLACE(fk.delete_referential_action_desc COLLATE DATABASE_DEFAULT, '_', ' ')
             FROM sys.foreign_keys fk
             JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
             JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
             JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
            WHERE fk.parent_object_id = @p1
            GROUP BY fk.name, fk.referenced_object_id, fk.delete_referential_action_desc
           UNION ALL
           SELECT name, 'CHECK', definition COLLATE DATABASE_DEFAULT FROM sys.check_constraints WHERE parent_object_id = @p1
           ORDER BY 2, 1`,
          [id],
        );
        const idx = await q(
          `SELECT i.name AS nome,
                  i.type_desc COLLATE DATABASE_DEFAULT + IIF(i.is_unique = 1, ' UNIQUE', '') + ' (' +
                  STRING_AGG(c.name COLLATE DATABASE_DEFAULT + IIF(ic.is_descending_key = 1, ' DESC', ''), ', ')
                    WITHIN GROUP (ORDER BY ic.key_ordinal) + ')' +
                  ISNULL(' WHERE ' + i.filter_definition COLLATE DATABASE_DEFAULT, '') AS definicao
             FROM sys.indexes i
             JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 0
             JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
            WHERE i.object_id = @p1 AND i.index_id > 0
            GROUP BY i.name, i.type_desc, i.is_unique, i.filter_definition
            ORDER BY 1`,
          [id],
        );
        return [
          `## ${schema}.${name}`,
          "### Colunas", asTable(cols.recordset),
          "### Constraints", asTable(cons.recordset),
          "### Índices", asTable(idx.recordset),
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
      `Executa UMA consulta de leitura no SQL Server de desenvolvimento, dentro de uma transação desfeita no fim (ROLLBACK), com timeout de ${TIMEOUT_MS / 1000}s. Retorna no máximo ${MAX_ROWS} linhas. Colunas geography/geometry: use coluna.STAsText().`,
    inputSchema: {
      sql: z.string().describe("Uma única consulta SELECT/WITH. Use @p1, @p2… para valores."),
      parametros: PARAMS.describe("Valores para @p1, @p2…"),
    },
    annotations: READ_ONLY,
  },
  async ({ sql: text, parametros }) => {
    try {
      const body = assertSingleReadStatement(text);
      const rows = (await rolledBack((q) => q(body, parametros ?? []))).recordset ?? [];
      const cut = rows.length > MAX_ROWS;
      const shown = cut ? rows.slice(0, MAX_ROWS) : rows;
      const footer = cut
        ? `\n\n(${rows.length} linhas; mostrando as primeiras ${MAX_ROWS}. Use TOP, filtros ou agregação.)`
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
      "Executa a consulta com SET STATISTICS PROFILE e mostra o plano com linhas reais × estimadas, para investigar lentidão e índices faltando. Roda numa transação desfeita no fim.",
    inputSchema: {
      sql: z.string().describe("Uma única consulta SELECT/WITH."),
      parametros: PARAMS.describe("Valores para @p1, @p2…"),
    },
    annotations: READ_ONLY,
  },
  async ({ sql: text, parametros }) => {
    try {
      const body = assertSingleReadStatement(text);
      const res = await rolledBack((q) =>
        q(`SET STATISTICS PROFILE ON; ${body}; SET STATISTICS PROFILE OFF;`, parametros ?? []),
      );
      const plan = res.recordsets.filter((r) => r.length && "StmtText" in r[0]).flat();
      return ok(
        asTable(plan.map((r) => ({ linhas: r.Rows, execucoes: r.Executes, estimadas: r.EstimateRows, operacao: r.StmtText }))),
      );
    } catch (e) {
      return fail(e);
    }
  },
);

const shutdown = async () => {
  await pool.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log(`pronto (${new URL(DATABASE_URL).hostname}, máx. ${MAX_ROWS} linhas, timeout ${TIMEOUT_MS}ms)`);
