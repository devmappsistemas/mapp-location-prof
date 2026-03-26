import { Entidade } from "../../db/Entidade.js";
import { getDataHoraPorFuso } from "../../utils/fusoHorario.js";
import { obterVariantesTelefone9 } from "../../utils/telefoneHelper.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

export class ControleMDBusacarDadosUsuario {
    /**
         * Construtor da classe ControleMD_agente_conversas_mensagens
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
     * Valida e extrai os dados do webhook do WhatsApp
     * @param {Object} body - Body da requisição do webhook
     * @returns {Object} { success: boolean, dados: Object|null, message: string }
     */
    static validarExtrairDadosWebhook(body) {
        try {
            // Validação da estrutura do body
            if (!body || !body.entry || !Array.isArray(body.entry) || body.entry.length === 0) {
                return {
                    success: false,
                    dados: null,
                    message: 'Estrutura do body inválida: entry não encontrado'
                };
            }

            const entry = body.entry[0];
            if (!entry || !entry.changes || !Array.isArray(entry.changes) || entry.changes.length === 0) {
                return {
                    success: false,
                    dados: null,
                    message: 'Estrutura do body inválida: changes não encontrado'
                };
            }

            const change = entry.changes[0];
            if (!change || !change.value) {
                return {
                    success: false,
                    dados: null,
                    message: 'Estrutura do body inválida: value não encontrado'
                };
            }

            const value = change.value;

            // Verifica se é um webhook de mensagem recebida (tem contacts e messages)
            // Se for webhook de status (statuses), apenas retorna sem processar
            if (!value.contacts || !Array.isArray(value.contacts) || value.contacts.length === 0) {
                return {
                    success: false,
                    dados: null,
                    message: 'Webhook de status recebido, ignorando processamento'
                };
            }

            // Valida se metadata existe
            if (!value.metadata) {
                return {
                    success: false,
                    dados: null,
                    message: 'Metadata não encontrado'
                };
            }

            // Valida se messages existe e tem pelo menos uma mensagem
            if (!value.messages || !Array.isArray(value.messages) || value.messages.length === 0) {
                return {
                    success: false,
                    dados: null,
                    message: 'Messages não encontrado ou vazio'
                };
            }

            // Extrai os dados
            const numeroTelefoneMeta = value.metadata.display_phone_number;
            const identifcadorNumero = value.metadata.phone_number_id;
            const telefoneMsgRecebido = value.contacts[0].wa_id;
            const nomeContato = value.contacts[0].profile?.name || '';
            const tipoMensagem = value.messages[0].type || '';
            const mensagem = value.messages[0] || null;

            const dados = {
                numeroTelefoneMeta: numeroTelefoneMeta,
                identifcadorNumero: identifcadorNumero,
                telefoneMsgRecebido: telefoneMsgRecebido,
                nomeContato: nomeContato,
                tipoMensagem: tipoMensagem,
                mensagem: mensagem
            };

            return {
                success: true,
                dados: dados,
                message: 'Dados extraídos com sucesso'
            };
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao validar e extrair dados do webhook:', error.message);
            return {
                success: false,
                dados: null,
                message: `Erro ao processar webhook: ${error.message}`
            };
        }
    }

