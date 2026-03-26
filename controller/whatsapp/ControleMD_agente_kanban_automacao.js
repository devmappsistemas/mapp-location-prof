import { Entidade } from "../../db/Entidade.js";
import { DiscordNotifier } from "../../utils/discordNotifier.js";
import { error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Controller para a tabela agente_kanban_automacao.
 * Gerencia consultas de automações por data/hora de verificação.
 * Usa conexão MD (MD_CLMAPP).
 */
export class ControleMD_agente_kanban_automacao {
  /**
   * Construtor da classe ControleMD_agente_kanban_automacao
   * @param {Object} db - Objeto contendo as conexões de banco de dados
   * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
   * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
   */
  constructor(db) {
    this.db = db;
    this.entidade = new Entidade(db);
    this.entidade.setConnection("md");
    this.tabela = "agente_kanban_automacao";
  }

  /**
   * Busca automações com tipo_regra DATA_HORA_VERIFICACAO cuja data_verificacao
   * do monitoramento coincide com o slot informado.
   * @param {string} dataHoraSlot - Data/hora no formato YYYY-MM-DD HH:mm (ex: "2026-02-19 11:00")
   * @param {number} [limit=1000] - Limite de registros por página
   * @param {number} [offset=0] - Offset para paginação
   * @returns {Promise<{ success: boolean, data: Array }>}
   */
  async buscarPorDataHoraVerificacao(dataHoraSlot, limit = 1000, offset = 0) {
    try {

      
      const sql = `
        SELECT
          a.id AS id_automacao,
          a.id_coluna,
          a.nome,
          a.idConfig,
          a.idTelConectado,
          m.idAgentePedir,
          MIN(m.id) AS id_monitoramento,
          a.nome_template,
          a.mensagem,
          a.tipo_mensagem,
          a.usar_comentario,
          a.usar_reuniao,
          a.limite_envios,
          a.id_coluna_apos_limite
        FROM agente_kanban_automacao a
        INNER JOIN agente_kanban_monitoramento m ON (m.id_coluna = a.id_coluna AND m.idTelConectado = a.idTelConectado)
        WHERE a.tipo_regra = 'DATA_HORA_VERIFICACAO' AND a.ativo = 'S' AND a.status = 'A'
          AND m.status = 'A'
          AND DATE_FORMAT(m.data_verificacao, '%Y-%m-%d %H:%i') = ?
        GROUP BY  a.id_coluna, a.idConfig, a.idTelConectado, m.idAgentePedir, a.mensagem, a.tipo_mensagem
        ORDER BY a.id, m.idAgentePedir
        LIMIT ? OFFSET ?
      `;
      const [rows] = await this.entidade.connection.query(sql, [dataHoraSlot, limit, offset]);
      const data = Array.isArray(rows) ? rows : [];
      return { success: true, data };
    } catch (error) {
      displayError("[ControleMD_agente_kanban_automacao] Erro ao buscar por data/hora verificação:", error.message);
      DiscordNotifier.enviarErro(
        "Chat WhatsApp - Erro ao buscar automações DATA_HORA_VERIFICACAO",
        error,
        { dataHoraSlot },
        "Node.js - ControleMD_agente_kanban_automacao"
      ).catch((err) => displayError("[ControleMD_agente_kanban_automacao] Erro ao enviar notificação Discord:", err));
      return { success: false, data: [] };
    }
  }

  /**
   * Busca automações com tipo_regra HORAS_SEM_RESPOSTA, MINUTOS_SEM_RESPOSTA ou DIAS_SEM_RESPOSTA
   * cujo agendamento coincide com o horário atual e está dentro da janela hora_inicio/minuto_inicio até hora_fim/minuto_fim.
   * @param {number} horaAtual - Hora atual no fuso São Paulo (0-23)
   * @param {number} minutoAtual - Minuto atual (0-59)
   * @param {number} diaDoAno - Dia do ano (1-366)
   * @param {number} [limit=1000] - Limite de registros por página
   * @param {number} [offset=0] - Offset para paginação
   * @returns {Promise<{ success: boolean, data: Array }>}
   */
  async buscarPorAgendamentoTempoSemResposta(horaAtual, minutoAtual, diaDoAno, limit = 1000, offset = 0) {

    try {
      const sql = `
        SELECT
          a.id AS id_automacao,
          a.nome,
          a.id_coluna,
          a.idConfig,
          a.idTelConectado,
          m.idAgentePedir,
          MIN(m.id) AS id_monitoramento,
          a.nome_template,
          a.mensagem,
          a.tipo_mensagem,
          a.valor_regra,
          a.unidade_regra,
          a.usar_comentario,
          a.usar_reuniao,
          a.limite_envios,
          a.id_coluna_apos_limite
        FROM agente_kanban_automacao a
        INNER JOIN agente_kanban_monitoramento m ON (m.id_coluna = a.id_coluna AND m.idTelConectado = a.idTelConectado)
        WHERE a.tipo_regra IN ('HORAS_SEM_RESPOSTA', 'MINUTOS_SEM_RESPOSTA', 'DIAS_SEM_RESPOSTA')
          AND a.ativo = 'S'
          AND a.status = 'A'
          AND m.status = 'A'
          AND (
            (a.tipo_agendamento = 'H'
             AND (MOD(?, a.intervalo_agendamento) = 0)
             AND a.minuto_agendamento = ?)
            OR
            (a.tipo_agendamento = 'D'
             AND a.hora_agendamento = ?
             AND a.minuto_agendamento = ?
             AND (MOD(?, a.intervalo_agendamento) = 0))
          )
          AND (
            (? * 60 + ?) >= (a.hora_inicio * 60 + a.minuto_inicio)
            AND (? * 60 + ?) <= (a.hora_fim * 60 + a.minuto_fim)
          )
        GROUP BY a.id_coluna, a.idConfig, a.idTelConectado, m.idAgentePedir, a.mensagem, a.tipo_mensagem
        ORDER BY a.id, m.idAgentePedir
        LIMIT ? OFFSET ?
      `;
      const params = [
        horaAtual,
        minutoAtual,
        horaAtual,
        minutoAtual,
        diaDoAno,
        horaAtual,
        minutoAtual,
        horaAtual,
        minutoAtual,
        limit,
        offset,
      ];
      
      const [rows] = await this.entidade.connection.query(sql, params);
      const data = Array.isArray(rows) ? rows : [];
      return { success: true, data };
    } catch (error) {
      displayError("[ControleMD_agente_kanban_automacao] Erro ao buscar por agendamento tempo sem resposta:", error.message);
      DiscordNotifier.enviarErro(
        "Chat WhatsApp - Erro ao buscar automações agendamento tempo sem resposta",
        error,
        { horaAtual, minutoAtual, diaDoAno, limit, offset },
        "Node.js - ControleMD_agente_kanban_automacao"
      ).catch((err) => displayError("[ControleMD_agente_kanban_automacao] Erro ao enviar notificação Discord:", err));
      return { success: false, data: [] };
    }
  }
}
