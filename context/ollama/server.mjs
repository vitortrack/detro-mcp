#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const ENV_FILE = new URL(".env", import.meta.url);
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "glm-5.3-flash:cloud";
const LOCAL_MODEL = process.env.OLLAMA_LOCAL_MODEL ?? "qwen2.5-coder:7b";
const isCloud = (model) => /[:-]cloud$/.test(model);
const carriesPersonalData = (argv) => argv.includes("logs");
const NUM_CTX = Number(process.env.OLLAMA_NUM_CTX ?? 32768);
const MAX_CHARS = NUM_CTX * 3 - 4000;
const COMMAND_TIMEOUT_MS = Number(process.env.OLLAMA_MCP_COMMAND_TIMEOUT_MS ?? 600000);
const ALLOWED_COMMANDS = (
  process.env.OLLAMA_MCP_COMMANDS ??
  "npx tsc,npm run,npm test,npx vite,docker logs,docker compose build,docker compose logs,git diff,git log,git status,djinn logs,djinn status"
)
  .split(",")
  .map((c) => c.trim())
  .filter(Boolean);
const SHELL_CHARS = /[;&|<>$`'"\\\n]/;
const SYSTEM =
  "Responda em pt-BR, de forma curta e factual. Use só o que está no texto. " +
  "Cite arquivo:linha quando o texto trouxer. Se não houver o que pedem, diga isso. Não invente.";

const CONTEXT = z
  .string()
  .optional()
  .describe(
    "O que você já sabe e o modelo não: objetivo da tarefa, card, arquivos ou termos do domínio que importam (ex.: 'transport_active = recebe transporte; procuro só erros do módulo school'). Curto: ocupa a janela do modelo.",
  );

const THREAD = z
  .string()
  .optional()
  .describe(
    "Nome da tarefa em andamento (ex.: 'Card-973-review'). Chamadas com o mesmo thread compartilham o context (passe uma vez) e as últimas perguntas e respostas, para o modelo acompanhar o trabalho. Vale até o MCP reiniciar. Depois de um comando com logs, o thread inteiro passa a usar o modelo local.",
  );

const MODEL = z
  .string()
  .optional()
  .describe(
    `Modelo do Ollama (padrão: ${DEFAULT_MODEL}). Modelos terminados em ':cloud' ou '-cloud' mandam o texto para o servidor do Ollama: nunca use com dado pessoal (CPF, endereço, nome de aluno). Log de container sempre usa o modelo local (${LOCAL_MODEL}).`,
  );

async function generate(prompt, model, system = SYSTEM) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model ?? DEFAULT_MODEL,
      stream: false,
      system,
      prompt,
      options: { num_ctx: NUM_CTX, temperature: 0 },
    }),
    signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Ollama respondeu ${res.status}: ${await res.text()}`);
  return (await res.json()).response.trim();
}

function parseCommand(command) {
  if (SHELL_CHARS.test(command)) {
    throw new Error("Comando com caractere de shell (; & | < > $ ` aspas). Passe só o comando e os argumentos, separados por espaço.");
  }
  const argv = command.trim().split(/\s+/);
  const allowed = ALLOWED_COMMANDS.some((prefix) => {
    const p = prefix.split(/\s+/);
    return p.every((part, i) => argv[i] === part);
  });
  if (!allowed) {
    throw new Error(`Comando fora da lista permitida: ${ALLOWED_COMMANDS.join(", ")}. Ajuste OLLAMA_MCP_COMMANDS no .env para liberar outro.`);
  }
  return argv;
}

const runCommand = (argv, cwd) =>
  new Promise((ok) => {
    let output = "";
    const child = spawn(argv[0], argv.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: COMMAND_TIMEOUT_MS });
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("error", (e) => ok({ code: -1, output: `${output}\n${e.message}` }));
    child.on("close", (code, signal) => ok({ code: code ?? signal, output }));
  });

function splitChunks(text, size = MAX_CHARS) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "");
  const chunks = [];
  for (let i = 0; i < clean.length; ) {
    let end = Math.min(i + size, clean.length);
    const nl = clean.lastIndexOf("\n", end - 1);
    if (end < clean.length && nl >= i) end = nl + 1;
    chunks.push(clean.slice(i, end));
    i = end;
  }
  return chunks;
}

const MAX_TURNS = 6;
const threads = new Map();

function openThread(id, context) {
  if (!id) return { context, personal: false, turns: [] };
  if (!threads.has(id)) threads.set(id, { context: undefined, personal: false, turns: [] });
  const thread = threads.get(id);
  if (context) thread.context = context;
  return thread;
}

