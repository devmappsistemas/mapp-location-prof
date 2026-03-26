/**
 * Serviço do "cheguei no endereço" — espelha mobileNovo1/v3.0 chegueiEndereco.php.
 *
 * Assinatura: processarChegueiEndereco({ domain, idProf, la, lo }).
 * Serviços e endereços são descobertos internamente (serviços em execução = status = 'A').
 *
 * Gates (em ordem):
 *  1. Validar body obrigatório (domain, idProf, la, lo)
 *  2. Modo ativo (appConfig.ativo = 'S')
 *  3. Cheguei automático (chequeiAutomatico = 'S')
 *  4. Ativado e permite = 'S'
 *  5. Validar profissional existe e ativo = 'S'
 *  6. Listar serviços com status = 'A'; para cada serviço, enderecoServico sem chegada
 *  7. Por par (serviço, endereço): distância ≤ raio → push ou UPDATE. Se confirmarProfissional = 'S', envia uma única notificação mesmo com vários endereços no raio.
 *
 * @module services/chegueiEnderecoService
 */

import { Entidade } from "../db/Entidade.js";
import { getPoolForDomain } from "../db/dbFactory.js";
import { ConfigModuloClientes } from "../controller/modulos/ConfigModuloClientes.js";
import {
  ControleLogRg,
  RGLOG_DESC_PUSH_CONFIRMACAO_CHEGUEI,
  RGLOG_MENU_CHEGUEI_AUTO,
} from "../controller/ControleLogRg.js";
import { calcularDistanciaMetros } from "../utils/geo/calcularDistancia.js";
import {
  getDateTimeMySQLPorFuso,
  getDateTimeMySQLMenosSegundosPorFuso,
} from "../utils/fusoHorario.js";
import { enviarPushMensagemProfissional } from "./pushNotificacaoProfissional.js";
import { error as displayError, log as displayLog } from "../utils/displayLogWebhook.js";

/**
 * @typedef {Object} ChegueiResult
 * @property {number} status - HTTP status code
 * @property {Object} body   - Corpo da resposta JSON
 */

/**
 * Verifica se o módulo cheguei está ativo para o domínio (gates 2, 3 e 4).
 * @param {string} domain
 * @returns {Promise<boolean>}
 */
export async function moduloChegueiAtivoParaDomain(domain) {
  const result = await buscarConfigChegueiCompletaPorDomain(domain);
  return result.ativo;
}

/**
 * Busca configuração completa do cheguei para o domínio (pool, msgConfigApp, moduloAppConfig, fusoHorario).
 * Retorna { ativo: true, config } quando módulo ativo, ou { ativo: false } quando inativo/erro.
 * Usar 1x por domínio e passar config para processarChegueiEndereco (evita N buscas por profissional).
 *
 * @param {string} domain
 * @returns {Promise<{ ativo: boolean, config?: { pool, msgConfigApp, moduloAppConfig, fusoHorario } }>}
 */
export async function buscarConfigChegueiCompletaPorDomain(domain) {
  try {
    const pool = await getPoolForDomain(domain);
    if (!pool) return { ativo: false };

    const configDb = await ConfigModuloClientes.buscarConfigPorDomain(domain);
    const { msgConfigApp, moduloAppConfig } = configDb;

    if (!moduloAppConfig || moduloAppConfig.ativo !== "S") return { ativo: false };
    if (!msgConfigApp || msgConfigApp.chequeiAutomatico !== "S") return { ativo: false };
    if (msgConfigApp.ativado !== "S" ) return { ativo: false };

    let fusoHorario = "America/Sao_Paulo";
    try {
      fusoHorario = await ConfigModuloClientes.buscarFusoHorarioPorDomain(domain);
    } catch (err) {
      displayError("[chegueiEndereco] Erro ao obter fuso horário:", err.message);
    }

    return {
      ativo: true,
      config: { pool, msgConfigApp, moduloAppConfig, fusoHorario },
    };
  } catch (err) {
    displayError("[chegueiEndereco] buscarConfigChegueiCompletaPorDomain:", err.message);
    return { ativo: false };
  }
}

/**
 * Processa o cheguei-endereço: recebe domain, idProf, la, lo; descobre serviços (status = 'A') e endereços sem chegada; aplica distância/push ou UPDATE por par.
 *
 * @param {Object} params
 * @param {string} params.domain
 * @param {number|string} params.idProf
 * @param {number|string} params.la - latitude do profissional
 * @param {number|string} params.lo - longitude do profissional
 * @param {Object} [params.configPreCarregada] - Quando fornecido, evita buscas de config (pool, msgConfigApp, moduloAppConfig, fusoHorario). Usar quando processando vários profissionais do mesmo domínio.
 * @returns {Promise<ChegueiResult>}
 */
