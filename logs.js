import express from "express";
import crypto from "crypto";
import { open } from "fs/promises";

/**
 * Leitura das últimas linhas do log deste processo.
 *
 * Os caminhos vêm do PM2 (`pm_out_log_path` / `pm_err_log_path`), não de
 * configuração nem de parâmetro da requisição. Isso resolve duas coisas de uma
 * vez: o serviço sempre aponta para o log correto mesmo se o nome do processo
 * ou o diretório mudarem, e não existe caminho controlável pelo cliente — um
 * endpoint que aceitasse `?arquivo=` seria leitura arbitrária do servidor.
 *
 * Autenticação: mesmo token do /health. Vale lembrar que log de produção é
 * bem mais sensível que uptime — costuma conter corpo de requisição e dado de
 * cliente. Defina LOGS_TOKEN no ambiente para usar um segredo próprio aqui.
 */
const SERVICO = "location-prof";

const TOKEN_PADRAO =
  "53bcc63d1819bb6b6631952be226ac8320652e94f7363ccbeadc78e64479c225";

const TAMANHO_MINIMO_TOKEN = 32;

/** Teto de linhas por requisição. */
const MAX_LINHAS = 5000;

/** Teto de bytes lidos do fim do arquivo, para uma linha gigante não estourar. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Tamanho do bloco na leitura de trás para frente. */
const BLOCO = 64 * 1024;

/** Só estes dois arquivos, resolvidos pelo PM2 em tempo de execução. */
const ARQUIVOS = {
  out: () => process.env.pm_out_log_path || null,
  error: () => process.env.pm_err_log_path || null,
};

function tokenEsperado() {
  const proprio = process.env.LOGS_TOKEN;
  if (typeof proprio === "string" && proprio.trim()) return proprio.trim();

  const doHealth = process.env.HEALTH_TOKEN;
  if (typeof doHealth === "string" && doHealth.trim()) return doHealth.trim();

  return TOKEN_PADRAO;
}

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

/**
 * Lê as últimas `n` linhas sem carregar o arquivo na memória.
 *
 * Caminha do fim para o começo em blocos, contando quebras de linha, e para
 * assim que junta o suficiente. Num log de 450MB isso lê ~700KB e leva ~12ms;
 * um readFile traria os 450MB e derrubaria o processo.
 */
async function ultimasLinhas(caminho, n, ate = null) {
  const fh = await open(caminho, "r");
  try {
    const { size, mtime } = await fh.stat();

    // `ate` é o cursor da paginação: byte onde a página anterior começou.
    // Ler "as n linhas que terminam em `ate`" é o que permite voltar no
    // arquivo sem reprocessar tudo desde o começo.
    const fim = ate === null ? size : Math.max(0, Math.min(ate, size));

    let pos = fim;
    let blocos = [];
    let quebras = 0;
    let lidos = 0;

    while (pos > 0 && quebras <= n && lidos < MAX_BYTES) {
      const tamanho = Math.min(BLOCO, pos);
      pos -= tamanho;

      const buf = Buffer.alloc(tamanho);
      await fh.read(buf, 0, tamanho, pos);
      blocos.unshift(buf);
      lidos += tamanho;

      for (const b of buf) if (b === 10) quebras++;
    }

    const texto = Buffer.concat(blocos).toString("utf8");
    const todas = texto.split("\n");

    // A primeira linha do trecho pode estar cortada ao meio (o bloco começou
    // no meio dela); descarta quando não estamos no início do arquivo.
    const parcial = pos > 0 && todas.length ? todas.shift() : null;

    // O trecho termina em \n, então o split deixa um "" no fim. Tem que sair
    // ANTES do corte: senão ele ocupa uma das n posições e volta n-1 linhas.
    if (todas.length && todas[todas.length - 1] === "") todas.pop();

    const linhas = todas.slice(-n);

    // Byte onde a primeira linha devolvida começa. É o cursor que o cliente
    // manda de volta como `ate` para pegar a página anterior.
    const descartadas = todas.slice(0, todas.length - linhas.length);
    let inicio = pos;
    if (parcial !== null) inicio += Buffer.byteLength(parcial, "utf8") + 1;
    for (const l of descartadas) inicio += Buffer.byteLength(l, "utf8") + 1;

    return {
      linhas,
      tamanhoBytes: size,
      modificadoEm: mtime.toISOString(),
      bytesLidos: lidos,
      inicio,
      ate: fim,
      // Ainda existe conteúdo antes deste trecho para paginar.
      temMais: inicio > 0,
      truncado: lidos >= MAX_BYTES && quebras <= n,
    };
  } finally {
    await fh.close();
  }
}

const router = express.Router();

router.get("/logs", async (req, res) => {
  const esperado = tokenEsperado();

  if (esperado.length < TAMANHO_MINIMO_TOKEN) {
    return res.status(503).json({
      erro: "Leitura de logs não configurada",
      codigo: "LOGS_TOKEN_AUSENTE",
    });
  }

  const recebido = tokenDaRequisicao(req);
  if (!recebido || !conferem(recebido, esperado)) {
    return res.status(401).json({
      erro: "Credencial inválida ou ausente",
      codigo: "HEALTH_TOKEN_INVALIDO",
    });
  }

  const tipo = req.query.tipo === "error" ? "error" : "out";
  const linhasPedidas = Math.min(
    MAX_LINHAS,
    Math.max(1, parseInt(req.query.linhas, 10) || 500)
  );

  const caminho = ARQUIVOS[tipo]();
  if (!caminho) {
    return res.status(503).json({
      erro: "Caminho do log não informado pelo PM2",
      detalhe:
        "O processo não foi iniciado pelo PM2, ou o PM2 não expôs pm_out_log_path/pm_err_log_path.",
      codigo: "LOG_CAMINHO_INDISPONIVEL",
      servico: SERVICO,
      tipo,
    });
  }

  // Cursor da paginação. Ausente = página mais recente (fim do arquivo).
  const ateBruto = parseInt(req.query.ate, 10);
  const ate = Number.isFinite(ateBruto) && ateBruto >= 0 ? ateBruto : null;

  try {
    const r = await ultimasLinhas(caminho, linhasPedidas, ate);

    res.json({
      servico: SERVICO,
      tipo,
      arquivo: caminho,
      tamanhoBytes: r.tamanhoBytes,
      modificadoEm: r.modificadoEm,
      linhasPedidas,
      linhasRetornadas: r.linhas.length,
      bytesLidos: r.bytesLidos,
      inicio: r.inicio,
      ate: r.ate,
      temMais: r.temMais,
      truncado: r.truncado,
      linhas: r.linhas,
    });
  } catch (err) {
    const ausente = err?.code === "ENOENT";
    res.status(ausente ? 404 : 500).json({
      erro: ausente
        ? "Arquivo de log não existe no servidor"
        : `Falha ao ler o log: ${err.message}`,
      codigo: ausente ? "LOG_INEXISTENTE" : "LOG_ERRO_LEITURA",
      arquivo: caminho,
    });
  }
});

export default router;
