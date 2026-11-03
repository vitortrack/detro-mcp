# detro-ollama — MCP que passa leitura e resumo ao Ollama

O Claude Code gasta contexto com tudo o que lê. Build, `tsc`, testes e logs de
container geram milhares de linhas, e quase sempre só a conclusão importa ("tem
erro?", "em que arquivo:linha?"). Este MCP faz a leitura fora do Claude: roda o
comando aqui, entrega a saída a um modelo do Ollama e devolve ao Claude só o
código de saída e a resposta curta.

| Ferramenta | Para quê |
|---|---|
| `run_digest` | roda um comando da lista permitida e responde uma pergunta sobre a saída |
| `ollama_ask` | manda um prompt livre a um modelo do Ollama (rascunho, segunda opinião) |

## Divisão de trabalho com o Claude

```
Claude ──run_digest("npx tsc --noEmit -p api", "liste os erros com arquivo:linha")──▶ detro-ollama
                                                                                       │ roda o comando (sem shell)
                                                                                       │ saída bruta ──▶ Ollama
Claude ◀── "Código de saída: 2 · Modelo: … · api/src/x.ts:42 TS2345 …" ◀──────────────┘
```

- **O Ollama lê e resume. O Claude decide.** O código de saída vem direto do
  processo e é exato. O resumo é uma pista: antes de corrigir, o Claude confere
  na fonte (`arquivo:linha`).
- A saída bruta não passa pelo Claude. Num teste, um log de 75 KB do worker
  voltou como 3 linhas.
- `ollama_ask` só economiza quando o prompt é curto. Ler um arquivo grande para
  colar no prompt já gasta o contexto que se queria poupar.
- O modelo responde em pt-BR, com temperatura 0, usando só o texto recebido, e
  avisa quando o que foi pedido não está nele.

## Proteções
1. **Lista de comandos permitidos.** Por padrão: `npx tsc`, `npm run`,
   `npm test`, `npx vite`, `docker logs`, `docker compose build`,
   `docker compose logs`, `git diff`, `git log`, `git status`, `djinn`. Qualquer
   outro comando é recusado.
2. **Sem shell.** O comando roda via `spawn` com os argumentos separados. Um
   comando com `; & | < > $` crase, aspas ou barra invertida é recusado antes de rodar.
3. **Dado pessoal fica na máquina.** Modelos `:cloud`/`-cloud` mandam o texto ao
   servidor do Ollama. `docker logs` pode ter CPF, endereço e nome de aluno, então
   sempre roda no modelo local, seja qual for o modelo pedido. A resposta informa
   o modelo usado. Fora disso, não use cloud com resultado de banco nem com dado
   pessoal (LGPD).
4. **Saída cortada pelo começo.** Quando a saída passa da janela do modelo, ele
   lê só o final (onde costumam estar o erro e o resumo), e a resposta avisa do corte.
5. **Timeout** no comando e na chamada ao Ollama (padrão 10 min).

## Instalação
Requer o [Ollama](https://ollama.com) rodando em `127.0.0.1:11434`, logado na
conta para o modelo cloud padrão (`ollama signin`), e o modelo local baixado:

```bash
ollama pull qwen2.5-coder:7b
cd ~/Documentos/projects/detro-mcp/context/ollama && npm install
claude mcp add detro-ollama -s user -- node "$PWD/server.mjs"
```

Confira com `/mcp`. O `cwd` do `run_digest` é relativo à pasta em que o Claude
Code foi aberto (a raiz do projeto).

Opcional, em `.env` nesta pasta:

```bash
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=glm-5.3-flash:cloud      # modelo padrão
OLLAMA_LOCAL_MODEL=qwen2.5-coder:7b   # usado em docker logs
OLLAMA_NUM_CTX=32768                  # janela do modelo; define o corte da saída
OLLAMA_MCP_COMMANDS=npx tsc,npm run,docker logs   # substitui a lista permitida
OLLAMA_MCP_COMMAND_TIMEOUT_MS=600000
```

## Exemplos
| Situação | Chamada |
|---|---|
| Erros de tipo | `run_digest("npx tsc --noEmit -p api", "liste os erros com arquivo:linha e mensagem")` |
| Log do worker | `run_digest("docker logs detrorj-worker --tail 3000", "há erro ou exceção? cite a linha")` |
| Build do web | `run_digest("docker compose build web", "o build passou? se não, qual o primeiro erro?")` |
| O que mudou | `run_digest("git diff --stat", "quais áreas do código foram alteradas?")` |
