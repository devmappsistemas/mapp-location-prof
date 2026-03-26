/**
 * Serviço de notificação push para profissional.
 * Espelha exatamente: NotificacaoProfissional.php, Notificacao.php, firebaseEnviarSDK.php.
 *
 * Fluxo (igual firebaseEnviarSDK.php):
 *  1. Monta payload (headers, data: fcmFields, url, dominio, dadosComplementares).
 *  2. Tenta caminho com credenciais SDK: MD sys_cliente por pNomeUrl -> idConfig;
 *     credenciaisSdkFirebase por idConfig e tipo='P' -> projectJson; envia para
 *     servidorrotinacurl.rj.r.appspot.com/firebase/v1/sendPushNotification com
 *     { serviceAccount, data: fcmFields, dadosComplementares? }.
 *  3. Se não houver credenciais ou falhar: fallback POST em appengimemapp com o payload completo.
 *
 * @module services/pushNotificacaoProfissional
 */

import { Entidade } from "../db/Entidade.js";
import { getPoolForDomain, getPoolForMDCLMAPP } from "../db/dbFactory.js";
import { error as displayError, log as displayLog } from "../utils/displayLogWebhook.js";

const APPENGIME_URL = "https://appengimemapp.rj.r.appspot.com/funtions/sendPushNotification";
const SERVIDOR_ROTINA_CURL_URL = "https://servidorrotinacurl.rj.r.appspot.com/firebase/v1/sendPushNotification";
const REQUEST_TIMEOUT_MS = 4000;
const SERVIDOR_ROTINA_CURL_TIMEOUT_MS = 2000;

const CHAVE_FIREBASE_PADRAO =
  "AAAAj9a65ZY:APA91bHfd2gRsO7aklYBFUWLw1S-RicdyxGDhgwddu2bZBdcyVgmeJQZhjLfj7krUX6q9HUBUgaEoe-t7vcuRHxwCCgUcLDBhAIAX3jBZb0ObA1TMdgeR6i7C9nwlY4HYUwe-qCe6bot";
const CHAVE_EDUMOTOBOY =
  "AAAAzDQk4Og:APA91bFcOapYOZQ3oGhlPkYeo-7brQOwgUPGNP__UvE_62LvcFjwnzURhWUpeHpglrWgbHy2aUlxVE5aIg8WZzkizF7TCb1qHpraEI9t3ZtbUEmlBucXELX7J44rGltQlIEEOkkR-oRV";
const CHAVES_POR_DOMINIO = {
  entregas: CHAVE_EDUMOTOBOY,
  sudex: CHAVE_EDUMOTOBOY,
  wimove: CHAVE_EDUMOTOBOY,
  "1001corridas": CHAVE_EDUMOTOBOY,
  ligentregas:
    "AAAAchlU6lM:APA91bGXMwgwGoVgcQfVsMXYf2IalLIVKBfK_4xIiMDUOvGUItxlWN8ZiJbywNINRJfjlxNx7fZFCVuxRBs2WyZw0JNIjOV5Dlh_zBdyOHRp-9evc9ohVbAnq4GIFByXy5qHYsu47SCd",
  ligmototaxi:
    "AAAAchlU6lM:APA91bGXMwgwGoVgcQfVsMXYf2IalLIVKBfK_4xIiMDUOvGUItxlWN8ZiJbywNINRJfjlxNx7fZFCVuxRBs2WyZw0JNIjOV5Dlh_zBdyOHRp-9evc9ohVbAnq4GIFByXy5qHYsu47SCd",
  eliteexpress:
    "AAAAvMJBHYg:APA91bG1vSdQDxnjRyUTeJpfIDqmUtUIOmXiG0WDqJnY_-iBip-QY7LPhOX5WzoNfNzMFSyJqIo3Pil2Jysg1JjsUmxrKTVcFk-98RZROW2ftINihrT2pgMnz-W3LrA-yLcSa1in4CTM",
  motofretista:
    "AAAA90V0ojs:APA91bHQ0lk22PB8WaVcqeYhM6TmWkMUneH8hsX8fnRSkXrm87sHpURmFQyw5KXxSlxof9x9bhq0VOXjzdN0CWDfZ79b8bml84jlV4G95Vy4chB3wifiir2M07d2yLM9SOn7F9L7MlZe",
};

