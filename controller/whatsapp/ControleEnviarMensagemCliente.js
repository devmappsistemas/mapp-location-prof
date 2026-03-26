import { ControleMD_agente_conversas_mensagens } from "./ControleMD_agente_conversas_mensagens.js";
import { getSaoPauloDateTimeMySQL } from "../../utils/dateHelper.js";
import {
  buscarTemplatePorNome,
  montarTemplateDataParaEnvio,
  comporMensagemTemplateFinal,
} from "../../utils/whatsappTemplateApi.js";
import { ControleEnviarMensagem } from "./ControleEnviarMensagem.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Controller para envio de mensagens WhatsApp a clientes via API Meta.
 * Usado pelos runners de automação Kanban (DataHoraVerificacao, TempoSemReposta).
 * Reutiliza ControleMD_agente_conversas_mensagens.salvarMensagem.
 */
export class ControleEnviarMensagemCliente {
  /**
   * @param {Object} db - Objeto contendo as conexões de banco de dados
   * @param {Object} db.dbClient - Pool de conexão
   * @param {Object} db.dbMD - Pool de conexão MD_CLMAPP
   */
  constructor(db) {
    this.db = db;
    this.controleMensagens = new ControleMD_agente_conversas_mensagens(db);
  }

  /**
   * Envia mensagem automática (template ou texto) para o cliente via Meta API.
   * Não lança exceção em falha; retorna objeto estruturado para o log.
   *
   * @param {Object} item - Item da automação (idAgentePedir, idTelConectado, idConfig, nome_template, mensagem, etc.)
   * @param {Object} contexto - { enviar_template: boolean }
   * @returns {Promise<{ success: boolean, idMensagem?: number, resultadoMeta?: object, error?: string }>}
   */
  async enviarMensagemAutomatica(item, contexto) {
    const enviarTemplate = !!contexto?.enviar_template;
    const tipo = enviarTemplate ? "template" : "texto";

    try {
      if (!item?.idAgentePedir || !item?.idTelConectado || !item?.idConfig) {
        return { success: false, error: "idAgentePedir, idTelConectado e idConfig são obrigatórios", tipo };
      }

      if (enviarTemplate) {
        if (!item.nome_template || String(item.nome_template).trim() === "") {
          return { success: false, error: "nome_template é obrigatório para envio de template", tipo };
        }
      } else {
        const mensagem = item.mensagem ?? "";
        if (String(mensagem).trim() === "") {
          return { success: false, error: "mensagem é obrigatória para envio de texto", tipo };
        }
      }

      const tipoAgente = await this.controleMensagens.buscarTipoAgentePorIdTelConectado(item.idTelConectado);
      if (!tipoAgente) {
        return { success: false, error: "tipoAgente não encontrado para idTelConectado", tipo };
      }

      let mensagemEfetiva = item.mensagem ?? "";

      if (String(item.tipo_mensagem || "").toUpperCase() === "PROMPT" && String(mensagemEfetiva).trim() !== "") {
        const controleEnviarMensagem = new ControleEnviarMensagem(this.db);
        const elaborada = await controleEnviarMensagem.elaborarMensagemParaCliente(mensagemEfetiva, item, tipoAgente);
        if (elaborada && String(elaborada).trim() !== "") {
          mensagemEfetiva = elaborada;
        } else {
          displayWarn("[ControleEnviarMensagemCliente] Elaboração via agente n8n falhou ou retornou vazio; usando mensagem original", {
            idAgentePedir: item.idAgentePedir,
          });
        }
      }

      const dataHora = getSaoPauloDateTimeMySQL();
      const timeData = Math.floor(Date.now() / 1000);

      const dadosConteudo = {
        idAgentePedir: item.idAgentePedir,
        origem: "E",
        dataHora,
        timeData,
        idConfig: item.idConfig,
        idTelConectado: item.idTelConectado,
        tipoAgente,
        tipo,
      };

      if (enviarTemplate) {
        const templateMeta = await buscarTemplatePorNome(this.db, item.idTelConectado, item.nome_template);
        if (!templateMeta) {
          return { success: false, error: "Template não encontrado na API Meta", tipo };
        }
        const parametros = item.parametros && typeof item.parametros === "object" ? item.parametros : {};
        const { templateData, templateParameters } = montarTemplateDataParaEnvio(
          templateMeta,
          parametros,
          mensagemEfetiva
        );
        dadosConteudo.templateName = item.nome_template;
        dadosConteudo.templateCategory =
          templateMeta?.templateCategory ?? templateMeta?.category ?? templateData?.category ?? null;
        dadosConteudo.validacaoNumero = templateMeta?.validacaoNumero ?? null;
        dadosConteudo.templateData = templateData;
        dadosConteudo.templateParameters = templateParameters;
        dadosConteudo.templateParams = templateParameters;
        dadosConteudo.mensagem = comporMensagemTemplateFinal(templateMeta, templateParameters);
      } else {
        dadosConteudo.mensagem = mensagemEfetiva || "";
      }

      displayLog("[ControleEnviarMensagemCliente] dadosConteudo", JSON.stringify(dadosConteudo, null, 2));
      const dadosMensagem = {
        dadosConteudo,
        idConfig: item.idConfig,
        idTelConectado: item.idTelConectado,
      };

      const resultado = await this.controleMensagens.salvarMensagem(dadosMensagem);

      const idMensagem = resultado?.idMensagem ?? resultado;
      const resultadoMeta = resultado?.resultadoMeta;
      const idMensagemMeta =
        resultadoMeta?.data?.messages?.[0]?.id ??
        resultadoMeta?.messages?.[0]?.id ??
        resultadoMeta?.messageId ??
        null;

      displayLog("[ControleEnviarMensagemCliente] Mensagem enviada com sucesso", {
        idAgentePedir: item.idAgentePedir,
        idMensagem,
        tipo,
      });

      return { success: true, idMensagem, resultadoMeta, idMensagemMeta, tipo };
    } catch (err) {
      const msg = err?.message ?? String(err);
      displayError("[ControleEnviarMensagemCliente] Erro ao enviar mensagem:", msg);
      return { success: false, error: msg, tipo };
    }
  }
}
