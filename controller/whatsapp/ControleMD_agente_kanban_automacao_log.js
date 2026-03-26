import { Entidade } from "../../db/Entidade.js";
import { getSaoPauloDateTimeMySQL } from "../../utils/dateHelper.js";
import { error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Controller para a tabela agente_kanban_automacao_log.
 * Registra execuções de automações (sucesso ou erro).
 * Usa conexão MD (MD_CLMAPP).
 */
export class ControleMD_agente_kanban_automacao_log {
  /**
   * @param {Object} db - Objeto contendo as conexões de banco de dados
   * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
   * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
   */
  constructor(db) {
    this.db = db;
    this.entidade = new Entidade(db);
    this.entidade.setConnection("md");
    this.tabela = "agente_kanban_automacao_log";
  }

  /**
   * Salva log de execução de automação e retorna o registro inserido.
   * @param {Object} dados
   * @param {number} dados.id_automacao - FK agente_kanban_automacao.id
   * @param {number} dados.id_card - agente_kanban_monitoramento.id
   * @param {number} dados.idTelConectado
   * @param {number|null} [dados.id_coluna] - agente_kanban_coluna.id
   * @param {number|null} [dados.id_agente_pedir] - idAgentePedir
   * @param {string} dados.sucesso - 'S' ou 'N'
   * @param {string|null} [dados.retorno] - JSON do retorno estruturado (sucesso ou erro)
   * @param {string|null} [dados.msg] - Mensagem resumida (sucesso ou erro), salva na coluna msg
   * @returns {Promise<{ success: boolean, data?: Object }>} Registro salvo com id e disparado_em
   */
  async salvarLog(dados) {
    try {
      const dadosInserir = {
        id_automacao: dados.id_automacao,
        id_card: dados.id_card,
        idTelConectado: dados.idTelConectado,
        id_coluna: dados.id_coluna ?? null,
        id_agente_pedir: dados.id_agente_pedir ?? null,
        disparado_em: getSaoPauloDateTimeMySQL(),
        sucesso: dados.sucesso,
        retorno: dados.retorno ?? null,
        msg: dados.msg ?? null,
      };
      const insertId = await this.entidade.inserir(dadosInserir, this.tabela);
      if (!insertId) return { success: false };

      const [rows] = await this.entidade.connection.query(
        `SELECT * FROM ${this.tabela} WHERE id = ?`,
        [insertId]
      );
      const registro = rows && rows[0] ? rows[0] : { id: insertId, ...dadosInserir };
      return { success: true, data: registro };
    } catch (error) {
      displayError("[ControleMD_agente_kanban_automacao_log] Erro ao salvar log:", error.message);
      return { success: false };
    }
  }

  /**
   * Conta envios bem-sucedidos de uma automação para uma pessoa desde uma data.
   * Usado para verificar o índice no ciclo atual (reset quando o usuário responde).
   * @param {number} id_automacao - FK agente_kanban_automacao.id
   * @param {number} id_agente_pedir - idAgentePedir (pessoa)
   * @param {string} dataHoraDesde - Data/hora de corte (ex: última mensagem do usuário). Formato MySQL.
   * @returns {Promise<number>} Quantidade de envios com sucesso desde a data
   */
  async contarEnviosBemSucedidosDesde(id_automacao, id_agente_pedir, dataHoraDesde) {
    try {
      const sql = `
        SELECT COUNT(*) AS total
        FROM ${this.tabela}
        WHERE id_automacao = ? AND id_agente_pedir = ? AND sucesso = 'S'
          AND disparado_em > ?
      `;
      const [rows] = await this.entidade.connection.query(sql, [
        id_automacao,
        id_agente_pedir,
        dataHoraDesde || '1970-01-01 00:00:00',
      ]);
      const total = rows && rows[0] ? parseInt(rows[0].total, 10) : 0;
      return total;
    } catch (error) {
      displayError('[ControleMD_agente_kanban_automacao_log] Erro ao contar envios:', error.message);
      return 0;
    }
  }
}
