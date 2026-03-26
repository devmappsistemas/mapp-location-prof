import { Entidade } from "../../db/Entidade.js";
import { DiscordNotifier } from "../../utils/discordNotifier.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

export class ControleMD_agente_kanban_monitoramento {
    /**
     * Construtor da classe ControleMD_agente_kanban_monitoramento
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        this.entidade.setConnection('md');
        this.tabela = 'agente_kanban_monitoramento';
    }

    /**
     * Atualiza a coluna do Kanban para "agente não responde" quando necessário
     * @param {string} tipoAgente - Tipo do agente
     * @param {string|number} idConfig - ID da configuração
     * @param {string|number} idTelConectado - ID do telefone conectado
     * @param {string|number} idAgentePedir - ID do agente pedir
     * @returns {Promise<boolean>} Retorna true se atualizado com sucesso, false caso contrário
     */
    async atualizarColunaKanbanAgenteNaoResponde(tipoAgente, idConfig, idTelConectado, idAgentePedir) {
        try {
            displayLog('[atualizarColunaKanbanAgenteNaoResponde] CHEGOU NO ARQUIVOOOOOO =--*/*/*/*/**/* ********************');

            if (!tipoAgente || !idConfig || !idTelConectado || !idAgentePedir) {
                displayWarn('[ControleEnviarMensagem] Parâmetros incompletos para atualizar coluna Kanban:', {
                    tipoAgente,
                    idConfig,
                    idTelConectado,
                    idAgentePedir
                });
                return false;
            }

            // Busca a primeira coluna do Kanban onde agenteResponde = 'N' para o tipo do agente
            const sqlColuna = `SELECT id FROM agente_kanban_coluna WHERE tipo = ? AND agenteResponde = 'N' ORDER BY ordem ASC LIMIT 1`;
            const [rowsColuna] = await this.entidade.connection.query(sqlColuna, [tipoAgente]);
            const idColuna = rowsColuna && rowsColuna[0] ? parseInt(rowsColuna[0].id, 10) : 0;

            if (idColuna > 0) {
                

                const condicao = 'idConfig = :idConfig AND idTelConectado = :idTelConectado AND idAgentePedir = :idAgentePedir';
                const dadosCondicao = {
                    idConfig: idConfig,
                    idTelConectado: idTelConectado,
                    idAgentePedir: idAgentePedir
                };
                const atualizado = await this.entidade.update(
                    { id_coluna: idColuna },
                    'agente_kanban_monitoramento',
                    condicao,
                    dadosCondicao
                );

                if (atualizado) {
                    displayLog('[ControleMD_agente_kanban_monitoramento] Coluna Kanban atualizada para', idColuna, 'em agente_kanban_monitoramento');
                    return true;
                }
            } else {
                displayWarn('[ControleEnviarMensagem] Coluna Kanban não encontrada para tipo:', tipoAgente);
            }

            return false;
        } catch (error) {
            displayError('[ControleEnviarMensagem] Erro ao atualizar coluna Kanban:', error.message);
            displayError('[ControleEnviarMensagem] Stack:', error.stack);
            
            // Envia notificação para Discord
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao atualizar coluna Kanban', error, {
                tipoAgente,
                idConfig,
                idTelConectado,
                idAgentePedir
            }, 'Node.js - ControleEnviarMensagem').catch(err => displayError('[ControleEnviarMensagem] Erro ao enviar notificação Discord:', err));
            
            return false;
        }
    }

    /**
     * Atualiza a coluna do Kanban para uma coluna específica (por ID).
     * Usado quando o limite de envios da automação é atingido.
     * @param {number} id_coluna_destino - ID da coluna de destino (agente_kanban_coluna.id)
     * @param {string|number} idConfig - ID da configuração
     * @param {string|number} idTelConectado - ID do telefone conectado
     * @param {string|number} idAgentePedir - ID do agente pedir
     * @returns {Promise<boolean>} Retorna true se atualizado com sucesso, false caso contrário
     */
    async atualizarColunaKanbanParaColunaEspecifica(id_coluna_destino, idConfig, idTelConectado, idAgentePedir) {
        try {
            if (!id_coluna_destino || !idConfig || !idTelConectado || !idAgentePedir) {
                displayWarn('[ControleMD_agente_kanban_monitoramento] Parâmetros incompletos para atualizar coluna:', {
                    id_coluna_destino,
                    idConfig,
                    idTelConectado,
                    idAgentePedir
                });
                return false;
            }

            const condicao = 'idConfig = :idConfig AND idTelConectado = :idTelConectado AND idAgentePedir = :idAgentePedir';
            const dadosCondicao = {
                idConfig: idConfig,
                idTelConectado: idTelConectado,
                idAgentePedir: idAgentePedir
            };
            const atualizado = await this.entidade.update(
                { id_coluna: id_coluna_destino },
                'agente_kanban_monitoramento',
                condicao,
                dadosCondicao
            );

            if (atualizado) {
                displayLog('[ControleMD_agente_kanban_monitoramento] Coluna Kanban atualizada para', id_coluna_destino, 'em agente_kanban_monitoramento');
                return true;
            }

            return false;
        } catch (error) {
            displayError('[ControleMD_agente_kanban_monitoramento] Erro ao atualizar coluna Kanban:', error.message);
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao atualizar coluna Kanban', error, {
                id_coluna_destino,
                idConfig,
                idTelConectado,
                idAgentePedir
            }, 'Node.js - ControleMD_agente_kanban_monitoramento').catch(err => displayError('[ControleMD_agente_kanban_monitoramento] Erro ao enviar notificação Discord:', err));
            return false;
        }
    }
}