    async busacarDadosUsuario(dados) {
        try {
            // Validação de entrada
            if (!dados || typeof dados !== 'object') {
                throw new Error('Dados inválidos: objeto dados é obrigatório');
            }

            if (!dados.numeroTelefoneMeta || (typeof dados.numeroTelefoneMeta === 'string' && dados.numeroTelefoneMeta.trim() === '')) {
                throw new Error('Dados inválidos: numeroTelefoneMeta é obrigatório');
            }

            // Busca os dados do número sincronizado
            const dadosNumeroSincronizado = await this.buscarDadosNumeroSincronizado(dados);

            // Verifica se encontrou registro válido do número sincronizado
            if (dadosNumeroSincronizado.id && dadosNumeroSincronizado.id !== '') {
                // Busca o id do agente que enviou a mensagem na tabela agente_pedir
                const usuario = await this.buscarIdUsuarioEnviouMsg(dados, dadosNumeroSincronizado);

                let idAgentePedir = 0;
                let idKanbanMonitoramento = 0;
                let agenteResponde = '';

                // Se não encontrou o agente, insere nas tabelas
                if (!usuario || !usuario.id) {
                    idAgentePedir = await this.inserirAgentePedir(dados, dadosNumeroSincronizado);

                    if (idAgentePedir > 0) {
                        // Extrair texto da mensagem para usar como origem
                        const textoMensagem = dados.textoTranscrito || dados.mensagem?.text?.body || '';
                        
                        // Buscar origem do lead usando o texto da mensagem (apenasBuscar = true para mensagens normais)
                        let idOrigemLead = null;
                        if (textoMensagem && textoMensagem.trim() !== '') {
                            idOrigemLead = await this.buscarOuCriarOrigemLead(
                                textoMensagem.trim(),
                                null, // landingPage = null para mensagens normais
                                dadosNumeroSincronizado.idConfig,
                                dadosNumeroSincronizado.id,
                                true // apenasBuscar = true (não cria, só busca)
                            );
                        }

                        const resultadoKanban = await this.inserirAgenteKanbanMonitoramento(
                            dadosNumeroSincronizado, 
                            idAgentePedir, 
                            dados.telefoneMsgRecebido, 
                            dados.nomeContato,
                            idOrigemLead // adicionar este parâmetro
                        );
                        idKanbanMonitoramento = resultadoKanban.idInserido || 0;
                        agenteResponde = resultadoKanban.agenteResponde || '';
                    }
                } else {
                    // Se encontrou o usuário, busca o id na tabela agente_kanban_monitoramento
                    idAgentePedir = usuario.id;
                    let resultadoKanban = await this.buscarIdKanbanMonitoramento(dadosNumeroSincronizado, usuario.id);
                    idKanbanMonitoramento = resultadoKanban.id || 0;
                    agenteResponde = resultadoKanban.agenteResponde || '';

                    // Se não encontrou, insere na tabela agente_kanban_monitoramento
                    if (idKanbanMonitoramento === 0) {
                        // Extrair texto da mensagem para usar como origem
                        const textoMensagem = dados.textoTranscrito || dados.mensagem?.text?.body || '';
                        
                        // Buscar origem do lead usando o texto da mensagem (apenasBuscar = true para mensagens normais)
                        let idOrigemLead = null;
                        if (textoMensagem && textoMensagem.trim() !== '') {
                            idOrigemLead = await this.buscarOuCriarOrigemLead(
                                textoMensagem.trim(),
                                null, // landingPage = null para mensagens normais
                                dadosNumeroSincronizado.idConfig,
                                dadosNumeroSincronizado.id,
                                true // apenasBuscar = true (não cria, só busca)
                            );
                        }

                        resultadoKanban = await this.inserirAgenteKanbanMonitoramento(
                            dadosNumeroSincronizado, 
                            usuario.id, 
                            dados.telefoneMsgRecebido, 
                            dados.nomeContato,
                            idOrigemLead // adicionar este parâmetro
                        );
                        idKanbanMonitoramento = resultadoKanban.idInserido || 0;
                        agenteResponde = resultadoKanban.agenteResponde || '';
                    }
                }

                // Retorna todos os dados buscados/inseridos
                return {
                    success: true,
                    dadosNumeroSincronizado: dadosNumeroSincronizado,
                    identificadorNumero: dados.identificadorNumero ?? dados.identifcadorNumero ?? '',
                    idAgentePedir: idAgentePedir,
                    idKanbanMonitoramento: idKanbanMonitoramento,
                    agenteResponde: agenteResponde,
                    message: 'Dados processados com sucesso.'
                };
            }

            // Se não encontrou o número sincronizado
            return {
                success: false,
                dadosNumeroSincronizado: null,
                usuario: null,
                message: 'Não foi possível localizar dados para o número informado.'
            };

        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao salvar mensagem recebida:', error.message);
            displayError('[ControleMDSalvarMensagemRecebida] Stack:', error.stack);
            throw error;
        }
    }

