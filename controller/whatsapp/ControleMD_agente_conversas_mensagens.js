import { Entidade } from "../../db/Entidade.js";
import { transcreverAudio, extrairTextoImagem } from "../../utils/openaiHelper.js";
import { EnviarMensagemMeta } from "./EnviarMensagemMeta.js";
import { ControleMD_agente_pedir_numero_sincronizado } from "./ControleMD_agente_pedir_numero_sincronizado.js";
import { ControleMD_agente_whatsapp_credenciais } from "./ControleMD_agente_whatsapp_credenciais.js";
import { DiscordNotifier } from "../../utils/discordNotifier.js";
import { formatarMensagemWhatsApp } from "../../utils/formatadorMensagemWhatsApp.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Classe ControleMD_agente_conversas_mensagens
 * Gerencia operações relacionadas a mensagens do WhatsApp na tabela agente_conversas_mensagens
 * Usa conexão MD (MD_CLMAPP)
 */
export class ControleMD_agente_conversas_mensagens {
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
        this.tabela = 'agente_conversas_mensagens';
    }

    async salvarMensagem(dadosMensagem) {
        let dados = dadosMensagem.dadosConteudo;

        const dadosInserir = {};

        if (dados.idAgentePedir !== undefined && dados.idAgentePedir !== null) {
            dadosInserir.idAgentePedir = dados.idAgentePedir;
        }
        if (dados.origem !== undefined && dados.origem !== null) {
            dadosInserir.origem = dados.origem;
        }

        const tipo = dados.tipo?.toLowerCase() || '';
        const conteudoOriginal = dados.conteudoOriginal || dados.conteudo;

        if (tipo === 'audio' && conteudoOriginal) {
            try {
                const transcricao = await transcreverAudio(null, conteudoOriginal);
                if (transcricao) {
                    dados.mensagem = transcricao;
                } else if (dados.nomeArquivo) {
                    dados.mensagem = dados.nomeArquivo;
                }
            } catch (error) {
                // Se falhar a transcrição, usar nome do arquivo como fallback
                dados.mensagem = dados.nomeArquivo || '';
            }
        }
        else if ((tipo === 'image' || tipo === 'imagem') && conteudoOriginal) {
            try {
                const descricao = await extrairTextoImagem(null, conteudoOriginal);
                if (descricao) {
                    dados.mensagem = descricao;
                }
            } catch (error) {
                // Se falhar a descrição, deixar mensagem vazia
                dados.mensagem = '';
            }
        }

        if (dados.mensagem !== undefined && dados.mensagem !== null && dados.mensagem !== '') {
            dadosInserir.mensagem = dados.mensagem;
        } else if (dados.conteudo !== undefined && dados.conteudo !== null && dados.conteudo !== '') {
            // Se não tiver mensagem mas tiver conteúdo, verificar se não é arquivo
            const tiposArquivo = ['audio', 'video', 'image', 'documento', 'imagem'];
            if (!tiposArquivo.includes(tipo)) {
                dadosInserir.mensagem = dados.conteudo;
            }
        }
        if (dados.descricao_imagem !== undefined && dados.descricao_imagem !== null) {
            dadosInserir.descricao_imagem = String(dados.descricao_imagem).trim();
        } else if (
            (tipo === 'image' || tipo === 'imagem' || tipo === 'video' || tipo === 'documento') &&
            dados.caption !== undefined &&
            dados.caption !== null
        ) {
            dadosInserir.descricao_imagem = String(dados.caption).trim();
        }
        if (dados.similaridade !== undefined && dados.similaridade !== null) {
            dadosInserir.similaridade = dados.similaridade;
        }
        if (dados.tipo !== undefined && dados.tipo !== null) {
            dadosInserir.tipo = '';
        }
        if (dados.timeData !== undefined && dados.timeData !== null) {
            dadosInserir.timeData = dados.timeData;
        }
        if (dados.dataHora !== undefined && dados.dataHora !== null) {
            dadosInserir.dataHora = dados.dataHora;
        }
        if (dados.id_coluna !== undefined && dados.id_coluna !== null) {
            dadosInserir.id_coluna = dados.id_coluna;
        }
        if (dados.quant_idColuna !== undefined && dados.quant_idColuna !== null) {
            dadosInserir.quant_idColuna = dados.quant_idColuna;
        }
        if (dados.validadoBase !== undefined && dados.validadoBase !== null) {
            dadosInserir.validadoBase = dados.validadoBase;
        }
        if (dados.documento !== undefined && dados.documento !== null) {
            dadosInserir.documento = dados.documento;
        }
        if (dados.audio !== undefined && dados.audio !== null) {
            dadosInserir.audio = dados.audio;
        }
        if (dados.duracao_audio !== undefined && dados.duracao_audio !== null) {
            dadosInserir.duracao_audio = dados.duracao_audio;
        }
        if (dados.video !== undefined && dados.video !== null) {
            dadosInserir.video = dados.video;
        }
        if (dados.idMsgMeta !== undefined && dados.idMsgMeta !== null) {
            dadosInserir.idMsgMeta = dados.idMsgMeta;
        }
        if (dados.type !== undefined && dados.type !== null && dados.type !== '') {
            dadosInserir.type = String(dados.type).substring(0, 20);
        }
        
        // Só envia ao Meta se a origem não for 'U' (mensagem recebida do usuário)
        // Mensagens com origem 'U' são recebidas, não enviadas
        // Se origem não estiver definida, também não envia (segurança)
        const origem = dadosInserir.origem || dados.origem || '';
        let resultadoMeta = null;

        if (origem && origem !== 'U') {
            try {

                displayLog('CHEGOU NA CONDIÇÃO DE ENVIAR MENSAGEM PARA META   /************');
                displayLog('dados:', JSON.stringify(dados, null, 2));
                displayLog('dadosInserir:', JSON.stringify(dadosInserir, null, 2));

                const idConfig = dadosMensagem.idConfig;
                const idTelConectado = dadosMensagem.idTelConectado;

                resultadoMeta = await this.enviarMensagemParaMeta(dados, dadosInserir);
            } catch (error) {
                // Envia notificação para Discord
                const tipoMensagem = dados.tipo || dadosInserir.tipo || 'texto';
                DiscordNotifier.enviarErroMeta('Chat WhatsApp - salvarMensagem/enviarMensagemParaMeta', error, {
                    tipoMensagem: tipoMensagem,
                    idAgentePedir: dadosInserir.idAgentePedir,
                    idConfig: dadosMensagem.idConfig,
                    idTelConectado: dadosMensagem.idTelConectado,
                    origem: dadosInserir.origem
                }).catch(err => displayError('[ControleMD_agente_conversas_mensagens] Erro ao enviar notificação Discord:', err));

                throw error; // Re-lança o erro para não salvar no banco
            }
        } else {
            // Log para debug (apenas em desenvolvimento)
            if (process.env.NODE_ENV === 'development') {
                displayLog(`[ControleMD_agente_conversas_mensagens] Mensagem não enviada ao Meta - origem: ${origem || 'não definida'}`);
            }
        }

        // Log para debug (apenas em desenvolvimento)
        if (process.env.NODE_ENV === 'development') {
            displayLog(`[ControleMD_agente_conversas_mensagens] `);
            console.log('dadosInserir:', JSON.stringify(dadosInserir, null, 2));
        }
        // Se chegou aqui, o envio ao Meta foi bem-sucedido (ou não precisa enviar)
        // Agora salva no banco de dados
        const resultado = await this.entidade.inserir(dadosInserir, this.tabela);

        return {
            idMensagem: resultado,
            resultadoMeta: resultadoMeta
        };
    }


    /**
     * Busca credenciais do WhatsApp Meta baseado em tipoAgente e idConfig
     * @param {string} tipoAgente - Tipo do agente
     * @param {string|number} idConfig - ID da configuração
     * @returns {Promise<Object|null>} Credenciais do Meta ou null se não encontrar
     */
    async buscarCredenciaisMeta(tipoAgente, idConfig) {
        try {
            if (!tipoAgente || tipoAgente.trim() === '') {
                return null;
            }

            if (!idConfig) {
                return null;
            }

            // Primeiro: buscar na tabela agente_pedir_numero_sincronizado
            const controleNumeroSincronizado = new ControleMD_agente_pedir_numero_sincronizado(this.db);
            const idTelConectado = await controleNumeroSincronizado.buscarIdPorIdConfigETipoAgente(idConfig, tipoAgente);

            if (!idTelConectado) {
                return null;
            }

            // Segundo: buscar na tabela agente_whatsapp_credenciais
            const controleCredenciais = new ControleMD_agente_whatsapp_credenciais(this.db);
            const credenciais = await controleCredenciais.buscarCredenciaisPorIdConfigEIdTelConectado(idConfig, idTelConectado);

            return credenciais;

        } catch (error) {
            return null;
        }
    }

    /**
     * Busca tipoAgente na tabela agente_pedir_numero_sincronizado por id (idTelConectado).
     * @param {string|number} idTelConectado - ID do registro (PK da tabela)
     * @returns {Promise<string|null>} tipoAgente ou null se não encontrar
     */
    async buscarTipoAgentePorIdTelConectado(idTelConectado) {
        try {
            if (!idTelConectado) {
                return null;
            }
            const sql = `SELECT tipoAgente FROM agente_pedir_numero_sincronizado WHERE id = ? AND status = 'A' LIMIT 1`;
            const [rows] = await this.db.dbMD.query(sql, [idTelConectado]);
            if (rows && rows.length > 0 && rows[0].tipoAgente) {
                return String(rows[0].tipoAgente).trim();
            }
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Busca o número de telefone do destinatário usando idAgentePedir
     * Busca primeiro em 'whatsapp', se não encontrar busca em 'whatsapp2'
     * @param {number} idAgentePedir - ID do agente pedir
     * @returns {Promise<string|null>} Número de telefone ou null se não encontrar
     */
    async buscarNumeroTelefone(idAgentePedir) {
        if (!idAgentePedir || idAgentePedir <= 0) {
            return null;
        }

        try {
            const sql = `SELECT whatsapp, whatsapp2 FROM agente_pedir WHERE id = ? LIMIT 1`;
            const [rows] = await this.db.dbMD.query(sql, [idAgentePedir]);

            if (rows && rows.length > 0) {
                const row = rows[0];
                // Busca primeiro em whatsapp, se não tiver busca em whatsapp2
                const numero = row.whatsapp || row.whatsapp2 || null;

                if (numero) {
                    return numero;
                }
            }

            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Envia mensagem via API do Meta ANTES de salvar no banco
     * Suporta diferentes tipos: texto, imagem, áudio, vídeo, documento
     * @param {Object} dados - Dados originais da mensagem
     * @param {Object} dadosInserir - Dados que serão inseridos no banco
     * @throws {Error} Se falhar o envio ao Meta
     */
    async enviarMensagemParaMeta(dados, dadosInserir) {
        // Buscar número de telefone usando idAgentePedir
        if (!dadosInserir.idAgentePedir) {
            return;
        }

        const idConfig = dados.idConfig;
        const idTelConectado = dados.idTelConectado;

        const numeroTelefone = await this.buscarNumeroTelefone(dadosInserir.idAgentePedir);

        if (!numeroTelefone) {
            return;
        }

        const numeroFormatado = String(numeroTelefone).trim();

        if (!numeroFormatado || numeroFormatado.length < 10) {
            throw new Error(`Número de telefone inválido para envio via Meta: ${numeroFormatado}`);
        }

        const tipo = dados.tipo?.toLowerCase() || '';

        // Buscar credenciais do Meta se tipoAgente e idConfig foram fornecidos
        let credenciaisMeta = null;
        if (dados.tipoAgente && dados.idConfig) {
            credenciaisMeta = await this.buscarCredenciaisMeta(dados.tipoAgente, dados.idConfig);
         
            if (credenciaisMeta && credenciaisMeta.accessToken) {
                displayLog(`[ControleMD_agente_conversas_mensagens] Credenciais Meta encontradas - phoneNumberId: ${credenciaisMeta.phoneNumberId}`);
            } else {
                displayWarn(`[ControleMD_agente_conversas_mensagens] Credenciais Meta não encontradas para tipoAgente: ${dados.tipoAgente}, idConfig: ${dados.idConfig}`);
            }
        } else {
            displayWarn(`[ControleMD_agente_conversas_mensagens] tipoAgente ou idConfig não fornecidos - tipoAgente: ${dados.tipoAgente}, idConfig: ${dados.idConfig}`);
        }

        if (!credenciaisMeta || !credenciaisMeta.accessToken) {
            throw new Error(`Credenciais do Meta não encontradas. É necessário tipoAgente e idConfig válidos para enviar mensagem.`);
        }

        const metaController = new EnviarMensagemMeta(credenciaisMeta);

        // Enviar mensagem de acordo com o tipo
        let resultado;

        if (tipo === 'texto' || (!tipo || tipo === '')) {
            // Mensagem de texto — reaproveita formatadorMensagemWhatsApp quando houver mensagem e identificador
            if (dadosInserir.mensagem) {
                const identificador = dados.identificador ?? dados.identificador ?? dados.nomeFuncionario;
                const textoParaMeta =
                    identificador != null && String(identificador).trim() !== ''
                        ? formatarMensagemWhatsApp(identificador, dadosInserir.mensagem)
                        : dadosInserir.mensagem;
                try {
                    resultado = await metaController.enviarTexto(
                        numeroFormatado,
                        textoParaMeta,
                        idConfig,
                        idTelConectado
                    );
                } catch (error) {
                    throw error;
                }
            }
        }
        else if (tipo === 'image' || tipo === 'imagem') {
            // Mensagem de imagem - URL está em dados.documento ou dadosInserir.documento
            // Priorizar caption explícita enviada pelo suporte
            const urlImagem = dados.documento || dadosInserir.documento;
            const legenda = (dados.caption !== undefined && dados.caption !== null)
                ? String(dados.caption).trim()
                : '';

            if (urlImagem) {
                try {
                    resultado = await metaController.enviarImagem(
                        numeroFormatado,
                        urlImagem,
                        legenda,
                        idConfig,
                        idTelConectado
                    );
                } catch (error) {
                    throw error;
                }
            } else {
                throw new Error('URL da imagem não encontrada para envio via Meta');
            }
        }
        else if (tipo === 'audio') {
            // Mensagem de áudio - URL está em dados.audio ou dadosInserir.audio
            const urlAudio = dados.audio || dadosInserir.audio;

            if (urlAudio) {
                try {
                    resultado = await metaController.enviarAudio(
                        numeroFormatado,
                        urlAudio,
                        idConfig,
                        idTelConectado
                    );
                } catch (error) {
                    throw error;
                }
            } else {
                throw new Error('URL do áudio não encontrada para envio via Meta');
            }
        }
        else if (tipo === 'video') {
            // Mensagem de vídeo - URL está em dados.documento ou dadosInserir.documento
            const urlVideo = dados.documento || dadosInserir.documento;
            const legenda = (dados.caption !== undefined && dados.caption !== null && String(dados.caption).trim() !== '')
                ? String(dados.caption).trim()
                : (dadosInserir.mensagem || '');

            if (urlVideo) {
                try {
                    resultado = await metaController.enviarVideo(
                        numeroFormatado,
                        urlVideo,
                        legenda,
                        idConfig,
                        idTelConectado
                    );
                } catch (error) {
                    throw error;
                }
            } else {
                throw new Error('URL do vídeo não encontrada para envio via Meta');
            }
        }
        else if (tipo === 'documento') {
            // Mensagem de documento - URL está em dados.documento ou dadosInserir.documento
            const urlDocumento = dados.documento || dadosInserir.documento;
            const nomeArquivo = dados.nomeArquivo || 'documento';
            const legenda = dadosInserir.mensagem || '';

            if (urlDocumento) {
                try {
                    resultado = await metaController.enviarDocumento(
                        numeroFormatado,
                        urlDocumento,
                        nomeArquivo,
                        legenda,
                        idConfig,
                        idTelConectado
                    );
                } catch (error) {
                    throw error;
                }
            } else {
                throw new Error('URL do documento não encontrada para envio via Meta');
            }
        }
        else if (tipo === 'template') {
            // Mensagem de template - envia usando API oficial do WhatsApp
            const templateName = dados.templateName;
            const language = dados.templateData?.language || 'pt_BR';
            const parameterFormat = dados.templateData?.parameter_format || 'POSITIONAL';

            // Tenta obter os parâmetros de diferentes fontes possíveis
            // Para templates NAMED, verifica primeiro templateParameters
            let templateParams = null;

            if (parameterFormat === 'NAMED') {
                // Para templates NAMED, verifica templateParameters primeiro
                templateParams = dados.templateParameters || dados.templateData?.templateParameters || null;

                if (templateParams && Array.isArray(templateParams) && templateParams.length > 0) {
                    // Extrai a ordem dos parâmetros do templateData
                    let paramOrder = [];
                    if (dados.templateData?.components && Array.isArray(dados.templateData.components)) {
                        for (const component of dados.templateData.components) {
                            if (component.type === 'BODY' && component.example?.body_text_named_params) {
                                paramOrder = component.example.body_text_named_params.map(p => p.param_name);
                                break;
                            }
                        }
                    }

                    // Converte templateParameters para o formato esperado pela API do Meta
                    // Formato esperado: array de objetos com { type: 'text', parameter_name: 'nome', text: 'valor' }
                    const formattedParams = [];

                    if (paramOrder.length > 0) {
                        // Processa na ordem definida no template
                        paramOrder.forEach((paramName) => {
                            const param = templateParams.find(p => p.key === paramName || p.parameter_name === paramName);
                            if (param && param.text) {
                                formattedParams.push({
                                    type: param.type || 'text',
                                    parameter_name: paramName,
                                    text: String(param.text)
                                });
                            }
                        });
                    } else {
                        // Se não tiver ordem definida, usa a ordem do array
                        templateParams.forEach((param) => {
                            const paramName = param.key || param.parameter_name || param.placeholder?.replace(/\{\{|\}\}/g, '');
                            if (paramName && param.text) {
                                formattedParams.push({
                                    type: param.type || 'text',
                                    parameter_name: paramName,
                                    text: String(param.text)
                                });
                            }
                        });
                    }

                    templateParams = formattedParams;
                } else {
                    // Tenta outros campos como fallback
                    templateParams = dados.templateParams || dados.parametros || dados.params || dados.templateValues || [];
                }
            } else {
                // Para templates POSITIONAL, usa o formato antigo
                templateParams = dados.templateParams || dados.parametros || dados.params || dados.templateValues || [];

                // Se templateParams não for array, tenta converter
                if (templateParams && !Array.isArray(templateParams)) {
                    if (typeof templateParams === 'string') {
                        try {
                            templateParams = JSON.parse(templateParams);
                        } catch (e) {
                            templateParams = templateParams.split(',').map(p => p.trim()).filter(p => p);
                        }
                    } else if (typeof templateParams === 'object') {
                        templateParams = Object.values(templateParams);
                    } else {
                        templateParams = [];
                    }
                }
            }

            // Log para debug - mostra todos os campos disponíveis
            displayLog('[ControleMD_agente_conversas_mensagens] DEBUG Template - campos disponíveis:');
            displayLog('  - templateName:', templateName);
            displayLog('  - language:', language);
            displayLog('  - parameterFormat:', parameterFormat);
            displayLog('  - templateParameters:', dados.templateParameters);
            displayLog('  - templateParams (original):', dados.templateParams);
            displayLog('  - parametros:', dados.parametros);
            displayLog('  - params:', dados.params);
            displayLog('  - templateValues:', dados.templateValues);
            displayLog('  - templateParams (processado):', templateParams);

            // Valida se o template requer parâmetros
            if (parameterFormat === 'POSITIONAL') {
                const mensagemTemplate = dados.mensagem || dadosInserir.mensagem || '';
                const matches = mensagemTemplate.match(/\{\{(\d+)\}\}/g);
                const numParamsNecessarios = matches ? Math.max(...matches.map(m => parseInt(m.match(/\d+/)[0]))) : 0;

                displayLog(`[ControleMD_agente_conversas_mensagens] Template requer ${numParamsNecessarios} parâmetro(s), mas ${templateParams.length} foi(foram) fornecido(s)`);

                if (numParamsNecessarios > 0 && templateParams.length === 0) {
                    displayError(`[ControleMD_agente_conversas_mensagens] ERRO: Template "${templateName}" requer ${numParamsNecessarios} parâmetro(s), mas nenhum foi fornecido!`);
                    displayError('[ControleMD_agente_conversas_mensagens] Verifique se os parâmetros estão sendo enviados no campo "templateParams", "parametros", "params" ou "templateValues"');
                }
            }

            if (!templateName) {
                throw new Error('Nome do template não fornecido para envio via Meta');
            }

            try {
                resultado = await metaController.enviarTemplate(
                    numeroFormatado,
                    templateName,
                    language,
                    templateParams,
                    parameterFormat
                );
            } catch (error) {
                throw error;
            }
        }

        // Salva o ID da mensagem do Meta (wamid) se o envio foi bem-sucedido
        if (resultado && resultado.success && resultado.messageId) {
            dadosInserir.idMsgMeta = resultado.messageId;
        }

        // Retorna o resultado completo do Meta (incluindo o body completo)
        return resultado;
    }

    async marcarMsgLida(dados) {

        if (!dados.idAgentePedir) {
            return;
        }

        const numeroTelefone = await this.buscarNumeroTelefone(dados.idAgentePedir);

        if (!numeroTelefone) {
            return;
        }

        const numeroFormatado = String(numeroTelefone).trim();

        if (!numeroFormatado || numeroFormatado.length < 10) {
            throw new Error(`Número de telefone inválido para envio via Meta: ${numeroFormatado}`);
        }

        const tipo = dados.tipo?.toLowerCase() || '';

        // Buscar credenciais do Meta se tipoAgente e idConfig foram fornecidos
        let credenciaisMeta = null;
        if (dados.tipoAgente && dados.idConfig) {
            credenciaisMeta = await this.buscarCredenciaisMeta(dados.tipoAgente, dados.idConfig);
        }

        const metaController = new EnviarMensagemMeta(credenciaisMeta || {});
        let resultado;

        try {
            resultado = await metaController.marcarMsgLidas(dados.messageId);
        } catch (error) {
            throw error;
        }

        return resultado;
    }

    /**
     * Busca mensagem por idMsgMeta (wamid)
     * @param {string} idMsgMeta - ID da mensagem do Meta (wamid)
     * @returns {Promise<{ id: number, mensagem: string, idAgentePedir: number }|null>}
     */
    async buscarMensagemPorIdMsgMeta(idMsgMeta) {
        try {
            if (!idMsgMeta || typeof idMsgMeta !== 'string' || idMsgMeta.trim() === '') {
                return null;
            }
            const sql = `SELECT id, mensagem, idAgentePedir FROM ${this.tabela} WHERE idMsgMeta = ? LIMIT 1`;
            const [rows] = await this.entidade.connection.query(sql, [idMsgMeta.trim()]);
            if (rows && rows.length > 0) {
                const r = rows[0];
                return {
                    id: r.id,
                    mensagem: r.mensagem || '',
                    idAgentePedir: r.idAgentePedir
                };
            }
            return null;
        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao buscar mensagem por idMsgMeta:', error.message);
            return null;
        }
    }

    /**
     * Atualiza o status da mensagem na tabela agente_conversas_mensagens
     * @param {string} id - ID da mensagem do Meta (idMsgMeta)
     * @param {string} status - Status da mensagem (ex: 'sent', 'delivered', 'read', 'failed')
     * @param {Array|null} erros - Array de erros do webhook (opcional, usado quando status='failed')
     * @returns {Promise<Object>} Resultado da atualização { success: boolean, message: string }
     */
    async atualizaStatusMsg(id, status, erros = null) {
        try {
            // Valida parâmetros
            if (!id || typeof id !== 'string' || id.trim() === '') {
                return {
                    success: false,
                    message: 'ID da mensagem (idMsgMeta) não fornecido ou inválido'
                };
            }

            if (!status || typeof status !== 'string' || status.trim() === '') {
                return {
                    success: false,
                    message: 'Status não fornecido ou inválido'
                };
            }

            // Atualiza o status na tabela usando idMsgMeta
            const condicao = 'idMsgMeta = :idMsgMeta';
            const dadosCondicao = {
                idMsgMeta: id.trim()
            };
            const dadosAtualizar = {
                statusMsg: status.trim()
            };
            if (erros != null && Array.isArray(erros)) {
                dadosAtualizar.erros = JSON.stringify(erros);
            }

            const resultado = await this.entidade.update(
                dadosAtualizar,
                this.tabela,
                condicao,
                dadosCondicao
            );

            if (resultado) {
                return {
                    success: true,
                    message: 'Status da mensagem atualizado com sucesso'
                };
            } else {
                return {
                    success: false,
                    message: 'Nenhuma mensagem encontrada com o idMsgMeta fornecido'
                };
            }

        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao atualizar status da mensagem:', error.message);
            return {
                success: false,
                message: `Erro ao atualizar status da mensagem: ${error.message}`
            };
        }
    }

    /**
     * Busca mensagens da conversa por idAgentePedir, idTelConectado e idMensagem
     * Retorna mensagens com id <= idMensagem (a partir da mensagem informada para baixo).
     * Filtra mensagem não nula e não vazia. Ordena por id do maior para o menor.
     * @param {string|number} idAgentePedir - ID do agente pedir
     * @param {string|number} idTelConectado - ID do telefone conectado
     * @param {number} idMensagem - ID da mensagem a partir da qual buscar (ex.: 1200 -> busca id <= 1200)
     * @param {number} limite - Limite de mensagens a retornar (padrão: 100)
     * @returns {Promise<Array>} Array de mensagens com id, origem, mensagem, dataHora, timeData
     */
    async buscarMensagensSuporte2(idAgentePedir, idTelConectado, idMensagem, limite = 10) {
        try {
            if (!idAgentePedir || idAgentePedir <= 0) {
                return [];
            }

            if (!idTelConectado || idTelConectado <= 0) {
                return [];
            }

            if (!idMensagem || idMensagem <= 0) {
                return [];
            }

            // Usa a classe Entidade através da conexão para executar query com JOIN
            // Busca mensagens com id <= idMensagem; filtra mensagem não nula e não vazia; ordena por id DESC (maior para menor)
            const sql = `
                SELECT 
                    acm.id, 
                    acm.origem, 
                    acm.mensagem, 
                    acm.dataHora, 
                    acm.timeData 
                FROM agente_conversas_mensagens acm
                INNER JOIN agente_pedir ap ON acm.idAgentePedir = ap.id
                WHERE acm.idAgentePedir = ? 
                  AND ap.idTelefoneConectado = ? 
                  AND acm.id <= ?
                  AND acm.mensagem IS NOT NULL 
                  AND TRIM(acm.mensagem) != ''
                ORDER BY acm.id DESC
                LIMIT ?
            `;

            const [rows] = await this.entidade.connection.query(sql, [idAgentePedir, idTelConectado, idMensagem, limite]);

            if (rows && rows.length > 0) {
                return rows.map(row => ({
                    id: row.id,
                    origem: row.origem,
                    mensagem: row.mensagem || '',
                    dataHora: row.dataHora,
                    timeData: row.timeData
                }));


            }

            return [];
        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao buscar mensagens:', error.message);
            return [];
        }
    }

    /**
   * Busca mensagens após a última do Agente (origem 'A').
   * 1) Busca o último id onde origem = 'A'.
   * 2) Busca mensagens com id > idUltimaA e, se ids informado, acm.id NOT IN (ids).
   * @param {string|number} idAgentePedir - ID do agente pedir
   * @param {string|number} idTelConectado - ID do telefone conectado
   * @param {Array<number>|null|undefined} ids - Opcional. Se passado e não vazio, exclui essas mensagens (acm.id NOT IN (ids))
   * @param {number} limite - Limite de mensagens (padrão 100)
   * @returns {Promise<Array<{id, origem, mensagem, dataHora, timeData}>>}
   */
    async buscarMensagensSuporte(idAgentePedir, idTelConectado, ids, limite = 100) {
        try {
            if (!idAgentePedir || idAgentePedir <= 0) return [];
            if (!idTelConectado || idTelConectado <= 0) return [];

            const baseWhere = `
                FROM agente_conversas_mensagens acm
                INNER JOIN agente_pedir ap ON acm.idAgentePedir = ap.id
                WHERE acm.idAgentePedir = ? AND ap.idTelefoneConectado = ?
                  AND acm.mensagem IS NOT NULL AND TRIM(acm.mensagem) != ''
            `;

            /*
            displayLog(`[ControleMD_agente_conversas_mensagens] idAgentePedir: ${idAgentePedir}`);
            displayLog(`[ControleMD_agente_conversas_mensagens] idTelConectado: ${idTelConectado}`);
            displayLog(`[ControleMD_agente_conversas_mensagens] ids: ${JSON.stringify(ids)}`);
            displayLog(`[ControleMD_agente_conversas_mensagens] limite: ${limite}`);
            displayLog(`[ControleMD_agente_conversas_mensagens] SQL: SELECT acm.id ${baseWhere} AND acm.origem = 'A' ORDER BY acm.id DESC LIMIT 1`);
*/
            // Query 1: último id onde origem = 'A'
            const [ultimaARows] = await this.entidade.connection.query(
                `SELECT acm.id ${baseWhere} AND acm.origem = 'A' ORDER BY acm.id DESC LIMIT 1`,
                [idAgentePedir, idTelConectado]
            );
            const ultimaA = ultimaARows?.[0];

            const idsString = ids != null && Array.isArray(ids) && ids.length > 0 ? ids.toString() : null;
            const notInClause = idsString != null ? ` AND acm.id NOT IN (${idsString})` : '';


            let rows;
            if (!ultimaA) {
                // Busca sem acm.id > ? (não há última mensagem do Agente)
                /*
                displayLog(`[ControleMD_agente_conversas_mensagens] SQL: SELECT acm.id, acm.origem, acm.mensagem, acm.dataHora, acm.timeData
                     SELECT acm.id, acm.origem, acm.mensagem, acm.dataHora, acm.timeData
                     ${baseWhere} ${notInClause}
                     ORDER BY acm.id ASC LIMIT ${limite}`);
                     */

                const [r] = await this.entidade.connection.query(
                    `SELECT acm.id, acm.origem, acm.mensagem, acm.dataHora, acm.timeData, acm.statusMsg, acm.erros
                     ${baseWhere} ${notInClause}
                     ORDER BY acm.id ASC LIMIT ?`,
                    [idAgentePedir, idTelConectado, limite]
                );
                rows = r;
            } else {
                // Query 2: mensagens com id > idUltimaA e opcionalmente NOT IN (ids)
                const idUltimaA = ultimaA.id;
                /*
                displayLog(`[ControleMD_agente_conversas_mensagens] SQL: SELECT acm.id, acm.origem, acm.mensagem, acm.dataHora, acm.timeData
                     ${baseWhere} AND acm.id > ? ${notInClause}
                     ORDER BY acm.id ASC LIMIT ${limite} `);
                     */

                const [r] = await this.entidade.connection.query(
                    `SELECT acm.id, acm.origem, acm.mensagem, acm.dataHora, acm.timeData, acm.statusMsg, acm.erros
                     ${baseWhere} AND acm.id > ? ${notInClause}
                     ORDER BY acm.id ASC LIMIT ?`,
                    [idAgentePedir, idTelConectado, idUltimaA, limite]
                );
                rows = r;
            }

            if (!rows || !rows.length) return [];

            // Extrair type do JSON em mensagem quando for objeto com type (ex.: contacts)
            const parseType = (mensagem) => {
                try {
                    const parsed = JSON.parse(mensagem || '{}');
                    return (parsed && typeof parsed.type === 'string') ? parsed.type : 'text';
                } catch { return 'text'; }
            };

            return rows.map(row => ({
                id: row.id,
                origem: row.origem,
                mensagem: row.mensagem || '',
                dataHora: row.dataHora,
                timeData: row.timeData,
                type: parseType(row.mensagem),
                statusMsg: row.statusMsg || null,
                erros: row.erros ? (typeof row.erros === 'string' ? (() => { try { return JSON.parse(row.erros); } catch { return null; } })() : row.erros) : null
            }));

        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao buscarMensagensSuporte:', error.message);
            return [];
        }
    }

    /**
     * Busca a última mensagem (mais recente por timeData) para idAgentePedir e idTelConectado.
     * Usado pelo runner de automações para decidir envio de template vs mensagem fixa.
     * @param {string|number} idTelConectado - ID do telefone conectado (agente_pedir.idTelefoneConectado)
     * @param {string|number} idAgentePedir - ID do agente pedir
     * @returns {Promise<{ success: boolean, data?: { idm, idAgentePedir, timeData, dataHora } }>}
     */
    async buscarUltimaMensagemPorAgente(idTelConectado, idAgentePedir) {
        try {
            if (!idTelConectado || !idAgentePedir) {
                return { success: false };
            }
            const sql = `
                SELECT
                    m.id AS idm,
                    m.idAgentePedir as idAgentePedir,
                    m.timeData as timeData,
                    m.dataHora as dataHora
                FROM agente_conversas_mensagens m
                INNER JOIN agente_pedir p ON p.id = m.idAgentePedir
                WHERE p.idTelefoneConectado = ?
                  AND m.idAgentePedir = ?
                  AND m.origem = 'U'
                ORDER BY m.timeData DESC
                LIMIT 1
            `;
            const [rows] = await this.entidade.connection.query(sql, [idTelConectado, idAgentePedir]);
            const data = rows && rows.length > 0 ? rows[0] : null;
            return { success: true, data };
        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao buscarUltimaMensagemPorAgente:', error.message);
            return { success: false };
        }
    }

    /**
     * Busca reação existente por idMsgMeta (= message_id da mensagem reagida).
     * Usado para atualizar reação quando o usuário troca o emoji (ex.: 👍 → ❤️).
     * @param {string|number} idAgentePedir - ID do agente pedir
     * @param {string} messageIdRef - message_id do corpo (idMsgMeta da mensagem reagida)
     * @returns {Promise<{ id: number }|null>} Objeto com id da reação ou null se não encontrar
     */
    async buscarReactionPorMessageIdRef(idAgentePedir, messageIdRef) {
        try {
            if (!idAgentePedir || !messageIdRef || String(messageIdRef).trim() === '') {
                return null;
            }
            const sql = `
                SELECT id FROM ${this.tabela}
                WHERE idAgentePedir = ?
                  AND origem = 'U'
                  AND idMsgMeta = ?
                LIMIT 1
            `;
            const [rows] = await this.entidade.connection.query(sql, [idAgentePedir, String(messageIdRef).trim()]);
            if (rows && rows.length > 0 && rows[0].id) {
                return { id: rows[0].id };
            }
            return null;
        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao buscarReactionPorMessageIdRef:', error.message);
            return null;
        }
    }

    /**
     * Atualiza reação existente (emoji, dataHora, timeData).
     * @param {number} id - ID do registro da reação
     * @param {Object} dados - Dados a atualizar
     * @param {string} dados.mensagem - JSON da reação (type, emoji, message_id)
     * @param {string} dados.dataHora - Data e hora formatada
     * @param {number} dados.timeData - Timestamp Unix
     * @returns {Promise<boolean>} true se atualizou com sucesso
     */
    async atualizarReaction(id, dados) {
        try {
            if (!id || id <= 0) {
                return false;
            }
            const dadosAtualizar = {};
            if (dados.mensagem !== undefined && dados.mensagem !== null) {
                dadosAtualizar.mensagem = dados.mensagem;
            }
            if (dados.dataHora !== undefined && dados.dataHora !== null) {
                dadosAtualizar.dataHora = dados.dataHora;
            }
            if (dados.timeData !== undefined && dados.timeData !== null) {
                dadosAtualizar.timeData = dados.timeData;
            }
            if (Object.keys(dadosAtualizar).length === 0) {
                return false;
            }
            const condicao = 'id = :id';
            const dadosCondicao = { id };
            return await this.entidade.update(dadosAtualizar, this.tabela, condicao, dadosCondicao);
        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao atualizarReaction:', error.message);
            return false;
        }
    }

    /**
     * Salva mensagem do suporte no banco de dados
     * @param {Object} dados - Dados da mensagem
     * @param {number} dados.idAgentePedir - ID do agente pedir
     * @param {string} dados.origem - Origem da mensagem (U = usuário/enviada, A/E = agente/recebida)
     * @param {string} dados.mensagem - Conteúdo da mensagem
     * @param {string} dados.tipo - Tipo da mensagem (padrão: '')
     * @param {string} dados.dataHora - Data e hora da mensagem
     * @param {number} dados.timeData - Timestamp da mensagem
     * @param {string} dados.documento - URL do documento (opcional)
     * @param {string} dados.audio - URL do áudio (opcional)
     * @returns {Promise<Object>} Resultado com idMensagem ou null em caso de erro
     */
    async salvarMensagemSuporte(dados) {
        try {
            // Validar dados obrigatórios
            if (!dados.idAgentePedir || dados.idAgentePedir <= 0) {
                displayWarn('[ControleMD_agente_conversas_mensagens] idAgentePedir não fornecido ou inválido');
                return null;
            }

            if (!dados.origem || typeof dados.origem !== 'string') {
                displayWarn('[ControleMD_agente_conversas_mensagens] origem não fornecida ou inválida');
                return null;
            }

            // Preparar dados para inserção
            const dadosInserir = {
                idAgentePedir: dados.idAgentePedir,
                origem: dados.origem,
                tipo: dados.tipo || '',
                timeData: dados.timeData || Math.floor(Date.now() / 1000)
            };

            // Adicionar mensagem se fornecida
            if (dados.mensagem !== undefined && dados.mensagem !== null && dados.mensagem !== '') {
                dadosInserir.mensagem = dados.mensagem;
            }
            if (dados.descricao_imagem !== undefined && dados.descricao_imagem !== null) {
                dadosInserir.descricao_imagem = String(dados.descricao_imagem).trim();
            } else if (dados.caption !== undefined && dados.caption !== null) {
                dadosInserir.descricao_imagem = String(dados.caption).trim();
            }

            // Adicionar dataHora se fornecida
            if (dados.dataHora !== undefined && dados.dataHora !== null && dados.dataHora !== '') {
                dadosInserir.dataHora = dados.dataHora;
            }

            // Adicionar documento apenas se fornecido e não vazio
            if (dados.documento !== undefined && dados.documento !== null && dados.documento !== '') {
                dadosInserir.documento = dados.documento;
            }

            // Adicionar audio apenas se fornecido e não vazio
            if (dados.audio !== undefined && dados.audio !== null && dados.audio !== '') {
                dadosInserir.audio = dados.audio;
            }

            // Id e nome do funcionário (suporte) — para o painel exibir quem enviou a mensagem
            if (dados.idFuncionario !== undefined && dados.idFuncionario !== null && dados.idFuncionario !== '') {
                dadosInserir.idFuncionario = dados.idFuncionario;
            }
            if (dados.nomeFuncionario !== undefined && dados.nomeFuncionario !== null && dados.nomeFuncionario !== '') {
                dadosInserir.nomeFuncionario = dados.nomeFuncionario;
            }

            // Inserir no banco de dados
            const resultado = await this.entidade.inserir(dadosInserir, this.tabela);

            displayLog(`[ControleMD_agente_conversas_mensagens] Mensagem do suporte salva com sucesso - ID: ${resultado}`);

            return {
                idMensagem: resultado,
                success: true
            };

        } catch (error) {
            displayError('[ControleMD_agente_conversas_mensagens] Erro ao salvar mensagem do suporte:', error.message);
            return null;
        }
    }
}
