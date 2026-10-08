# detro-sqlserver — MCP somente leitura para o SQL Server de desenvolvimento

Mesmas quatro ferramentas do `detro-db`, para SQL Server (2017+):

| Ferramenta | Para quê |
|---|---|
| `listar_tabelas` | descobrir onde um dado mora (`filtro: "aluno"`) |
| `descrever_tabela` | colunas, constraints (PK/FK/UNIQUE/CHECK) e índices |
| `consultar` | uma consulta de leitura, com `@p1, @p2…` e até 200 linhas |
| `explicar_consulta` | `SET STATISTICS PROFILE`: plano com linhas reais × estimadas |

## Proteções (em camadas)
1. Só conecta em host local (`localhost`, `127.0.0.1`, `db`, `mssql`, `sqlserver`).
   Outro host exige `MCP_DB_ALLOW_REMOTE=1`, o que **não** deve ser usado para
   staging/produção.
2. Aceita um único comando `SELECT`/`WITH` por chamada.
3. Toda chamada roda numa transação desfeita no fim (`ROLLBACK`), com timeout.
   O SQL Server não tem transação somente leitura como o Postgres, então a
   garantia principal é a próxima camada.
4. Login só com `db_datareader` (ver `create-readonly-login.sql`): mesmo um bug
   neste servidor não conseguiria escrever.

Instalação passo a passo no [README da raiz](../../README.md).

## Variáveis
- `DATABASE_URL`: `mssql://usuario:senha@host:porta/banco`, lida de `.env` nesta
  pasta (variável já definida no ambiente tem prioridade). `?encrypt=false` para
  servidor sem TLS.
- `MCP_DB_MAX_ROWS`: limite de linhas (padrão 200)
- `MCP_DB_TIMEOUT_MS`: timeout por consulta (padrão 10000)