    /**
     * Busca a coluna solicitante na tabela agente_pedir.
     * Filtra por id = idAgentePedir E idTelefoneConectado = idTelefoneConectado.
     * @param {number|string} idAgentePedir - ID da tabela agente_pedir (coluna id)
     * @param {number|string} idTelefoneConectado - ID na coluna idTelefoneConectado da tabela agente_pedir
     * @returns {Promise<string|null>} Valor da coluna solicitante ou null se não encontrar
     */
    async buscarSolicitantePorIdAgentePedirEIdTelConectado(idAgentePedir, idTelefoneConectado) {
        try {
            if (!idAgentePedir || idAgentePedir === '' || idAgentePedir === 0) {
                return null;
            }
            if (!idTelefoneConectado || idTelefoneConectado === '' || idTelefoneConectado === 0) {
                return null;
            }

            const entidadeAgente = new Entidade(this.db);
            entidadeAgente.setConnection('md');

            const campos = { idSolicitante: '' };
            const condicao = 'id = :idAgentePedir AND idTelefoneConectado = :idTelefoneConectado';
            const dadosCondicao = {
                idAgentePedir,
                idTelefoneConectado
            };

            const resultado = await entidadeAgente.selectRetornaArrayUnico(
                campos,
                'agente_pedir',
                condicao,
                dadosCondicao
            );

            if (resultado && resultado.idSolicitante != null && resultado.solicitante !== '') {
                return String(resultado.idSolicitante);
            }
            return null;
        } catch (error) {
            displayError('[ControleMDBusacarDadosUsuario] Erro ao buscar solicitante:', error.message);
            return null;
        }
    }

    /**
     * Busca o agente (tabela agente_pedir) relacionado à mensagem recebida
     * verificando se telefoneMsgRecebido está presente em whatsapp, whatsapp2 ou lid
     * e se dadosNumeroSincronizado.id está na coluna idTelefoneConectado.
     * @param {Object} dados - Dados recebidos da mensagem
     * @param {Object} dadosNumeroSincronizado - Registro da tabela agente_pedir_numero_sincronizado
     * @returns {Promise<Object>} Registro único da tabela agente_pedir (ou objeto vazio)
     */
    async buscarIdUsuarioEnviouMsg(dados, dadosNumeroSincronizado) {
        try {
            const entidadeAgente = new Entidade(this.db);
            entidadeAgente.setConnection('md');

            const tabelaAgente = 'agente_pedir';

            const telefoneMsgRecebido = String(dados.telefoneMsgRecebido || '').trim();

            if (!telefoneMsgRecebido) {
                return {};
            }

            const buscarPorTelefone = async (valorTelefone) => {
                const condicoes = [];
                const dadosCondicao = {};
                condicoes.push('(whatsapp = :telefone1 OR whatsapp2 = :telefone2 OR lid = :telefone3)');
                dadosCondicao.telefone1 = valorTelefone;
                dadosCondicao.telefone2 = valorTelefone;
                dadosCondicao.telefone3 = valorTelefone;
                if (dadosNumeroSincronizado.id && dadosNumeroSincronizado.id !== '') {
                    condicoes.push('idTelefoneConectado = :idTelefoneConectado');
                    dadosCondicao.idTelefoneConectado = dadosNumeroSincronizado.id;
                }
                const condicaoWhere = condicoes.join(' AND ');
                const campos = { id: '' };
                return await entidadeAgente.selectRetornaArrayUnico(campos, tabelaAgente, condicaoWhere, dadosCondicao);
            };

            let agente = await buscarPorTelefone(telefoneMsgRecebido);

            if (!agente || !agente.id) {
                const variantes = obterVariantesTelefone9(telefoneMsgRecebido);
                for (const variante of variantes) {
                    agente = await buscarPorTelefone(variante);
                    if (agente && agente.id) break;
                }
            }

            return agente || {};
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao buscar agente por mensagem:', error.message);
            displayError('[ControleMDSalvarMensagemRecebida] Stack:', error.stack);
            return {};
        }
    }

