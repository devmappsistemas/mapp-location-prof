import { Entidade } from "../../db/Entidade.js";
import { getPoolForDomain } from "../../db/dbFactory.js";
import { log as displayLog, error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Retorna informações de data e hora atual no fuso de São Paulo
 * @returns {Object} Objeto com timeAtual, dataAtual, horaAtual, diaSemana, dateTime, dataHora, isoSaoPaulo
 */
function getDataHoraSaoPaulo() {
    const currentDate = new Date();
    const options = { timeZone: 'America/Sao_Paulo', hour12: false };

    // Formatar para MySQL (YYYY-MM-DD HH:mm:ss)
    const formatToMySQL = (date) => {
        return new Intl.DateTimeFormat('fr-CA', { ...options, dateStyle: 'short' }).format(date) +
            ' ' +
            new Intl.DateTimeFormat('en-GB', { ...options, timeStyle: 'medium' }).format(date);
    };

    // Formatar ISO com -03:00
    const formatterISO = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

    const parts = formatterISO.formatToParts(currentDate).reduce((acc, part) => {
        acc[part.type] = part.value;
        return acc;
    }, {});

    const isoSaoPaulo = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}-03:00`;
    const dataAtual = new Intl.DateTimeFormat('fr-CA', { ...options, dateStyle: 'short' }).format(currentDate);
    const horaAtual = new Intl.DateTimeFormat('en-GB', { ...options, timeStyle: 'medium' }).format(currentDate);
    const dateTime = formatToMySQL(currentDate);
    const diaSemana = new Intl.DateTimeFormat('pt-BR', { ...options, weekday: 'long' }).format(currentDate);

    return {
        timeAtual: Math.floor(currentDate.getTime() / 1000),
        dataAtual,
        horaAtual,
        diaSemana,
        dateTime,
        dataHora: dateTime,
        isoSaoPaulo
    };
}

export class ControleMD_agente_assuntos_nomes {
    /**
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        // Usa sempre a conexão MD (MD_CLMAPP)
        this.entidade.setConnection('md');
    }

    /**
     * @param {number|string} idSolicitante - ID do solicitante (opcional)
     * @param {number|string} idConfig - ID da configuração (obrigatório)
     * @param {string} tipoAgente - Tipo do agente (obrigatório)
     * @returns {Promise<Object>} Objeto com status, mensagem (quando aplicável), lista de assuntos e domínio do cliente
     */
    async buscarAssuntosPorConfig(idSolicitante, idConfig, tipoAgente) {
        try {
            // Gera informações de data/hora no fuso de São Paulo (uma vez para toda a função)
            const dataHoraInfo = getDataHoraSaoPaulo();

            // Validações básicas
            if (idConfig === undefined || idConfig === null || idConfig === '') {
                return {
                    status: 'error',
                    message: 'idConfig é obrigatório para buscar os assuntos.',
                    idSolicitante,
                    idConfig,
                    tipoAgente,
                    quantidade: 0,
                    assuntos: [],
                    ...dataHoraInfo
                };
            }

            if (!tipoAgente || String(tipoAgente).trim() === '') {
                return {
                    status: 'error',
                    message: 'tipoAgente é obrigatório para buscar os assuntos.',
                    idSolicitante,
                    idConfig,
                    tipoAgente,
                    quantidade: 0,
                    assuntos: [],
                    ...dataHoraInfo
                };
            }

            const campos = {
                texto: ''
            };

            const tabela = 'agente_assuntos a INNER JOIN agente_assuntos_nomes n ON n.id = a.idAssuntosNomes';

            const condicao = "n.idConfig = :idConfig AND n.status = 'A' AND n.tipo = 'P' AND n.tipoAgente = :tipoAgente";

            const dadosCondicao = {
                idConfig,
                tipoAgente
            };

            const resultados = await this.entidade.select(
                campos,
                tabela,
                condicao,
                dadosCondicao
            );

            // Garante que resultados seja um array
            let assuntos = [];
            if (Array.isArray(resultados)) {
                assuntos = resultados;
            } else if (resultados && typeof resultados === 'object') {
                // Se for objeto, converte para array
                assuntos = Object.values(resultados).filter(item => item && typeof item === 'object');
            }

            // =======================================
            // Busca prompts fixos globais por tipoAgente
            // (tabela agente_prompt_fixo)
            // =======================================
            const camposPromptFixo = {
                texto: ''
            };

            const tabelaPromptFixo = 'agente_prompt_fixo';

            const condicaoPromptFixo = "tipoAgente = :tipoAgente AND status = 'A'";

            const dadosCondicaoPromptFixo = {
                tipoAgente
            };

            const resultadosPromptFixo = await this.entidade.select(
                camposPromptFixo,
                tabelaPromptFixo,
                condicaoPromptFixo,
                dadosCondicaoPromptFixo
            );
            
            // Garante que resultadosPromptFixo seja um array e adiciona aos assuntos
            let textosPromptFixo = [];

            if (Array.isArray(resultadosPromptFixo) && resultadosPromptFixo.length > 0) {
                textosPromptFixo = resultadosPromptFixo.map((registro) => ({
                    texto: registro.texto
                }));
            } else if (resultadosPromptFixo && typeof resultadosPromptFixo === 'object' && !Array.isArray(resultadosPromptFixo)) {
                // Se for objeto, converte para array e adiciona
                textosPromptFixo = Object.values(resultadosPromptFixo)
                    .filter(item => item && typeof item === 'object' && item.texto)
                    .map((registro) => ({
                        texto: registro.texto
                    }));
            }


            // Combina os assuntos com os prompts fixos
            if (textosPromptFixo.length > 0) {
                assuntos = [
                    ...assuntos,
                    ...textosPromptFixo
                ];

                displayLog('[ControleMD_agente_assuntos_nomes] Assuntos combinados:', {
                    quantidadeAssuntos: assuntos.length,
                    quantidadePromptsFixos: textosPromptFixo.length,
                    total: assuntos.length
                });
            }

            // return assuntos;

            let dominioCliente = '';
            let obsSolicitante = '';

            const idSolicitanteNumero = parseInt(idSolicitante, 10);

            if (!isNaN(idSolicitanteNumero) && idSolicitanteNumero > 0) {
                try {
                    // Cria conexão para o domínio do cliente
                    const domain = "mappsistemas.com";
                    const poolCliente = await getPoolForDomain(domain);

                    // Cria Entidade com a conexão do cliente
                    const dbCliente = {
                        dbClient: poolCliente,
                        dbMD: null
                    };
                    const entidadeCliente = new Entidade(dbCliente);
                    entidadeCliente.setConnection('client');

                    const obs = await entidadeCliente.selectRetornaRegistroUnico(
                        'obs',
                        'solicitante',
                        'id = :id',
                        { id: idSolicitanteNumero }
                    );

                    if (typeof obs === 'string' && obs.trim() !== '') {
                        obsSolicitante = obs;
                        dominioCliente = obs;
                    }
                } catch (errorSolicitante) {
                    // Erro silencioso - não quebra o fluxo se não conseguir buscar o domínio
                }
            }

            // Garante que assuntos seja sempre um array antes de retornar
            if (!Array.isArray(assuntos)) {
                if (assuntos && typeof assuntos === 'object') {
                    assuntos = Object.values(assuntos).filter(item => item && typeof item === 'object');
                } else {
                    assuntos = [];
                }
            }

            if (!assuntos || assuntos.length === 0) {
                return {
                    status: 'not_found',
                    message: 'Não foi encontrado nenhum prompt para essa configuração e tipo de agente. Não há nenhum prompt definido.',
                    idSolicitante,
                    idConfig,
                    tipoAgente,
                    quantidade: 0,
                    assuntos: [],
                    dominioCliente,
                    obsSolicitante,
                    ...dataHoraInfo
                };
            }

            displayLog('[ControleMD_agente_assuntos_nomes] Retornando assuntos:', {
                quantidade: assuntos.length,
                isArray: Array.isArray(assuntos),
                tipos: assuntos.map(a => typeof a)
            });

            return {
                status: 'ok',
                message: '',
                idSolicitante,
                idConfig,
                tipoAgente,
                quantidade: assuntos.length,
                assuntos: Array.isArray(assuntos) ? assuntos : [],
                dominioCliente,
                obsSolicitante,
                ...dataHoraInfo
            };
        } catch (error) {
            displayError('[ControleMD_agente_assuntos_nomes] Erro ao buscar assuntos:', {
                message: error.message,
                idSolicitante,
                idConfig,
                tipoAgente
            });
            displayError('[ControleMD_agente_assuntos_nomes] Stack:', error.stack);
            throw error;
        }
    }
}

