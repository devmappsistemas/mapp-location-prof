import { Entidade } from "../../db/Entidade.js";

/**
 * Classe ControleMD_agente_pedir_numero_sincronizado
 * Gerencia operações relacionadas à tabela agente_pedir_numero_sincronizado
 * Usa conexão MD (MD_CLMAPP)
 */
export class ControleMD_agente_pedir_numero_sincronizado {
    /**
     * Construtor da classe ControleMD_agente_pedir_numero_sincronizado
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        this.entidade.setConnection('md');
        this.tabela = 'agente_pedir_numero_sincronizado';
    }

    /**
     * Busca o ID na tabela agente_pedir_numero_sincronizado por idConfig e tipoAgente
     * @param {string|number} idConfig - ID da configuração
     * @param {string} tipoAgente - Tipo do agente
     * @returns {Promise<number|null>} ID do registro encontrado ou null se não encontrar
     */
    async buscarIdPorIdConfigETipoAgente(idConfig, tipoAgente) {
        try {
            if (!idConfig) {
                return null;
            }

            if (!tipoAgente || tipoAgente.trim() === '') {
                return null;
            }

            const campos = {
                id: ''
            };

            const condicaoWhere = 'idConfig = :idConfig AND tipoAgente = :tipoAgente AND status = "A"';

            const dadosCondicao = {
                idConfig: idConfig,
                tipoAgente: tipoAgente.trim()
            };

            const resultado = await this.entidade.selectRetornaArrayUnico(
                campos,
                this.tabela,
                condicaoWhere,
                dadosCondicao
            );

            if (!resultado || !resultado.id) {
                return null;
            }

            return resultado.id;

        } catch (error) {
            return null;
        }
    }

    /**
     * Busca urlAgenteN8n na tabela agente_pedir_numero_sincronizado por id (idTelConectado)
     * @param {string|number} idTelConectado - ID do telefone conectado (PK da tabela)
     * @returns {Promise<string|null>} URL do agente N8n ou null se não encontrar
     */
    async buscaUrlAgenteN8n(idTelConectado) {
        try {
            if (!idTelConectado) {
                return null;
            }

            const campos = {
                urlAgenteN8n: ''
            };

            const condicaoWhere = 'id = :idTelConectado';
            const dadosCondicao = { idTelConectado };

            const resultado = await this.entidade.selectRetornaArrayUnico(
                campos,
                this.tabela,
                condicaoWhere,
                dadosCondicao
            );

            if (!resultado || resultado.urlAgenteN8n == null || String(resultado.urlAgenteN8n).trim() === '') {
                return null;
            }

            return String(resultado.urlAgenteN8n).trim();
        } catch (error) {
            return null;
        }
    }
}