    /**
     * Busca dados do número sincronizado via INNER JOIN com agente_whatsapp_credenciais.
     * Filtra por validacaoNumero = dados.identificadorNumero (ou identifcadorNumero).
     * @param {Object} dados - Objeto com identificadorNumero (ou identifcadorNumero)
     * @returns {Promise<Object>} { id, idConfig, tipoAgente } de agente_pedir_numero_sincronizado
     */
    async buscarDadosNumeroSincronizado(dados) {
        try {

            displayWarn('buscarDadosNumeroSincronizado CHEGOU ******************                      ');

            if (!dados || typeof dados !== 'object') {
                throw new Error('Dados inválidos: objeto dados é obrigatório');
            }

            const identificador = String(dados.identificadorNumero ?? dados.identifcadorNumero ?? '').trim();
            if (!identificador) {
                throw new Error('Dados inválidos: identificadorNumero (ou identifcadorNumero) é obrigatório');
            }

          
            const sql = `
                SELECT id, idConfig, tipoAgente
                FROM agente_pedir_numero_sincronizado 
                WHERE validacaoNumeroMeta = ? AND status = 'A'
                LIMIT 1
            `;
          

            const [rows] = await this.entidade.connection.query(sql, [identificador]);
            const row = rows && rows[0];

            if (!row) {
                return { id: '', idConfig: '', tipoAgente: '' };
            }

            return {
                id: row.id,
                idConfig: row.idConfig ?? '',
                tipoAgente: row.tipoAgente ?? ''
            };
        } catch (error) {
            displayError('[ControleMDBusacarDadosUsuario] Erro ao buscar dados do número sincronizado:', error.message);
            displayError('[ControleMDBusacarDadosUsuario] identificadorNumero:', dados?.identificadorNumero ?? dados?.identifcadorNumero ?? 'não informado');
            displayError('[ControleMDBusacarDadosUsuario] Stack:', error.stack);
            throw error;
        }
    }

    /**
     * Determina em qual coluna salvar o telefone (whatsapp, whatsapp2 ou lid)
     * @param {string} telefoneMsgRecebido - Telefone recebido
     * @returns {Object} { campo: 'whatsapp'|'whatsapp2'|'lid', valor: string }
     */
    determinarCampoTelefone(telefoneMsgRecebido) {
        try {
            // Remove caracteres não numéricos
            const telefoneLimpo = String(telefoneMsgRecebido || '').replace(/\D/g, '');

            // Valida se tem pelo menos 10 dígitos (DDD + número)
            if (telefoneLimpo.length < 10) {
                return { campo: 'lid', valor: telefoneMsgRecebido };
            }

            // Pega os últimos 9 dígitos (número sem DDD)
            const numeroSemDDD = telefoneLimpo.slice(-9);

            // Se começar com 9 e tiver 9 dígitos, salva em whatsapp
            if (numeroSemDDD.startsWith('9') && numeroSemDDD.length === 9) {
                return { campo: 'whatsapp', valor: telefoneMsgRecebido };
            }

            // Se não começar com 9 mas tiver 8 ou 9 dígitos, salva em whatsapp2
            if (numeroSemDDD.length >= 8 && numeroSemDDD.length <= 9) {
                return { campo: 'whatsapp2', valor: telefoneMsgRecebido };
            }

            // Caso não bata com padrão de telefone, salva em lid
            return { campo: 'lid', valor: telefoneMsgRecebido };
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao determinar campo telefone:', error.message);
            // Em caso de erro, salva em lid como fallback
            return { campo: 'lid', valor: telefoneMsgRecebido };
        }
    }

