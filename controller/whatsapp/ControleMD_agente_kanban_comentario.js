import { Entidade } from "../../db/Entidade.js";
import { error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Controller para a tabela agente_kanban_comentario.
 * Busca comentários e resumos de reunião para incluir no prompt do n8n.
 * Usa conexão MD (MD_CLMAPP).
 */
export class ControleMD_agente_kanban_comentario {
  constructor(db) {
    this.db = db;
    this.entidade = new Entidade(db);
    this.entidade.setConnection("md");
    this.tabela = "agente_kanban_comentario";
  }

  /**
   * Busca comentários e resumo de reunião separadamente para o card Kanban.
   * Comentários: status='A' e (reuniao IS NULL ou reuniao != 'S')
   * Resumo reunião: status='A' e reuniao='S'
   *
   * @param {number} idMonitoramento - ID do agente_kanban_monitoramento
   * @param {string} [usarComentario] - 'S' = buscar comentários da conversa
   * @param {string} [usarReuniao] - 'S' = buscar resumo da reunião
   * @returns {Promise<{ comentarios: string[], resumoReuniao: string[] }>}
   */
  async buscarComentariosEResumoReuniao(idMonitoramento, usarComentario, usarReuniao) {
    const resultado = { comentarios: [], resumoReuniao: [] };
    if (!idMonitoramento) return resultado;

    const usarC = String(usarComentario || "").toUpperCase() === "S";
    const usarR = String(usarReuniao || "").toUpperCase() === "S";
    if (!usarC && !usarR) return resultado;

    try {
      if (usarC) {
        const [rowsComentarios] = await this.entidade.connection.query(
          `SELECT comentario FROM agente_kanban_comentario
           WHERE idMonitoramento = ? AND status = 'A'
           AND (reuniao IS NULL OR reuniao != 'S')
           ORDER BY dataCriado ASC`,
          [idMonitoramento]
        );
        resultado.comentarios = (Array.isArray(rowsComentarios) ? rowsComentarios : [])
          .map((r) => r?.comentario)
          .filter((c) => c != null && String(c).trim() !== "");
      }
      if (usarR) {
        const [rowsReuniao] = await this.entidade.connection.query(
          `SELECT comentario FROM agente_kanban_comentario
           WHERE idMonitoramento = ? AND status = 'A' AND reuniao = 'S'
           ORDER BY dataCriado ASC`,
          [idMonitoramento]
        );
        resultado.resumoReuniao = (Array.isArray(rowsReuniao) ? rowsReuniao : [])
          .map((r) => r?.comentario)
          .filter((c) => c != null && String(c).trim() !== "");
      }
      return resultado;
    } catch (err) {
      displayError("[ControleMD_agente_kanban_comentario] Erro ao buscar comentários/reunião:", err?.message);
      return resultado;
    }
  }
}