function dominioCorrente(domain) {
  const host = (domain || "").replace(/^www\./, "");
  return host.split(".")[0] || "";
}

// ---------------------------------------------------------------------------
// Busca config e chave (espelha Notificacao.php buscaConfigFIREBASEAPPPROF / buscarConfigProf)
// ---------------------------------------------------------------------------

/**
 * Busca módulo configAppProf2021 (descricaoModulo = 'configAppProf2021').
 * Usado para obter mensagemCliente.firebase.chave.
 */
async function buscarConfigAppProf(pool) {
  const db = { dbClient: pool, dbMD: null };
  const entidade = new Entidade(db);
  const row = await entidade.selectRetornaArrayUnico(
    { id: "", mensagemCliente: "", arrayConfiguracoes: "" },
    "modulos",
    "descricaoModulo = :desc",
    { desc: "configAppProf2021" }
  );
  return row?.id ? row : null;
}

/**
 * Busca chave Firebase do tenant. Ordem igual ao PHP Notificacao::buscaConfigFIREBASEAPPPROF:
 * 1) default por domínio (switch), 2) se configAppProf mensagemCliente.firebase.chave existe retorna ela,
 * 3) senão modulos sigla FIREBASEAPPPROF arrayConfiguracoes.
 */
export async function buscarChaveFirebase(pool, domain) {
  const dominio = dominioCorrente(domain);
  let apiKey = CHAVES_POR_DOMINIO[dominio] || CHAVE_FIREBASE_PADRAO;

  const configAppProf = await buscarConfigAppProf(pool);
  if (configAppProf?.id && configAppProf.mensagemCliente) {
    try {
      const mc = JSON.parse(configAppProf.mensagemCliente);
      if (mc?.firebase?.chave) return mc.firebase.chave;
    } catch { /* ignora */ }
  }

  const db = { dbClient: pool, dbMD: null };
  const entidade = new Entidade(db);
  const row = await entidade.selectRetornaArrayUnico(
    { id: "", arrayConfiguracoes: "" },
    "modulos",
    "sigla = :sigla",
    { sigla: "FIREBASEAPPPROF" }
  );
  if (row?.id && row.arrayConfiguracoes) apiKey = row.arrayConfiguracoes;

  return apiKey;
}

/**
 * Busca profissionais (motoboy: id, nome, versao, registroId). Suporta id único.
 * Espelha NotificacaoProfissional::buscaProfissionais.
 */