    /**
     * Insere um novo registro na tabela agente_pedir
     * @param {Object} dados - Dados recebidos da mensagem
     * @param {Object} dadosNumeroSincronizado - Registro da tabela agente_pedir_numero_sincronizado
     * @returns {Promise<number>} ID do registro inserido (0 se falhar)
     */
    async inserirAgentePedir(dados, dadosNumeroSincronizado) {
        try {
            const entidadeAgente = new Entidade(this.db);
            entidadeAgente.setConnection('md');

            const telefoneMsgRecebido = String(dados.telefoneMsgRecebido || '').trim();

            if (!telefoneMsgRecebido) {
                displayError('[ControleMDSalvarMensagemRecebida] telefoneMsgRecebido é obrigatório para inserir agente');
                return 0;
            }

            if (!dadosNumeroSincronizado.id || dadosNumeroSincronizado.id === '') {
                displayError('[ControleMDSalvarMensagemRecebida] dadosNumeroSincronizado.id é obrigatório para inserir agente');
                return 0;
            }

            // Determina onde salvar o telefone
            const campoTelefone = this.determinarCampoTelefone(telefoneMsgRecebido);

            // Prepara dados para inserção
            const dadosInserir = {
                idTelefoneConectado: dadosNumeroSincronizado.id,
                tipoAgente: dadosNumeroSincronizado.tipoAgente || '',
                nome: String(dados.nomeContato || '').trim() || ''
            };

            // Adiciona o telefone no campo determinado
            dadosInserir[campoTelefone.campo] = campoTelefone.valor;

            const tabelaAgente = 'agente_pedir';
            const idInserido = await entidadeAgente.inserir(dadosInserir, tabelaAgente);

            if (idInserido > 0) {
                displayLog(`[ControleMDSalvarMensagemRecebida] Agente inserido com sucesso. ID: ${idInserido}, Campo: ${campoTelefone.campo}`);
            } else {
                displayError('[ControleMDSalvarMensagemRecebida] Falha ao inserir agente na tabela agente_pedir');
            }

            return idInserido;
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao inserir agente_pedir:', error.message);
            displayError('[ControleMDSalvarMensagemRecebida] Stack:', error.stack);
            return 0;
        }
    }

    /**
     * Busca dados da coluna kanban pelo tipo e ordem (= 1).
     * @param {string} tipoAgente - Tipo do agente
     * @returns {Promise<{id: number, agenteResponde: string}|null>} Dados da coluna ou null se não encontrar
     */
    async buscarIdColunaKanban(tipoAgente) {
        try {
            if (!tipoAgente || tipoAgente === '') {
                displayError('[ControleMDSalvarMensagemRecebida] tipoAgente é obrigatório para buscar coluna kanban');
                return null;
            }

            const entidadeKanban = new Entidade(this.db);
            entidadeKanban.setConnection('md');

            const tabelaColuna = 'agente_kanban_coluna';

            // Busca coluna por tipo e ordem = 1
            const condicao = 'tipo = :tipo AND ordem = :ordem';
            const dadosCondicao = {
                tipo: tipoAgente,
                ordem: 1
            };

            const campos = {
                id: '',
                agenteResponde: ''
            };

            const coluna = await entidadeKanban.selectRetornaArrayUnico(
                campos,
                tabelaColuna,
                condicao,
                dadosCondicao
            );

            const idColuna = parseInt(coluna?.id) || 0;
            if (idColuna > 0) {
                return {
                    id: idColuna,
                    agenteResponde: String(coluna?.agenteResponde || '')
                };
            }

            return null;
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao buscar coluna kanban:', error.message);
            displayError('[ControleMDSalvarMensagemRecebida] Stack:', error.stack);
            return null;
        }
    }

