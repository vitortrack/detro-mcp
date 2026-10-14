# detro-mcp

Servidores MCP usados pelo Claude Code nos projetos do DETRO. Cada banco tem o
seu servidor em `context/<banco>/`, com README próprio. Instale só os que usar.

| Servidor | Pasta | O que faz |
|---|---|---|
| `detro-db` | [`context/postgres`](context/postgres/README.md) | consultas no Postgres de dev (escrita opcional) |
| `detro-sqlserver` | [`context/sqlserver`](context/sqlserver/README.md) | consultas no SQL Server de dev (escrita opcional) |

Os dois têm as mesmas ferramentas (`listar_tabelas`, `descrever_tabela`,
`consultar`, `explicar_consulta`, `executar`), cada um no seu banco.

`executar` grava no banco e fica desligada até você criar um usuário de escrita
(passo opcional em cada seção abaixo).

## Instalação

```bash
git clone git@github.com:vitortrack/detro-mcp.git ~/Documentos/projects/detro-mcp
```

Cada servidor lê a conexão do `.env` da própria pasta (fica fora do git), então
funciona mesmo com o VS Code aberto pelo menu, sem herdar variáveis do shell.
Os dois só aceitam host local, nas duas conexões (leitura e escrita).

---

## Postgres (`detro-db`)

```bash
cd ~/Documentos/projects/detro-mcp/context/postgres && npm install
```

### Usuário somente leitura

Só uma vez por banco. Se o usuário já existe, pule para o `.env`. O script
[`create-readonly-role.sql`](context/postgres/create-readonly-role.sql) pode
rodar de novo sem problema.

1. Descubra o container do Postgres e a porta exposta na sua máquina:
   ```bash
   docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i postg
   ```
   O primeiro campo é o `<container_postgres>`. Em `127.0.0.1:5432->5432/tcp`,
   o host é `127.0.0.1` e a porta é `5432`; são esses que vão no `.env`.
2. Descubra o usuário dono das tabelas e o nome do banco (são os mesmos que a API usa):
   ```bash
   docker exec <container_postgres> printenv POSTGRES_USER POSTGRES_DB
   ```
3. Escolha um nome **novo** (ex.: `mcp_readonly`, nunca o dono das tabelas do passo 2)
   e uma senha para o usuário somente leitura, e rode o script:
   ```bash
   cd ~/Documentos/projects/detro-mcp
   docker exec -i <container_postgres> psql -U <dono_das_tabelas> -d <banco> \
     -v usuario=<usuario_readonly> -v senha=<senha_readonly> -v ON_ERROR_STOP=1 \
     < context/postgres/create-readonly-role.sql
   ```
4. Confira se conecta e se está mesmo só de leitura (o `CREATE` tem que dar erro):
   ```bash
   docker exec -it <container_postgres> psql "postgres://<usuario_readonly>:<senha_readonly>@localhost/<banco>" \
     -c 'SELECT 1' -c 'CREATE TABLE teste_mcp (id int)'
   ```

### Usuário de escrita (opcional, para `executar`)

Só se for usar `executar`. O script
[`create-write-role.sql`](context/postgres/create-write-role.sql) cria um
usuário que age como o dono das tabelas: lê, grava e cria/altera tabelas. Pode
rodar de novo sem problema.

1. Use o mesmo `<container_postgres>`, `<dono_das_tabelas>` e `<banco>` dos
   passos 1 e 2 acima.
2. Escolha **outro** nome novo (ex.: `mcp_escrita`, nem o dono das tabelas nem
   o somente leitura) e uma senha, e rode o script:
   ```bash
   cd ~/Documentos/projects/detro-mcp
   docker exec -i <container_postgres> psql -U <dono_das_tabelas> -d <banco> \
     -v usuario=<usuario_escrita> -v senha=<senha_escrita> -v ON_ERROR_STOP=1 \
     < context/postgres/create-write-role.sql
   ```
3. Confira se grava (o `CREATE` e o `DROP` têm que funcionar):
   ```bash
   docker exec -it <container_postgres> psql "postgres://<usuario_escrita>:<senha_escrita>@localhost/<banco>" \
     -c 'CREATE TABLE teste_mcp (id int)' -c 'DROP TABLE teste_mcp'
   ```

### Conexão

`context/postgres/.env`:

```bash
DATABASE_URL=postgres://<usuario_readonly>:<senha_readonly>@<host>:<porta>/<banco>
# só se criou o usuário de escrita:
DATABASE_URL_ESCRITA=postgres://<usuario_escrita>:<senha_escrita>@<host>:<porta>/<banco>
```

### Registrar no Claude Code

```bash
cd ~/Documentos/projects/detro-mcp/context/postgres
claude mcp add detro-db -s user -- node "$PWD/server.mjs"
```

---

## SQL Server (`detro-sqlserver`)

Requer SQL Server 2017 ou mais novo.

```bash
cd ~/Documentos/projects/detro-mcp/context/sqlserver && npm install
```

### Login somente leitura

Só uma vez por banco. O script
[`create-readonly-login.sql`](context/sqlserver/create-readonly-login.sql) cria
o login, o usuário no banco e dá só leitura (`db_datareader`), mais
`VIEW DEFINITION` e `SHOWPLAN` para descrever tabelas e ver planos. Pode rodar
de novo sem problema.

