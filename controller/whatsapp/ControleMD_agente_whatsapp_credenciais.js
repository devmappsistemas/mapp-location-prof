import { Entidade } from "../../db/Entidade.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Classe ControleMD_agente_whatsapp_credenciais
 * Gerencia operações relacionadas à tabela agente_whatsapp_credenciais
 * Usa conexão MD (MD_CLMAPP)
 */
export class ControleMD_agente_whatsapp_credenciais {
    /**
     * Construtor da classe ControleMD_agente_whatsapp_credenciais
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        this.entidade.setConnection('md');
        this.tabela = 'agente_whatsapp_credenciais';
    }

    /**
     * Busca credenciais do WhatsApp Meta por idConfig, idTelConectado e STATUS = 'A'
     * @param {string|number} idConfig - ID da configuração
     * @param {string|number} idTelConectado - ID do telefone conectado
     * @returns {Promise<Object|null>} Credenciais do Meta ou null se não encontrar
     */
    async buscarCredenciaisPorIdConfigEIdTelConectado(idConfig, idTelConectado) {
        try {


            if (!idConfig) {
                return null;
            }

            if (!idTelConectado) {
                return null;
            }

            const campos = {
                id: '',
                idConfig: '',
                tokenMeta: '',
                bearerTokenAgente: '',
                validacaoNumeroMeta: '',
                idWhatBusinessMeta: '',
                status: ''
            };

            //const condicaoWhere = 'idConfig = :idConfig AND idTelConectado = :idTelConectado AND status = :status';
            const condicaoWhere = 'id = :id  AND status = :status';

            const dadosCondicao = {
                id: idTelConectado,
                status: 'A'
            };

            const credenciais = await this.entidade.selectRetornaArrayUnico(
                campos,
                "agente_pedir_numero_sincronizado",
                condicaoWhere,
                dadosCondicao
            );

            if (!credenciais || !credenciais.tokenMeta || !credenciais.validacaoNumeroMeta ) {
                return null;
            }

            return {
                accessToken: credenciais.tokenMeta,
                phoneNumberId: credenciais.validacaoNumeroMeta,
                apiVersion: 'v24.0'
            };

        } catch (error) {
            return null;
        }
    }

    /**
     * Busca idTelConectado por validacaoNumero
     * @param {string} validacaoNumero - Número de validação do WhatsApp
     * @returns {Promise<string|null>} idTelConectado ou null se não encontrar
     */
    async buscarIdTelConectadoPorValidacaoNumero(validacaoNumero) {
        try {
            if (!validacaoNumero || typeof validacaoNumero !== 'string' || validacaoNumero.trim() === '') {
                return null;
            }

            const campos = {
                id: ''
            };

            displayLog('buscarIdTelConectadoPorValidacaoNumero CHEGOU ******************                      ');


            const condicaoWhere = 'validacaoNumeroMeta = :validacaoNumeroMeta';

            const dadosCondicao = {
                validacaoNumeroMeta: validacaoNumero.trim()
            };

            const resultado = await this.entidade.selectRetornaArrayUnico(
                campos,
                'agente_pedir_numero_sincronizado',
                condicaoWhere,
                dadosCondicao
            );

            if (resultado && resultado.id) {
                return String(resultado.id);
            }

            return null;
        } catch (error) {
            displayError('[ControleMD_agente_whatsapp_credenciais] Erro ao buscar idTelConectado:', error.message);
            return null;
        }
    }
}
