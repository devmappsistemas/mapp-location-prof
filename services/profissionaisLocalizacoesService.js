import pLimit from "p-limit";
import { getPoolForDomain } from "../db/dbFactory.js";
import { log as displayLog } from "../utils/displayLogWebhook.js";
import { error as displayError } from "../utils/displayLogWebhook.js";
import { processarChegueiEndereco, buscarConfigChegueiCompletaPorDomain } from "./chegueiEnderecoService.js";

/** Limite de processamentos simultâneos por domínio. Configurável via env. */
const CONCURRENCY_PER_DOMAIN = Math.max(1, parseInt(process.env.PROFISSIONAIS_LOCALIZACOES_CONCURRENCY, 10) || 10);

/** Tamanho do lote de domínios processados em paralelo. Configurável via env. */
const DOMAINS_BATCH_SIZE = Math.max(1, parseInt(process.env.PROFISSIONAIS_LOCALIZACOES_BATCH_SIZE, 10) || 10);

/** Indica se há processamento em andamento (apenas 1 por vez). */
let processando = false;

/** Um limitador (p-limit) por domínio: no máximo N tarefas por domínio ao mesmo tempo. */
const limitersByDomain = new Map();

function getLimitForDomain(domain) {
  if (!limitersByDomain.has(domain)) {
    limitersByDomain.set(domain, pLimit(CONCURRENCY_PER_DOMAIN));
  }
  return limitersByDomain.get(domain);
}

/**
 * Processa um único domínio: valida payload e obtém pool (sem UPDATE em tabela por enquanto).
 * @param {{ domain?: string, fullDomain?: string, profs: Array }} domainItem
 * @returns {Promise<{ domain: string, success: boolean, processed: number, error?: string }>}
 */
export async function processarDominio(domainItem) {
  const fullDomain = domainItem.fullDomain || domainItem.domain;
  const domainLabel = fullDomain || "(sem domínio)";

  if (!fullDomain || typeof fullDomain !== "string" || !fullDomain.trim()) {
    displayError("[profissionaisLocalizacoes] Domínio inválido no item", { domainItem: !!domainItem });
    return { domain: domainLabel, success: false, processed: 0, error: "Domínio inválido" };
  }

  const profs = Array.isArray(domainItem.profs) ? domainItem.profs : [];
  if (profs.length === 0) {
    displayLog("info", "[profissionaisLocalizacoes] Nenhum profissional para processar", { domain: fullDomain });
    return { domain: fullDomain, success: true, processed: 0 };
  }

  try {
    const pool = await getPoolForDomain(fullDomain.trim());
    if (!pool) {
      return { domain: fullDomain, success: false, processed: 0, error: "Pool não disponível" };
    }
  } catch (err) {
    displayError(`[profissionaisLocalizacoes] Erro ao obter pool para domínio ${fullDomain}:`, err.message);
    return { domain: fullDomain, success: false, processed: 0, error: err.message };
  }

  const domainTrim = fullDomain.trim();

  const { ativo, config } = await buscarConfigChegueiCompletaPorDomain(domainTrim);
  if (!ativo) {
    const profsComLocalizacao = profs.filter(
      (p) =>
        (p.id ?? p.idProf) != null &&
        (p.la ?? p.last_location?.lat ?? p.lat) != null &&
        (p.lo ?? p.last_location?.lon ?? p.last_location?.lng ?? p.lon) != null
    ).length;
    displayLog("info", "[profissionaisLocalizacoes] Módulo cheguei inativo para domínio, pulando profissionais", {
      domain: fullDomain,
      profsPulados: profsComLocalizacao,
    });
    return { domain: fullDomain, success: true, processed: 0 };
  }

  const limit = getLimitForDomain(domainTrim);
  const chegueiPromises = profs.map((prof) => {
    const idProf = prof.id ?? prof.idProf;
    const la = prof.la ?? prof.last_location?.lat ?? prof.lat;
    const lo = prof.lo ?? prof.last_location?.lon ?? prof.last_location?.lng ?? prof.lon;
    if (idProf == null || la == null || lo == null) return Promise.resolve(0);
    return limit(async () => {
      try {
        await processarChegueiEndereco({ domain: domainTrim, idProf, la, lo, configPreCarregada: config });
        return 1;
      } catch (err) {
        displayError(`[profissionaisLocalizacoes] Erro ao processar cheguei para domínio=${domainTrim} idProf=${idProf}:`, err.message);
        return 0;
      }
    });
  });
  const resultados = await Promise.all(chegueiPromises);
  const chegueiChamados = resultados.reduce((acc, n) => acc + n, 0);

  displayLog("info", "[profissionaisLocalizacoes] Domínio processado (cheguei chamado para profissionais com localização)", {
    domain: fullDomain,
    profsCount: profs.length,
    chegueiChamados
  });
  return { domain: fullDomain, success: true, processed: profs.length };
}

/**
 * Processa um batch de domínios em lotes (evita sobrecarga do Event Loop).
 * @param {{ domains: Array }} payload
 * @returns {Promise<void>}
 */
async function processarBatch(payload) {
  const domains = Array.isArray(payload?.domains) ? payload.domains : [];
  if (domains.length === 0) {
    displayLog("info", "[profissionaisLocalizacoes] Nenhum domínio para processar");
    return;
  }

  displayLog("info", "[profissionaisLocalizacoes] Iniciando processamento em background em lotes", {
    domainsCount: domains.length,
    batchSize: DOMAINS_BATCH_SIZE,
  });

  const results = [];
  for (let i = 0; i < domains.length; i += DOMAINS_BATCH_SIZE) {
    const lote = domains.slice(i, i + DOMAINS_BATCH_SIZE);
    const batchResults = await Promise.all(lote.map((item) => processarDominio(item)));
    results.push(...batchResults);
  }

  const ok = results.filter((r) => r.success).length;
  const fail = results.filter((r) => !r.success).length;
  displayLog("info", "[profissionaisLocalizacoes] Processamento em background concluído", {
    total: results.length,
    ok,
    fail,
    results: results.map((r) => ({ domain: r.domain, success: r.success, processed: r.processed, error: r.error })),
  });
}

/**
 * Processa apenas se não houver outro processamento em andamento.
 * Se ocupado, retorna { disponivel: false } — não processa para evitar sobrecarga.
 * @param {{ domains: Array }} payload
 * @returns {{ disponivel: boolean }}
 */
export function processarSeDisponivel(payload) {
  const domains = Array.isArray(payload?.domains) ? payload.domains : [];
  if (domains.length === 0) return { disponivel: false };

  if (processando) {
    return { disponivel: false };
  }

  processando = true;
  processarBatch(payload)
    .catch((err) => {
      displayError("[profissionaisLocalizacoes] Erro no processamento em background:", err.message);
    })
    .finally(() => {
      processando = false;
    });

  return { disponivel: true };
}
