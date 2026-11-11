# detro-db — MCP para o Postgres de desenvolvimento

Dá ao Claude Code ferramentas para olhar o banco de dev e, opcionalmente, gravar nele:

| Ferramenta | Para quê |
|---|---|
| `listar_tabelas` | descobrir onde um dado mora (`filtro: "refuel"`) |
| `descrever_tabela` | colunas, constraints (PK/FK/UNIQUE/CHECK) e índices |
| `consultar` | uma consulta de leitura, com `$1, $2…` e até 200 linhas |
| `explicar_consulta` | `EXPLAIN ANALYZE` para investigar lentidão e índice faltando |
| `executar` | um comando que altera o banco (INSERT, UPDATE, DELETE, CREATE, ALTER…) e grava; desligada sem `DATABASE_URL_ESCRITA` |

## Proteções das ferramentas de leitura (em camadas)
1. Só conecta em host local (`localhost`, `127.0.0.1`, `db`, `postgres`). Outro host
   exige `MCP_DB_ALLOW_REMOTE=1`, o que **não** deve ser usado para staging/produção.
2. Aceita um único comando de leitura por chamada.
3. Toda chamada roda em `BEGIN TRANSACTION READ ONLY` + `ROLLBACK`, com timeout.
   O próprio Postgres recusa escrita, mesmo escondida num `WITH … DELETE`.
4. Recomendado: usuário só de leitura (ver `create-readonly-role.sql`), que só tem
   `SELECT`. Mesmo um bug neste servidor não conseguiria escrever.

## Escrita (`executar`)
- Usa uma segunda conexão (`DATABASE_URL_ESCRITA`), com um usuário criado por
  `create-write-role.sql`, que age como o dono das tabelas. As outras
  ferramentas continuam no usuário somente leitura.
- Sem `DATABASE_URL_ESCRITA`, `executar` só responde que a escrita está desativada.
- Mesma trava de host local, um comando por chamada, timeout, e `COMMIT` só se
  der certo (erro = nada gravado).
- Para pedir confirmação a cada uso: `"ask": ["mcp__detro-db__executar"]`.

## Staging (sob demanda)
As quatro ferramentas de leitura e `executar` aceitam `banco: "staging"`. Sem o
parâmetro, é sempre o banco local. Em staging, `executar` grava com o usuário de
`DATABASE_URL_STAGING`.

- O RDS de staging só é alcançável de dentro da AWS. No primeiro uso, o MCP abre
  um túnel `ssh -N -L` pelo servidor de staging numa porta livre local, e o fecha
  quando o MCP encerra.
- TLS validado de verdade: certificado conferido contra a cadeia oficial do RDS
  (`certs/rds-global-bundle.pem`, de
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) e contra o
  nome real do host do RDS.
- As mesmas travas do banco local: um comando por chamada, timeout; leitura em
  `BEGIN READ ONLY` + `ROLLBACK`.

No `.env` desta pasta:
```bash
DATABASE_URL_STAGING=postgres://<usuário de leitura>:<senha>@<host do RDS>:5432/<banco>
STAGING_SSH=-i /caminho/para/chave.pem ubuntu@<ip do servidor de staging>
```

## Instalação
```bash
git clone git@github.com:vitortrack/detro-mcp.git ~/Documentos/projects/detro-mcp
cd ~/Documentos/projects/detro-mcp/context/postgres && npm install
claude mcp add detro-db -s user -- node "$PWD/server.mjs"
```
Com `-s user` o servidor aparece em qualquer pasta, junto dos outros MCPs. A
conexão vem do `.env` desta pasta. Criação dos usuários (leitura e escrita) e
`.env` passo a passo no [README da raiz](../../README.md). Confira com `/mcp`.

## Variáveis
- `DATABASE_URL`: conexão somente leitura, lida de `.env` nesta pasta (variável já definida no ambiente tem prioridade)
- `DATABASE_URL_ESCRITA`: conexão de escrita, opcional; liga `executar`
- `DATABASE_URL_STAGING` e `STAGING_SSH`: opcionais; ligam `banco: "staging"` na leitura e no `executar`
- `MCP_DB_MAX_ROWS`: limite de linhas (padrão 200)
- `MCP_DB_TIMEOUT_MS`: timeout por consulta (padrão 10000)