function remember(thread, question, answer) {
  thread.turns.push({ question, answer });
  thread.turns.splice(0, thread.turns.length - MAX_TURNS);
}

function threadPrefix(thread) {
  const parts = [];
  if (thread.context) parts.push(`--- CONTEXTO DO CLAUDE ---\n${thread.context}\n--- FIM DO CONTEXTO ---`);
  if (thread.turns.length) {
    const turns = thread.turns.map((t) => `Pergunta: ${t.question}\nSua resposta: ${t.answer}`).join("\n\n");
    parts.push(`--- O QUE JÁ CONVERSAMOS NESTA TAREFA ---\n${turns}\n--- FIM DO HISTÓRICO ---`);
  }
  return parts.length ? `${parts.join("\n\n")}\n\n` : "";
}

function pickModel(thread, model, personal) {
  if (personal) thread.personal = true;
  const chosen = model ?? DEFAULT_MODEL;
  return thread.personal && isCloud(chosen) ? LOCAL_MODEL : chosen;
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (err) => ({ content: [{ type: "text", text: `Erro: ${err.message}` }], isError: true });

const server = new McpServer({ name: "detro-ollama", version: "1.0.0" });

server.registerTool(
  "ollama_ask",
  {
    title: "Perguntar ao Ollama",
    description:
      "Manda um prompt a um modelo do Ollama e devolve a resposta. Só economiza contexto quando o prompt é curto e a resposta substitui trabalho seu (rascunho de texto, segunda opinião sobre um trecho que você já tem). Não leia um arquivo grande só para colar aqui: o contexto já foi gasto. Trate a resposta como pista, não como fato.",
    inputSchema: {
      prompt: z.string().describe("O pedido completo"),
      model: MODEL,
      system: z.string().optional().describe("Instrução de sistema; padrão: responder curto, em pt-BR, sem inventar"),
      context: CONTEXT,
      thread: THREAD,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ prompt, model, system, context, thread: id }) => {
    try {
      const thread = openThread(id, context);
      const chosen = pickModel(thread, model, false);
      const answer = await generate(threadPrefix(thread) + prompt, chosen, system);
      remember(thread, prompt, answer);
      return ok(`Modelo: ${chosen}\n${answer}`);
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "run_digest",
  {
    title: "Rodar comando e resumir a saída",
    description:
      "Roda um comando da lista permitida (tsc, build, testes, docker logs, git diff/log/status, djinn) e devolve o código de saída mais a resposta do Ollama à pergunta sobre a saída. A saída bruta não passa por você. Use para build, checagem de tipos, testes e logs longos em que só a conclusão importa. O código de saída é exato; o resumo é pista: confira na fonte (arquivo:linha) antes de corrigir algo com base nele.",
    inputSchema: {
      command: z.string().describe("Comando e argumentos separados por espaço, sem pipe nem redirecionamento. Ex.: 'npx tsc --noEmit -p api', 'docker logs detrorj-worker --tail 3000'"),
      question: z.string().describe("O que extrair da saída. Ex.: 'liste os erros com arquivo:linha e mensagem'"),
      cwd: z.string().optional().describe("Pasta onde rodar, relativa à pasta do projeto (padrão: a raiz do projeto)"),
      context: CONTEXT,
      thread: THREAD,
      model: MODEL,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async ({ command, question, cwd, context, thread: id, model }) => {
    try {
      const argv = parseCommand(command);
      const { code, output } = await runCommand(argv, resolve(process.cwd(), cwd ?? "."));
      const header = `Código de saída: ${code}\n`;
      if (!output.trim()) return ok(`${header}(sem saída)`);
      const thread = openThread(id, context);
      const safeModel = pickModel(thread, model, carriesPersonalData(argv));
      const prefix = threadPrefix(thread);
      const chunks = splitChunks(output, Math.max(2000, MAX_CHARS - prefix.length));
      const answers = [];
      for (const [i, text] of chunks.entries()) {
        const part = chunks.length > 1 ? ` (parte ${i + 1} de ${chunks.length})` : "";
        const answer = await generate(prefix + `--- SAÍDA DE \`${command}\`${part} ---\n${text}\n--- FIM ---\n\nTarefa: ${question}`, safeModel);
        answers.push(chunks.length > 1 ? `Parte ${i + 1}/${chunks.length}:\n${answer}` : answer);
      }
      remember(thread, `${question} (sobre \`${command}\`)`, answers.join("\n\n"));
      return ok(`${header}Modelo: ${safeModel}\n${answers.join("\n\n")}`);
    } catch (e) {
      return fail(e);
    }
  },
);

await server.connect(new StdioServerTransport());
