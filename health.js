import express from "express";
import crypto from "crypto";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

/**
 * Health check de liveness.
 *
 * Contrato compartilhado por todos os serviços Node monitorados pelo painel de
 * status (enviarReqMapp -> /status/). Precisa responder rápido e NUNCA tocar em
 * banco, disco quente ou API externa: prova que o processo está de pé, não que
 * as dependências estão saudáveis.
 *
 * SEGURANÇA: a rota exige `Authorization: Bearer <token>`. O mesmo token vale
 * para todos os serviços e é o que o painel envia ao sondar.
 */
const SERVICO = "location-prof";

/**
 * Porta a reportar quando o projeto não lê `process.env.PORT` (alguns têm o
 * número fixo no `app.listen`). Deixe `null` quando a porta vier do ambiente.
 */
const PORTA_PADRAO = null;

/**
 * Token compartilhado do health check.
 *
 * Fica no código de propósito, para o serviço funcionar sem depender de env.
 * Consequência: este valor está versionado em todos os repositórios que usam
 * este arquivo. Para trocá-lo sem mexer no código, defina HEALTH_TOKEN no
 * ambiente do processo — a env tem precedência sobre a constante.
 */
const TOKEN_PADRAO =
  "53bcc63d1819bb6b6631952be226ac8320652e94f7363ccbeadc78e64479c225";

const TAMANHO_MINIMO_TOKEN = 32;

/**
 * Diretório onde este código está publicado no servidor.
 *
 * Derivado do próprio arquivo, não de `process.cwd()`: o PM2 pode iniciar o
 * processo a partir de outro diretório, e aí o cwd mentiria. Como o health.js
 * fica na raiz do projeto, a pasta dele é a pasta do deploy — e acompanha
 * sozinha qualquer mudança de caminho no servidor.
 */
const caminho = path.dirname(fileURLToPath(import.meta.url));

let versao = "desconhecida";
try {
  const pkg = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8")
  );
  versao = pkg.version || versao;
} catch {
  // package.json ausente ou inválido não pode derrubar o health check
}

/**
 * IP externo da máquina.
 *
 * A VM não enxerga o próprio IP público na interface (fica no NAT da nuvem),
 * então é preciso perguntar. O metadata server do GCP responde em link-local,
 * sem sair da máquina e em milissegundos.
 *
 * Resolvido no boot e guardado em memória: a rota /health não pode fazer I/O
 * de rede a cada chamada. Reconsultado a cada 6h porque IP efêmero pode mudar
 * num restart da instância.
 */
const METADATA_GCP =
  "http://metadata.google.internal/computeMetadata/v1/instance/" +
  "network-interfaces/0/access-configs/0/external-ip";

let ipExterno = null;

function pareceIPv4(valor) {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(valor);
}

async function descobrirIpExterno() {
  try {
    const resp = await fetch(METADATA_GCP, {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(2000),
    });
    if (resp.ok) {
      const texto = (await resp.text()).trim();
      if (pareceIPv4(texto)) return texto;
    }
  } catch {
    // fora do GCP, ou metadata bloqueado: cai no fallback opcional
  }

  // Fallback para máquinas fora do GCP. Desligado por padrão: é uma chamada a
  // um terceiro. Ative apontando HEALTH_IP_EXTERNO_URL para um serviço que
  // devolva o IP em texto puro (ex.: https://api.ipify.org).
  const url = process.env.HEALTH_IP_EXTERNO_URL;
  if (!url) return null;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const texto = (await resp.text()).trim();
      if (pareceIPv4(texto)) return texto;
    }
  } catch {
    // sem internet ou serviço fora: segue sem o dado
  }

  return null;
}

function atualizarIpExterno() {
  descobrirIpExterno().then((ip) => {
    ipExterno = ip;
  });
}

atualizarIpExterno();
// unref: este timer não pode segurar o processo vivo no shutdown.
setInterval(atualizarIpExterno, 6 * 60 * 60 * 1000).unref();

function tokenEsperado() {
  const daEnv = process.env.HEALTH_TOKEN;
  if (typeof daEnv === "string" && daEnv.trim()) return daEnv.trim();
  return TOKEN_PADRAO;
}

/**
 * Comparação em tempo constante. Compara os hashes para que o tamanho do token
 * esperado não vaze pela duração da chamada.
 */
function conferem(a, b) {
  const ha = crypto.createHash("sha256").update(Buffer.from(a, "utf8")).digest();
  const hb = crypto.createHash("sha256").update(Buffer.from(b, "utf8")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function tokenDaRequisicao(req) {
  const cabecalho =
    req.header("Authorization") || req.header("authorization") || "";
  const bearer = /^\s*Bearer\s+(.+?)\s*$/i.exec(cabecalho);
  if (bearer) return bearer[1];

  const apiKey = req.header("X-API-Key") || req.header("x-api-key") || "";
  return apiKey ? String(apiKey).trim() : "";
}

const router = express.Router();

router.get("/health", (req, res) => {
  const esperado = tokenEsperado();

  // Códigos estáveis: o painel usa para distinguir "serviço mal configurado"
  // de "serviço fora do ar" e não disparar alarme falso de indisponibilidade.
  if (esperado.length < TAMANHO_MINIMO_TOKEN) {
    return res.status(503).json({
      erro: "Health check não configurado",
      codigo: "HEALTH_TOKEN_AUSENTE",
    });
  }

  const recebido = tokenDaRequisicao(req);
  if (!recebido || !conferem(recebido, esperado)) {
    return res.status(401).json({
      erro: "Credencial inválida ou ausente",
      codigo: "HEALTH_TOKEN_INVALIDO",
    });
  }

  res.json({
    status: "ok",
    servico: SERVICO,
    versao,
    // Identidade real em execução, não o que está anotado no registry do
    // painel. O PM2 injeta o nome do processo em process.env.name; se alguém
    // renomear o processo ou trocar a porta, o painel acusa a divergência.
    pm2: process.env.name || null,
    porta: process.env.PORT ? Number(process.env.PORT) : PORTA_PADRAO,
    // Em qual máquina este processo roda. Sem isso não dá para saber se dois
    // serviços na mesma porta são um conflito ou hosts diferentes.
    host: os.hostname(),
    ipExterno,
    caminho,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