    /**
     * Busca o id na tabela agente_kanban_monitoramento por idTelConectado, idAgentePedir e idConfig.
     * O agenteResponde é obtido via buscarEstadoDoAgente (JOIN agente_kanban_monitoramento + agente_kanban_coluna).
     * @param {Object} dadosNumeroSincronizado - Registro da tabela agente_pedir_numero_sincronizado
     * @param {number} idAgentePedir - ID do agente na tabela agente_pedir
     * @returns {Promise<{id: number, agenteResponde: string}>} Objeto com id e agenteResponde ({id: 0, agenteResponde: ''} se não encontrar)
     */
    async buscarIdKanbanMonitoramento(dadosNumeroSincronizado, idAgentePedir) {
        try {
            if (!idAgentePedir || idAgentePedir === 0) {
                displayError('[ControleMDSalvarMensagemRecebida] idAgentePedir é obrigatório para buscar kanban monitoramento');
                return { id: 0, agenteResponde: '' };
            }

            if (!dadosNumeroSincronizado.id || dadosNumeroSincronizado.id === '') {
                displayError('[ControleMDSalvarMensagemRecebida] dadosNumeroSincronizado.id é obrigatório para buscar kanban monitoramento');
                return { id: 0, agenteResponde: '' };
            }

            const entidadeKanban = new Entidade(this.db);
            entidadeKanban.setConnection('md');

            const tabelaMonitoramento = 'agente_kanban_monitoramento';

            // Monta condição com os três campos
            const condicoes = [];
            const dadosCondicao = {};

            condicoes.push('idTelConectado = :idTelConectado');
            dadosCondicao.idTelConectado = dadosNumeroSincronizado.id;

            condicoes.push('idAgentePedir = :idAgentePedir');
            dadosCondicao.idAgentePedir = idAgentePedir;

            if (dadosNumeroSincronizado.idConfig && dadosNumeroSincronizado.idConfig !== '') {
                condicoes.push('idConfig = :idConfig');
                dadosCondicao.idConfig = dadosNumeroSincronizado.idConfig;
            }

            const condicaoWhere = condicoes.join(' AND ');

            const campos = {
                id: ''
            };

            const monitoramento = await entidadeKanban.selectRetornaArrayUnico(
                campos,
                tabelaMonitoramento,
                condicaoWhere,
                dadosCondicao
            );

            if (monitoramento && monitoramento.id) {
                const idMonitoramento = parseInt(monitoramento.id) || 0;

                // Busca o agenteResponde via buscarEstadoDoAgente (JOIN agente_kanban_monitoramento + agente_kanban_coluna)
                const resultadoEstado = await this.buscarEstadoDoAgente(idAgentePedir, dadosNumeroSincronizado.id);
                const agenteResponde = resultadoEstado.success ? (resultadoEstado.agenteResponde ?? '') : '';

                return {
                    id: idMonitoramento,
                    agenteResponde: agenteResponde
                };
            }

            return { id: 0, agenteResponde: '' };
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao buscar kanban monitoramento:', error.message);
            displayError('[ControleMDSalvarMensagemRecebida] Stack:', error.stack);
            return { id: 0, agenteResponde: '' };
        }
    }

    /**
     * Busca o estado do agente (agenteResponde) via JOIN entre agente_kanban_monitoramento e agente_kanban_coluna.
     * @param {number} idAgentePedir - ID do agente na tabela agente_pedir
     * @param {number} idTelConectado - ID do telefone conectado (agente_pedir_numero_sincronizado.id)
     * @returns {Promise<{success: boolean, agenteResponde?: string, message?: string}>} Objeto com success, agenteResponde (da coluna agente_kanban_coluna) ou message em caso de erro/ausência
     */
    async buscarEstadoDoAgente(idAgentePedir, idTelConectado) {
        try {
            const idAgente = parseInt(idAgentePedir, 10);
            const idTel = parseInt(idTelConectado, 10);

            if (!idAgente || idAgente <= 0) {
                return { success: false, message: 'idAgentePedir é obrigatório e deve ser um número maior que zero' };
            }

            if (!idTel || idTel <= 0) {
                return { success: false, message: 'idTelConectado é obrigatório e deve ser um número maior que zero' };
            }

            const sql = `
                SELECT akc.agenteResponde
                FROM agente_kanban_monitoramento akm
                INNER JOIN agente_kanban_coluna akc ON akm.id_coluna = akc.id
                WHERE akm.idAgentePedir = ? AND akm.idTelConectado = ?
                LIMIT 1
            `;

            const [rows] = await this.entidade.connection.query(sql, [idAgente, idTel]);
            const row = rows && rows[0];

            if (!row) {
                return { success: true, agenteResponde: '' };
            }

            return {
                success: true,
                agenteResponde: String(row.agenteResponde ?? '')
            };
        } catch (error) {
            displayError('[ControleMDBusacarDadosUsuario] Erro ao buscar estado do agente:', error.message);
            displayError('[ControleMDBusacarDadosUsuario] Stack:', error.stack);
            return { success: false, message: error.message };
        }
    }