export async function buscarProfissionais(pool, idProf) {
  const db = { dbClient: pool, dbMD: null };
  const entidade = new Entidade(db);
  const rows = await entidade.select(
    { id: "", nome: "", versao: "", registroId: "" },
    "motoboy",
    "id = :id",
    { id: String(idProf) }
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * Envia push no mesmo formato que o PHP envia para firebaseEnviarSDK -> sendPushNotificationToFGMSeverAndroidJoao.
 * Payload: { headers, data: { priority, data: msg, registration_ids: [ { registroId, versao } ], notification? }, url, dominio, dadosComplementares? }.
 * O endpoint appengimemapp espera o objeto "data" (fcmFields); o PHP envia o enviar inteiro no exec; no firebaseEnviarSDK ele passa fcmFirebase (que é o enviar) ao Joao, que faz POST com json_encode($fcmFields). Ou seja, POST body = enviar = { headers, data: fcmPayload, url, dominio, dadosComplementares? }.
 */
async function enviarParaAppEngime(enviar) {
  const response = await fetch(APPENGIME_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(enviar),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, body: text };
}

// ---------------------------------------------------------------------------
// Caminho com credenciais SDK (igual firebaseEnviarSDK.php -> servidorrotinacurl)
// ---------------------------------------------------------------------------

/**
 * Busca sys_cliente no MD por pNomeUrl (primeiro segmento do domínio).
 * Retorna { id, idCliente, idConfig } ou null.
 */
async function buscarSysClientePorPnomeUrl(poolMD, pNomeUrl) {
  const db = { dbClient: null, dbMD: poolMD };
  const entidade = new Entidade(db);
  entidade.setConnection("md");
  const row = await entidade.selectRetornaArrayUnico(
    { id: "", idCliente: "", idConfig: "" },
    "sys_cliente",
    "pNomeUrl = :pNomeUrl",
    { pNomeUrl: String(pNomeUrl || "") }
  );
  return row;
}

/**
 * Busca credenciais SDK Firebase no MD: credenciaisSdkFirebase onde idConfig = :idConfig AND tipo = 'P'.
 */
async function buscarCredenciaisSdkFirebase(poolMD, idConfig) {
  const db = { dbClient: null, dbMD: poolMD };
  const entidade = new Entidade(db);
  entidade.setConnection("md");
  const row = await entidade.selectRetornaArrayUnico(
    { id: "", projectName: "", projectCode: "", projectJson: "" },
    "credenciasSdkFirebase",
    "idConfig = :idConfig AND tipo = :tipo",
    { idConfig: Number(idConfig), tipo: "P" }
  );
  return row;
}

/**
 * Normaliza projectJson como no PHP: remove aspas em volta do JSON (str_replace '"{' -> '{', '}"' -> '}').
 * Retorna objeto parseado ou null.
 */
function normalizarProjectJson(projectJson) {
  if (projectJson == null || projectJson === "") return null;
  let str = typeof projectJson === "string" ? projectJson : JSON.stringify(projectJson);
  str = str.replace(/^"\s*\{/, "{").replace(/\}\s*"$/, "}");
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Envia push via servidorrotinacurl (caminho com credenciais SDK).
 * postData = { serviceAccount, data: fcmFields [, dadosComplementares ] }.
 */
async function enviarViaServidorRotinaCurl(serviceAccount, fcmFields, dadosComplementares) {
  const body =
    dadosComplementares != null
      ? { serviceAccount, data: fcmFields, dadosComplementares }
      : { serviceAccount, data: fcmFields };


  const response = await fetch(SERVIDOR_ROTINA_CURL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SERVIDOR_ROTINA_CURL_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* ignorar */
  }
  const success = json && json.success === true;
  return { ok: response.ok, status: response.status, body: text, success };
}

// ---------------------------------------------------------------------------
// Função principal (espelha enviarNotProfissional + firebaseEnviarSDK.send)
// ---------------------------------------------------------------------------

/**
 * Envia notificação push ao profissional, mesmo fluxo do PHP (NotificacaoProfissional::enviarNotProfissional).
 *
 * @param {string} domain - Domínio do tenant
 * @param {number|string} idProf - ID do profissional
 * @param {string} mensagem - Texto da mensagem (ex.: msgProfissinal do painel)
 * @param {Object} [extra] - Dados extras para data (ex.: idServico, idEndereco para cheguei)
 * @returns {Promise<{ success: boolean, detail?: string }>}
 */
export async function enviarPushMensagemProfissional(domain, idProf, mensagem, extra = {}) {
  try {
    const pool = await getPoolForDomain(domain);

    const profissionais = await buscarProfissionais(pool, idProf);
    const comToken = profissionais.filter((p) => p.registroId);
    if (comToken.length === 0) {
      return { success: false, detail: "Profissional sem registroId (token FCM)" };
    }

    const apiKey = await buscarChaveFirebase(pool, domain);

    const registrationIds = comToken.map((p) => ({
      registroId: p.registroId,
      versao: p.versao != null ? Number(p.versao) : 0,
    }));

    const idNot = `${Math.floor(Date.now() / 1000)}${Math.floor(Math.random() * 1e9)}`;
    const identificador = extra.identificador || "BuscarMensagem";
    const nomeProf = comToken[0]?.nome
      ? String(comToken[0].nome).split(/\s+/)[0].toUpperCase() || ""
      : "";
    const versao = comToken[0]?.versao != null ? Number(comToken[0].versao) : 0;
    const canalNotificarCotacao = versao >= 102 ? "channel-cotacao" : "channel-servicos";

    const msg = {
      notAcordar: "N",
      alarmUtil: "S",
      firebase: "S",
      navegar: "",
      idNot,
      id: "46",
      msg: mensagem || "Toque para visualizar",
      idMensagem: "47",
      identificador: "BuscarMensagem",
      ...extra,
    };

    let notAppNovo;
    switch (identificador) {
      case "servico":
        msg.navegar = "servico-execucao";
        msg.destaque = extra.idServico != null ? String(extra.idServico) : "";
        notAppNovo = {
          title: `Temos um novo serviço para você, ${nomeProf}`.trim(),
          body: "Toque para visualizar",
          android_channel_id: "channel-servicos",
          sound: "default",
        };
        break;
      case "cotacao":
        msg.navegar = "servico-cotacao";
        msg.destaque = extra.idServico != null ? String(extra.idServico) : "";
        notAppNovo = {
          title: `Temos uma nova cotação para você, ${nomeProf}`.trim(),
          body: "Toque para visualizar",
          android_channel_id: canalNotificarCotacao,
          sound: "default",
        };
        break;
      case "mensagem":
        msg.navegar = "servico-mensagens";
        msg.idMsg = extra.idMensagem != null ? String(extra.idMensagem) : "47";
        notAppNovo = {
          title: `Você tem uma nova mensagem, ${nomeProf}`.trim(),
          body: extra.mensagem != null ? String(extra.mensagem) : "Toque para visualizar",
          android_channel_id: "channel-mensagens",
          sound: "default",
        };
        break;
      default:
        msg.navegar = msg.navegar || "";
        notAppNovo = {
          title: "Confirmação de chegada",
          body: mensagem && mensagem.length <= 150 ? mensagem : "Toque para visualizar",
          android_channel_id: "channel-servicos",
          sound: "default",
        };
    }

    const fcmFields = {
      priority: "high",
      data: msg,
      registration_ids: registrationIds,
      notification: notAppNovo,
    };


    const dominioParaEnvio = (domain || "").replace(/^www\./, "") || "localhost";
    const dadosComplementares = {
      arrayProfs: comToken.map((p) => ({
        idProf: p.id,
        registroId: p.registroId,
        versao: p.versao != null ? Number(p.versao) : 0,
      })),
      ...extra,
    };
    dadosComplementares.dominioCorrente = dominioParaEnvio;

    const enviar = {
      headers: {
        Authorization: `key=${apiKey}`,
        "Content-Type": "application/json",
      },
      data: fcmFields,
      url: "https://fcm.googleapis.com/fcm/send",
      dominio: `dominio = ${dominioParaEnvio}`,
      dadosComplementares,
    };

    const pNomeUrl = dominioCorrente(domain);

    try {
      const poolMD = await getPoolForMDCLMAPP();
      const sysCliente = await buscarSysClientePorPnomeUrl(poolMD, pNomeUrl);
      if (sysCliente?.idConfig) {
        const credenciais = await buscarCredenciaisSdkFirebase(poolMD, sysCliente.idConfig);
        if (credenciais?.id && credenciais.projectJson) {
          const serviceAccount = normalizarProjectJson(credenciais.projectJson);
          if (serviceAccount) {
            const resultCurl = await enviarViaServidorRotinaCurl(
              serviceAccount,
              fcmFields,
              enviar.dadosComplementares
            );
            if (resultCurl.success) {
              displayLog(
                "[pushNotificacaoProfissional] Push enviado (credenciais SDK / servidorrotinacurl)",
                { domain, idProf, status: resultCurl.status }
              );
              return { success: true, detail: resultCurl.body };
            }
          }
        }
      }
    } catch (err) {
      displayLog("info", "[pushNotificacaoProfissional] Fallback para appengimemapp:", err.message);
    }

    const result = await enviarParaAppEngime(enviar);

    displayLog("info",
      "[pushNotificacaoProfissional] Push enviado (appengimemapp)",
      { domain, idProf, status: result.status, body: result.body }
    );

    const success = result.body === "Sucesso!" || result.ok;
    return { success, detail: result.body };
  } catch (error) {
    displayError("[pushNotificacaoProfissional] Erro ao enviar push:", error.message);
    return { success: false, detail: error.message };
  }
}