export async function processarChegueiEndereco({ domain, idProf, la, lo, configPreCarregada }) {
  // ---- Gate 1: Validar campos obrigatórios --------------------------------
  if (!domain || !idProf || la == null || lo == null) {
    return {
      status: 400,
      body: {
        error: "Campos obrigatórios ausentes",
        message: "Informe domain, idProf, la e lo.",
      },
    };
  }

  let pool, msgConfigApp, moduloAppConfig, fusoHorario;

  if (configPreCarregada) {
    ({ pool, msgConfigApp, moduloAppConfig, fusoHorario } = configPreCarregada);
  } else {
    // ---- Obter pool e configs -----------------------------------------------
    try {
      pool = await getPoolForDomain(domain);
      const config = await ConfigModuloClientes.buscarConfigPorDomain(domain);
      msgConfigApp = config.msgConfigApp;
      moduloAppConfig = config.moduloAppConfig;
    } catch (err) {
      displayError("[chegueiEndereco] Erro ao obter config:", err.message);
      return { status: 500, body: { error: "Erro interno", message: err.message } };
    }

    const logControllerTemp = new ControleLogRg({ dbClient: pool, dbMD: null });

    // ---- Fuso horário do cliente -------
    fusoHorario = "America/Sao_Paulo";
    try {
      fusoHorario = await ConfigModuloClientes.buscarFusoHorarioPorDomain(domain);
    } catch (err) {
      displayError("Erro ao obter fuso horário, usando America/Sao_Paulo:", err.message);
      await logControllerTemp.inserirLog({
        idFuncionario: 1000,
        descricao: "Erro ao obter fuso horário",
        data: getDateTimeMySQLPorFuso(fusoHorario),
        menu: "Cheguei-Automatico",
        texto: err.message,
        idServico: null,
        idProf,
      });
    }

    // ---- Gate 2, 3, 4 ------------------------------------
    if (!moduloAppConfig || moduloAppConfig.ativo !== "S") {
      return { status: 200, body: { success: false, message: "Modulo de cheguei no endereço desativado" } };
    }
    if (!msgConfigApp || msgConfigApp.chequeiAutomatico !== "S") {
      await logControllerTemp.inserirLog({
        idFuncionario: 1000,
        descricao: "A opção cheguei automático está desativada",
        data: getDateTimeMySQLPorFuso(fusoHorario),
        menu: "Cheguei-Automatico",
        texto: "chequeiAutomatico != S",
        idServico: null,
        idProf,
      });
      return { status: 200, body: { success: false, message: "A opção cheguei automático está desativada" } };
    }
    if (msgConfigApp.ativado !== "S" || msgConfigApp.permite !== "S") {
      await logControllerTemp.inserirLog({
        idFuncionario: 1000,
        descricao: "Configuração não permite registro de cheguei",
        data: getDateTimeMySQLPorFuso(fusoHorario),
        menu: "Cheguei-Automatico",
        texto: "ativado ou permite != S",
        idServico: null,
        idProf,
      });
      return { status: 200, body: { success: false, message: "Configuração não permite registro de cheguei" } };
    }
  }

  const logController = new ControleLogRg({ dbClient: pool, dbMD: null });
  const entidade = new Entidade({ dbClient: pool, dbMD: null });

  // ---- Gate 5: Validar profissional (existe e ativo = 'S') -----------------
  try {
    const prof = await entidade.selectRetornaArrayUnico(
      { id: "", status: "", ativo: "" },
      "motoboy",
      "id = :id AND ativo = :ativo",
      { id: idProf, ativo: "s" }
    );
    if (!prof?.id || Number(prof.id) <= 0) {
      return {
        status: 400,
        body: { error: "Profissional inválido", message: "Profissional não encontrado ou não está ativo." },
      };
    }
  } catch (err) {
    displayError("[chegueiEndereco] Erro ao validar profissional:", err.message);
    await logController.inserirLog({
      idFuncionario: 1000,
      descricao: "Erro ao validar profissional",
      data: getDateTimeMySQLPorFuso(fusoHorario),
      menu: "Cheguei-Automatico",
      texto: err.message,
      idServico: null,
      idProf,
    });
    return { status: 500, body: { error: "Erro interno", message: err.message } };
  }

  // ---- Listar serviços em execução (status = 'A') ------------------------
  let servicos = [];
  try {
    servicos = await entidade.select(
      { id: "" },
      "servico",
      "idMotoboy = :idMotoboy AND status = :status",
      { idMotoboy: idProf, status: "A" }
    );
    if (!Array.isArray(servicos)) servicos = [];
  } catch (err) {
    displayError("[chegueiEndereco] Erro ao listar serviços:", err.message);
    await logController.inserirLog({
      idFuncionario: 1000,
      descricao: "Erro ao listar serviços",
      data: getDateTimeMySQLPorFuso(fusoHorario),
      menu: "Cheguei-Automatico",
      texto: err.message,
      idServico: null,
      idProf,
    });
    return { status: 500, body: { error: "Erro interno", message: err.message } };
  }

  const processados = [];
  /** Quando confirmarProfissional === 'S', acumula endereços dentro do raio para notificar uma única vez. */
  const pendentesPush = [];
  const raioConfigurado = parseFloat(msgConfigApp.raioChegadaPonto) || 300;
  const laBody = parseFloat(la);
  const loBody = parseFloat(lo);

  displayLog("info", "[chegueiEndereco] servicos", servicos);
  for (const servico of servicos) {
    const idServico = servico?.id;
    if (!idServico) continue;

    displayLog("info", "[chegueiEndereco] idServico", idServico);
    // Listar enderecoServico sem chegada para este serviço (la/lo da tabela endereco)
    let enderecos = [];
    try {
      enderecos = await entidade.select(
        [
          "enderecoServico.idEndereco AS idEndereco",
          "endereco.la AS la",
          "endereco.lo AS lo",
          "enderecoServico.chegada AS chegada",
        ],
        "enderecoServico INNER JOIN endereco ON endereco.id = enderecoServico.idEndereco",
        "enderecoServico.idServico = :idServico AND (enderecoServico.chegada IS NULL OR enderecoServico.chegada = '0000-00-00 00:00:00')",
        { idServico }
      );
      displayLog("info", "[chegueiEndereco] enderecos", enderecos);
      if (!Array.isArray(enderecos)) enderecos = [];
    } catch (err) {
      displayError("[chegueiEndereco] Erro ao listar enderecoServico:", err.message);
      await logController.inserirLog({
        idFuncionario: 1000,
        descricao: "Erro ao listar enderecoServico",
        data: getDateTimeMySQLPorFuso(fusoHorario),
        menu: "Cheguei-Automatico",
        texto: err.message,
        idServico,
        idProf,
      });
      continue;
    }

    for (const endServ of enderecos) {
    
      const idEndereco = endServ.idEndereco;
      const laEnd = parseFloat(endServ.la);
      const loEnd = parseFloat(endServ.lo);
      const distancia = calcularDistanciaMetros(laBody, loBody, laEnd, loEnd);
      displayLog("info", "[chegueiEndereco] idEndereco/distancia/raio", { idEndereco, distancia, raioConfigurado });
      if (distancia > raioConfigurado) {
        processados.push({
          idServico,
          idEndereco,
          acao: "fora_do_raio",
          message: msgConfigApp.cheguei || "Fora do raio de chegada configurado",
          distanciaMetros: parseFloat(distancia.toFixed(2)),
          raioConfiguradoMetros: raioConfigurado,
          laProfissional: laBody,
          loProfissional: loBody,
          laEndereco: laEnd,
          loEndereco: loEnd,
        });
        continue;
      }

      displayLog("info", "[chegueiEndereco] confirmarProfissional", msgConfigApp.confirmarProfissional);

      if (msgConfigApp.confirmarProfissional === "S") {
        pendentesPush.push({ idServico, idEndereco });
        continue;
      }

      // UPDATE em enderecoServico (data/hora no fuso do cliente)
      try {
        const agora = getDateTimeMySQLPorFuso(fusoHorario);
        const updated = await entidade.update(
          { chegada: agora, laChegada: String(la), loChegada: String(lo) },
          "enderecoServico",
          "idEndereco = :idEndereco AND idServico = :idServico",
          { idEndereco: idEndereco, idServico: idServico }
        );
        if (updated) {
          const logCtx = {
            domain,
            idProf,
            idServico,
            idEndereco,
            distanciaMetros: parseFloat(distancia.toFixed(2)),
          };
          displayLog("info", "[chegueiEndereco] Cheguei registrado com sucesso", logCtx);
          await logController.inserirLog({
            idFuncionario: 1000,
            descricao: "[Cheguei automático] Cheguei registrado com sucesso",
            data: getDateTimeMySQLPorFuso(fusoHorario),
            menu: "Cheguei-Automatico",
            texto: JSON.stringify(logCtx),
            idServico,
            idProf,
          });
          processados.push({
            idServico,
            idEndereco,
            acao: "update",
            message: "Cheguei registrado com sucesso",
            distanciaMetros: parseFloat(distancia.toFixed(2)),
          });
        } else {
          processados.push({
            idServico,
            idEndereco,
            acao: "erro",
            message: "Falha ao atualizar enderecoServico",
          });
        }
      } catch (err) {
        displayError("[chegueiEndereco] Erro no UPDATE:", err.message);
        await logController.inserirLog({
          idFuncionario: 1000,
          descricao: "Erro no UPDATE enderecoServico",
          data: getDateTimeMySQLPorFuso(fusoHorario),
          menu: "Cheguei-Automatico",
          texto: err.message,
          idServico,
          idProf,
        });
        processados.push({
          idServico,
          idEndereco,
          acao: "erro",
          message: err.message,
        });
      }
    }
  }

  // confirmarProfissional === 'S': push com cooldown via rgLog (menu Cheguei-Auto-PushCD, texto=idEndereco, idProf+idServico)
  if (pendentesPush.length > 0) {
    const cooldownSeg = Math.max(
      1,
      Math.min(86400, parseInt(process.env.CHEGUEI_CONFIRM_PUSH_COOLDOWN_SECONDS, 10) || 60)
    );
    const dataLimiteMysql = getDateTimeMySQLMenosSegundosPorFuso(fusoHorario, cooldownSeg);
    const checks = await Promise.all(
      pendentesPush.map(({ idServico, idEndereco }) =>
        logController.existeMarcadorPushCooldownRecente({
          idProf,
          idServico,
          idEndereco,
          dataLimiteMysql,
        })
      )
    );
    const todosEmCooldown = checks.every(Boolean);

    if (todosEmCooldown) {
      for (const { idServico, idEndereco } of pendentesPush) {
        processados.push({
          idServico,
          idEndereco,
          acao: "push_omitido_cooldown",
          message: `Push omitido: marcador rgLog nos últimos ${cooldownSeg}s (idServico + idProf + texto=idEndereco).`,
          cooldownSegundos: cooldownSeg,
        });
      }
    } else {
      const mensagemPush = msgConfigApp.msgProfissinal || "Você chegou ao seu destino.";
      const primeiro = pendentesPush[0];
      const pushResult = await enviarPushMensagemProfissional(domain, idProf, mensagemPush, {
        identificador: "mensagem",
        mensagem: mensagemPush,
        idServico: primeiro.idServico,
        idEndereco: primeiro.idEndereco,
      });
      const pushLogCtx = {
        domain,
        idProf,
        idServico: primeiro.idServico,
        totalEnderecos: pendentesPush.length,
        pushSuccess: pushResult?.success,
        detail: pushResult?.detail ?? null,
      };
      displayLog("info", "[chegueiEndereco] Push de confirmação enviado (única notificação para todos os endereços)", pushLogCtx);
      const dataPush = getDateTimeMySQLPorFuso(fusoHorario);
      await logController.inserirLog({
        idFuncionario: 1000,
        descricao: RGLOG_DESC_PUSH_CONFIRMACAO_CHEGUEI,
        data: dataPush,
        menu: RGLOG_MENU_CHEGUEI_AUTO,
        texto: JSON.stringify(pushLogCtx),
        idServico: primeiro.idServico,
        idProf,
      });
      if (pushResult.success) {
        for (const { idServico, idEndereco } of pendentesPush) {
          await logController.inserirMarcadorPushCooldown({
            idProf,
            idServico,
            idEndereco,
            data: dataPush,
          });
        }
      }
      for (const { idServico, idEndereco } of pendentesPush) {
        processados.push({
          idServico,
          idEndereco,
          acao: "push",
          message: "Solicitação de confirmação enviada ao profissional",
          pushEnviado: pushResult.success,
        });
      }
    }
  }

  // Registrar log do processamento em rgLog
  const descricao = "Cheguei automático: processamento concluído";
  const dataLog = getDateTimeMySQLPorFuso(fusoHorario);
  const primeiroServico = processados.length > 0 ? processados[0].idServico : null;
  
  const logResult = await logController.inserirLog({
    idFuncionario: 1000,
    data: dataLog,
    menu: RGLOG_MENU_CHEGUEI_AUTO,
    texto: JSON.stringify(processados),
    idServico: primeiroServico,
    idProf,
  });
  if (!logResult.success) {
    displayError("[chegueiEndereco] Erro ao inserir log em rgLog");
    await logController.inserirLog({
      idFuncionario: 1000,
      descricao: "[chegueiEndereco] Erro ao inserir log em rgLog",
      data: dataLog,
      menu: RGLOG_MENU_CHEGUEI_AUTO,
      texto: "Falha ao persistir log de processamento",
      idServico: primeiroServico,
      idProf,
    });
  }

  return {
    status: 200,
    body: {
      success: true,
      processados,
      meSssage: processados.length === 0
        ? "Nenhum endereço pendente de cheguei dentro do raio para os serviços em execução."
        : `${processados.length} item(ns) processado(s).`,
    },
  };
}
