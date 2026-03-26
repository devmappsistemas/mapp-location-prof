import { Entidade } from "../db/Entidade.js";
import { error as displayError } from "../utils/displayLogWebhook.js";

export const RGLOG_MENU_CHEGUEI_AUTO = "Cheguei-Automatico";
export const RGLOG_DESC_PUSH_CONFIRMACAO_CHEGUEI =
  "Notificação de confirmação ao profissional enviada (confirmação do profissional ativo)";
/** Marcador de cooldown: texto = idEndereco, descricao vazia, idServico + idProf. */
export const RGLOG_MENU_PUSH_COOLDOWN = "Cheguei-Auto-PushCD";

/**
 * Controller para a tabela rgLog (log do tenant).
 * Usa conexão do banco cliente (tenant).
 */
export class ControleLogRg {
  /**
   * @param {Object} db - Objeto contendo as conexões de banco de dados
   * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
   * @param {Object} [db.dbMD] - Pool MD (não usado por este controller)
   */
  constructor(db) {
    this.db = db;
    this.entidade = new Entidade(db);
    this.tabela = "rgLog";
  }

  /**
   * Insere registro em rgLog.
   * @param {Object} dados
   * @param {number} dados.idFuncionario - Obrigatório (ex.: 1000)
   * @param {string} [dados.descricao] - varchar 255
   * @param {string} [dados.data] - datetime (formato MySQL)
   * @param {string} [dados.menu] - varchar 50 (ex.: CHEGUEI_AUTOMATICO)
   * @param {string} [dados.texto] - longtext
   * @param {number|null} [dados.idServico]
   * @param {number|null} [dados.idProf]
   * @param {number|null} [dados.idCliente]
   * @returns {Promise<{ success: boolean, insertId?: number }>}
   */
  async inserirLog(dados) {
    
    try {
      const dadosInserir = {
        idFuncionario: dados.idFuncionario ?? 1000,
        descricao: dados.descricao ?? null,
        data: dados.data ?? null,
        menu: dados.menu ?? null,
        texto: dados.texto ?? null,
        idServico: dados.idServico ?? null,
        idProf: dados.idProf ?? null,
        idCliente: dados.idCliente ?? null,
      };
      const insertId = await this.entidade.inserir(dadosInserir, this.tabela);
      return { success: !!insertId, insertId: insertId || undefined };
    } catch (error) {
      displayError("[ControleLogRg] Erro ao inserir log:", error.message);
      return { success: false };
    }
     
  }

  /**
   * Existe linha rgLog (menu Cheguei-Auto-PushCD) com data >= dataLimiteMysql.
   * `dataLimiteMysql` deve ser "agora - cooldown" no mesmo fuso em que `data` foi gravada (tenant).
   */
  async existeMarcadorPushCooldownRecente({ idProf, idServico, idEndereco, dataLimiteMysql }) {
    const idEnd = String(idEndereco).trim();
    const idP = Number(idProf);
    const idS = Number(idServico);
    if (!idEnd || !Number.isFinite(idP) || !Number.isFinite(idS)) return false;
    if (!dataLimiteMysql || typeof dataLimiteMysql !== "string") return false;
    try {
      const conn = this.entidade.connection;
      const [rows] = await conn.query(
        `SELECT 1 AS ok FROM rgLog
         WHERE menu = ? AND idServico = ? AND idProf = ? AND texto = ?
           AND data >= ?
         LIMIT 1`,
        [RGLOG_MENU_PUSH_COOLDOWN, idS, idP, idEnd, dataLimiteMysql]
      );
      return Array.isArray(rows) && rows.length > 0;
    } catch (error) {
      displayError("[ControleLogRg] existeMarcadorPushCooldownRecente:", error.message);
      return false;
    }
  }

  /** Uma linha por endereço após push com sucesso (cooldown). */
  async inserirMarcadorPushCooldown({ idProf, idServico, idEndereco, data }) {
    return this.inserirLog({
      idFuncionario: 1000,
      descricao: null,
      data,
      menu: RGLOG_MENU_PUSH_COOLDOWN,
      texto: String(idEndereco).trim(),
      idServico: Number(idServico),
      idProf: Number(idProf),
    });
  }
}
