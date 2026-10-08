# detro-mcp

Servidores MCP usados pelo Claude Code nos projetos do DETRO. Cada banco tem o
seu servidor em `context/<banco>/`, com README próprio. Instale só os que usar.

| Servidor | Pasta | O que faz |
|---|---|---|
| `detro-db` | [`context/postgres`](context/postgres/README.md) | consultas somente leitura no Postgres de dev |
| `detro-sqlserver` | [`context/sqlserver`](context/sqlserver/README.md) | consultas somente leitura no SQL Server de dev |

Os dois têm as mesmas ferramentas (`listar_tabelas`, `descrever_tabela`,
`consultar`, `explicar_consulta`), cada um no seu banco.

```bash
git clone git@github.com:vitortrack/detro-mcp.git ~/Documentos/projects/detro-mcp
```

Cada servidor lê a conexão do `.env` da própria pasta (fica fora do git), então
funciona mesmo com o VS Code aberto pelo menu, sem herdar variáveis do shell.
Os dois só aceitam host local.

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

### Conexão

`context/postgres/.env`:

```bash
DATABASE_URL=postgres://<usuario_readonly>:<senha_readonly>@<host>:<porta>/<banco>
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

### Conexão

`context/sqlserver/.env`:

```bash
DATABASE_URL=mssql://<usuario_readonly>:<senha_readonly>@<host>:<porta>/<banco>
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

## Conferir

Rode `/mcp` no Claude Code: os servidores instalados devem aparecer conectados.
Se aparecer "Connection closed", rode o servidor no terminal para ver o erro
(`node context/<banco>/server.mjs`). Normalmente é caminho errado, `.env`
faltando ou banco fora do ar.