1. Descubra o container do SQL Server e a porta exposta na sua máquina:
   ```bash
   docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}' | grep -i sql
   ```
   O primeiro campo é o `<container_sqlserver>`. Em `127.0.0.1:1433->1433/tcp`,
   o host é `127.0.0.1` e a porta é `1433`.
2. Tenha em mãos um login administrador (ex.: `sa`) e o nome do banco.
3. Escolha um nome **novo** (ex.: `mcp_readonly`, nunca o login administrador) e
   uma senha forte **sem aspas simples**, e rode o script:
   ```bash
   cd ~/Documentos/projects/detro-mcp
   docker exec -i <container_sqlserver> /opt/mssql-tools18/bin/sqlcmd -C -b \
     -S localhost -U <login_admin> -P '<senha_admin>' -d <banco> \
     -v usuario=<usuario_readonly> senha=<senha_readonly> \
     < context/sqlserver/create-readonly-login.sql
   ```
   Se o SQL Server não for container, rode o mesmo `sqlcmd` direto na máquina,
   com `-S <host>,<porta>` e `-i context/sqlserver/create-readonly-login.sql`.
4. Confira se conecta e se está mesmo só de leitura (o `CREATE` tem que dar erro):
   ```bash
   docker exec -it <container_sqlserver> /opt/mssql-tools18/bin/sqlcmd -C \
     -S localhost -U <usuario_readonly> -P '<senha_readonly>' -d <banco> \
     -Q 'SELECT 1; CREATE TABLE teste_mcp (id int)'
   ```

### Login de escrita (opcional, para `executar`)

Só se for usar `executar`. O script
[`create-write-login.sql`](context/sqlserver/create-write-login.sql) cria o
login e o usuário no banco com `db_datareader`, `db_datawriter` e
`db_ddladmin`: lê, grava e cria/altera tabelas, sem ser dono do banco nem
sysadmin. Pode rodar de novo sem problema.

1. Use o mesmo `<container_sqlserver>`, `<login_admin>` e `<banco>` dos passos
   1 e 2 acima.
2. Escolha **outro** nome novo (ex.: `mcp_escrita`, nem o administrador nem o
   somente leitura) e uma senha forte **sem aspas simples**, e rode o script:
   ```bash
   cd ~/Documentos/projects/detro-mcp
   docker exec -i <container_sqlserver> /opt/mssql-tools18/bin/sqlcmd -C -b \
     -S localhost -U <login_admin> -P '<senha_admin>' -d <banco> \
     -v usuario=<usuario_escrita> senha=<senha_escrita> \
     < context/sqlserver/create-write-login.sql
   ```
   Fora de container: mesmo `sqlcmd` com `-S <host>,<porta>` e
   `-i context/sqlserver/create-write-login.sql`.
3. Confira se grava (o `CREATE` e o `DROP` têm que funcionar):
   ```bash
   docker exec -it <container_sqlserver> /opt/mssql-tools18/bin/sqlcmd -C -b \
     -S localhost -U <usuario_escrita> -P '<senha_escrita>' -d <banco> \
     -Q 'CREATE TABLE teste_mcp (id int); DROP TABLE teste_mcp'
   ```

### Conexão

`context/sqlserver/.env`:

```bash
DATABASE_URL=mssql://<usuario_readonly>:<senha_readonly>@<host>:<porta>/<banco>
# só se criou o login de escrita:
DATABASE_URL_ESCRITA=mssql://<usuario_escrita>:<senha_escrita>@<host>:<porta>/<banco>
```

Caracteres especiais na senha (`@`, `#`, `/`, `?`, `%`) precisam ser codificados
(`@` vira `%40`). Se o servidor não usar TLS, acrescente `?encrypt=false`.

### Registrar no Claude Code

```bash
cd ~/Documentos/projects/detro-mcp/context/sqlserver
claude mcp add detro-sqlserver -s user -- node "$PWD/server.mjs"
```

---

## Em um projeto só, em vez de todos

Troque o `claude mcp add -s user` por um `.mcp.json` na raiz do projeto, com o
caminho absoluto do servidor:

```json
{
  "mcpServers": {
    "detro-db": {
      "command": "node",
      "args": ["/home/<você>/Documentos/projects/detro-mcp/context/postgres/server.mjs"]
    },
    "detro-sqlserver": {
      "command": "node",
      "args": ["/home/<você>/Documentos/projects/detro-mcp/context/sqlserver/server.mjs"]
    }
  }
}
```

Não instale o mesmo servidor das duas formas, senão ele aparece duplicado.

## Pedir confirmação antes de gravar

Se o projeto liberar o servidor inteiro nas permissões (ex.: `"mcp__detro-db"`
no `allow`), `executar` também roda sem perguntar. Para ela sempre pedir
confirmação, acrescente no `.claude/settings.json` do projeto:

```json
{
  "permissions": {
    "ask": ["mcp__detro-db__executar", "mcp__detro-sqlserver__executar"]
  }
}
```

## Conferir

Rode `/mcp` no Claude Code: os servidores instalados devem aparecer conectados.
Depois de mudar o `.env`, reinicie o servidor por ali (ou reabra o Claude Code).
Se aparecer "Connection closed", rode o servidor no terminal para ver o erro
(`node context/<banco>/server.mjs`). Normalmente é caminho errado, `.env`
faltando ou banco fora do ar.