    /**
     * Busca ou cria o id da origem do lead em agente_origens_leads
     * Quando apenasBuscar = true (mensagem normal), só busca por nome = mensagem, não cria.
     * Quando apenasBuscar = false (landing page), busca e cria se não encontrar.
     * @param {string|null} origem - Nome da origem (ou texto da mensagem quando apenasBuscar = true)
     * @param {string|null} landingPage - URL da landing page (opcional)
     * @param {number|null} idConfig - ID da configuração
     * @param {number|null} idNumeroSincronizado - ID do número sincronizado
     * @param {boolean} apenasBuscar - Se true, apenas busca sem criar (para mensagens normais)
     * @returns {Promise<number|null>} ID da origem ou null
     */
    async buscarOuCriarOrigemLead(origem, landingPage, idConfig = null, idNumeroSincronizado = null, apenasBuscar = false) {
        try {
            // Se nem origem nem landingPage vierem, retorna null
            if ((!origem || origem.trim() === '') && (!landingPage || landingPage.trim() === '')) {
                return null;
            }

            const tabelaOrigemLead = 'agente_origens_leads';
            const condicoes = [];
            const dadosCondicao = { status: 'A' };

            // Para mensagens normais, usa apenas o texto da mensagem (origem)
            // NÃO inclui landingPage na busca - só busca por nome, idConfig, idTelConectado e status
            if (origem && origem.trim() !== '') {
                condicoes.push('nome = :nome');
                dadosCondicao.nome = origem.trim();
            } else if (landingPage && landingPage.trim() !== '') {
                // Só landingPage veio: busca por nome = "vazio"
                condicoes.push('nome = :nome');
                dadosCondicao.nome = 'vazio';
            }

            // Inclui idConfig e idTelConectado na busca
            if (idConfig !== null && idConfig > 0) {
                condicoes.push('idConfig = :idConfig');
                dadosCondicao.idConfig = parseInt(idConfig);
            }

            if (idNumeroSincronizado !== null && idNumeroSincronizado > 0) {
                condicoes.push('idTelConectado = :idTelConectado');
                dadosCondicao.idTelConectado = parseInt(idNumeroSincronizado);
            }

            // Monta condição final com status
            condicoes.push('status = :status');
            const condicaoWhere = condicoes.join(' AND ');

            // Busca usando selectRetornaArrayUnico
            const campos = { id: '' };
            const registroOrigem = await this.entidade.selectRetornaArrayUnico(
                campos,
                tabelaOrigemLead,
                condicaoWhere,
                dadosCondicao
            );
            
            // Verifica se encontrou registro válido
            // selectRetornaArrayUnico retorna { id: '' } quando não encontra
            // Quando encontra, retorna rows[0] diretamente do MySQL, que pode ter id como número ou string
            let idEncontrado = false;
            let idOrigemLead = null;
            
            // Verifica se é o objeto padrão { id: '' } retornado quando não encontra
            const ehObjetoPadrao = registroOrigem && 
                                   typeof registroOrigem === 'object' && 
                                   registroOrigem.id === '' && 
                                   Object.keys(registroOrigem).length === 1;
            
            if (!ehObjetoPadrao && registroOrigem && registroOrigem.id !== undefined) {
                // Verifica se o id é válido (não vazio, não null, não undefined, e é um número válido > 0)
                const idRaw = registroOrigem.id;
                const idParsed = parseInt(idRaw);
                
                if (!isNaN(idParsed) && idParsed > 0) {
                    idEncontrado = true;
                    idOrigemLead = idParsed;
                }
            }

            if (idEncontrado && idOrigemLead) {
                // Encontrou, retorna o ID
                return idOrigemLead;
            } else if (apenasBuscar) {
                // Modo "mensagem": não insere em agente_origens_leads; retorna null
                return null;
            } else {
                // Não encontrou e não é apenasBuscar, cria um novo registro
                const dataCriacao = getDataHoraPorFuso('America/Sao_Paulo');

                const dadosInserirOrigem = {
                    status: 'A',
                    data_criacao: dataCriacao
                };

                // Adiciona origem
                if (origem && origem.trim() !== '') {
                    dadosInserirOrigem.nome = origem.trim();
                } else if (landingPage && landingPage.trim() !== '') {
                    dadosInserirOrigem.nome = 'vazio';
                }

                // Coluna landingPage (opcional)
                if (landingPage && landingPage.trim() !== '') {
                    dadosInserirOrigem.landingPage = landingPage.trim();
                }

                // Colunas idConfig e idTelConectado
                if (idConfig !== null && idConfig > 0) {
                    dadosInserirOrigem.idConfig = parseInt(idConfig);
                }
                if (idNumeroSincronizado !== null && idNumeroSincronizado > 0) {
                    dadosInserirOrigem.idTelConectado = parseInt(idNumeroSincronizado);
                }

                const idOrigemLead = await this.entidade.inserir(dadosInserirOrigem, tabelaOrigemLead);
                
                if (idOrigemLead && idOrigemLead > 0) {
                    return parseInt(idOrigemLead);
                } else {
                    displayError(`[ControleMDBusacarDadosUsuario] ❌ Erro ao criar origem do lead: origem=${origem}, landingPage=${landingPage}`);
                    return null;
                }
            }
        } catch (error) {
            displayError('[ControleMDBusacarDadosUsuario] ❌ Erro ao buscar ou criar origem do lead:', error.message);
            displayError('[ControleMDBusacarDadosUsuario] Stack:', error.stack);
            return null;
        }
    }

