# detro-mcp

Servidores MCP usados pelo Claude Code nos projetos do DETRO. Cada servidor mora
em `context/<tipo>/`, com README próprio.

| Servidor | Pasta | O que faz |
|---|---|---|
| `detro-db` | [`context/database`](context/database/README.md) | consultas somente leitura no Postgres de dev |

## Instalação

```bash
git clone git@github.com:vitortrack/detro-mcp.git ~/Documentos/projects/detro-mcp
cd ~/Documentos/projects/detro-mcp/context/database && npm install
```

### Usuário somente leitura no banco de dev

Só uma vez por banco. Se o usuário já existe, pule para o `.env`. O script
[`create-readonly-role.sql`](context/database/create-readonly-role.sql) pode
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
     < context/database/create-readonly-role.sql
   ```
4. Confira se conecta e se está mesmo só de leitura (o `CREATE` tem que dar erro):
   ```bash
   docker exec -it <container_postgres> psql "postgres://<usuario_readonly>:<senha_readonly>@localhost/<banco>" \
     -c 'SELECT 1' -c 'CREATE TABLE teste_mcp (id int)'
   ```

### Conexão

Crie `context/database/.env` (fica fora do git) com a conexão, trocando os
valores pelos do seu banco de dev:

```bash
DATABASE_URL=postgres://<usuario_readonly>:<senha_readonly>@<host>:<porta>/<banco>
```

O servidor lê esse arquivo sozinho, então funciona mesmo com o VS Code aberto
pelo menu (sem herdar variáveis do shell).

O servidor só aceita host local (ver [`context/database`](context/database/README.md)).

### Em todos os projetos (recomendado)

```bash
cd ~/Documentos/projects/detro-mcp/context/database
claude mcp add detro-db -s user -- node "$PWD/server.mjs"
```

### Em um projeto só

Crie um `.mcp.json` na raiz do projeto, com o caminho absoluto do servidor:

```json
{
  "mcpServers": {
    "detro-db": {
      "command": "node",
      "args": ["/home/<você>/Documentos/projects/detro-mcp/context/database/server.mjs"]
    }
  }
}
```

Não instale das duas formas ao mesmo tempo, senão o servidor aparece duplicado.

Para conferir, rode `/mcp` no Claude Code: o `detro-db` deve aparecer conectado.
Se aparecer "Connection closed", rode o comando do servidor no terminal para ver
o erro (normalmente é caminho errado, `.env` faltando ou Postgres fora do ar).
