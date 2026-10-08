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

Crie o usuário somente leitura no banco de dev (uma vez só): veja o cabeçalho de
[`create-readonly-role.sql`](context/database/create-readonly-role.sql).

Defina a conexão no seu shell (`~/.bashrc` ou `~/.zshrc`), trocando os valores
pelos do seu banco de dev:

```bash
export DETRO_DB_URL="postgres://<usuario_readonly>:<senha_readonly>@<host>:<porta>/<banco>"
```

O servidor só aceita host local (ver [`context/database`](context/database/README.md)).

### Em todos os projetos (recomendado)

```bash
cd ~/Documentos/projects/detro-mcp/context/database
claude mcp add detro-db -s user -e 'DATABASE_URL=${DETRO_DB_URL}' -- node "$PWD/server.mjs"
```

### Em um projeto só

Crie um `.mcp.json` na raiz do projeto, com o caminho absoluto do servidor:

```json
{
  "mcpServers": {
    "detro-db": {
      "command": "node",
      "args": ["/home/<você>/Documentos/projects/detro-mcp/context/database/server.mjs"],
      "env": {
        "DATABASE_URL": "${DETRO_DB_URL}"
      }
    }
  }
}
```

Não instale das duas formas ao mesmo tempo, senão o servidor aparece duplicado.

Para conferir, rode `/mcp` no Claude Code: o `detro-db` deve aparecer conectado.
Se aparecer "Connection closed", rode o comando do servidor no terminal para ver
o erro (normalmente é caminho errado ou Postgres fora do ar).