    /**
     * Insere um novo registro na tabela agente_kanban_monitoramento
     * @param {Object} dadosNumeroSincronizado - Registro da tabela agente_pedir_numero_sincronizado
     * @param {number} idAgentePedir - ID do agente inserido na tabela agente_pedir
     * @param {string} telefoneMsgRecebido - Número de telefone que será salvo na coluna nome
     * @param {string} nomeContato - Nome do contato que será concatenado com o telefone
     * @param {number|null} idOrigemLead - ID da origem do lead (opcional)
     * @returns {Promise<{idInserido: number, agenteResponde: string}>} ID do registro inserido e agenteResponde
     */
    async inserirAgenteKanbanMonitoramento(dadosNumeroSincronizado, idAgentePedir, telefoneMsgRecebido, nomeContato = '', idOrigemLead = null) {
        try {
            // Busca a coluna kanban antes de inserir
            const tipoAgente = dadosNumeroSincronizado.tipoAgente || '';
            const dadosColuna = await this.buscarIdColunaKanban(tipoAgente);
            const idColuna = dadosColuna?.id || 0;
            const agenteResponde = dadosColuna?.agenteResponde || '';

            if (idColuna === 0) {
                displayWarn(`[ControleMDSalvarMensagemRecebida] Coluna kanban não encontrada para tipoAgente: ${tipoAgente}, ordem: 1`);
                return { idInserido: 0, agenteResponde: '' };
            }

            const entidadeKanban = new Entidade(this.db);
            entidadeKanban.setConnection('md');

            const tabelaMonitoramento = 'agente_kanban_monitoramento';
            const dataCriado = getDataHoraPorFuso();

            // Prepara dados para inserção
            const nomeFormatado = String(nomeContato || '').trim();
            const telefoneFormatado = String(telefoneMsgRecebido || '').trim();
            const nomeCompleto = nomeFormatado 
                ? `${nomeFormatado} - ${telefoneFormatado}` 
                : telefoneFormatado;

            const dadosInserir = {
                idConfig: dadosNumeroSincronizado.idConfig || 0,
                idTelConectado: dadosNumeroSincronizado.id || 0,
                idAgentePedir: idAgentePedir,
                id_coluna: idColuna,
                data_criado: dataCriado,
                nome: nomeCompleto
            };

            // Adiciona id_origem_lead se fornecido
            if (idOrigemLead !== null && idOrigemLead > 0) {
                dadosInserir.id_origem_lead = parseInt(idOrigemLead);
            }

            const idInserido = await entidadeKanban.inserir(dadosInserir, tabelaMonitoramento);

            if (idInserido > 0) {
                displayLog(`[ControleMDSalvarMensagemRecebida] ✅ Registro inserido em agente_kanban_monitoramento. ID: ${idInserido}, idColuna: ${idColuna}, nome: ${dadosInserir.nome}`);
            } else {
                displayError('[ControleMDSalvarMensagemRecebida] ❌ Falha ao inserir registro na tabela agente_kanban_monitoramento');
            }

            return { idInserido, agenteResponde };
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao inserir agente_kanban_monitoramento:', error.message);
            displayError('[ControleMDSalvarMensagemRecebida] Stack:', error.stack);
            return { idInserido: 0, agenteResponde: '' };
        }
    }
}