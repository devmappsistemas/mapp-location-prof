import { DiscordNotifier } from '../../utils/discordNotifier.js';
import { log as displayLog, warn as displayWarn, error as displayError } from '../../utils/displayLogWebhook.js';

/**
 * Classe EnviarMensagemMeta
 * Gerencia o envio de mensagens para a API oficial do Meta (WhatsApp Business API)
 */
export class EnviarMensagemMeta {
    /**
     * Construtor da classe EnviarMensagemMeta
     * @param {Object} config - Configurações da API do Meta
     * @param {string} config.accessToken - Token de acesso da API do Meta
     * @param {string} config.phoneNumberId - ID do número de telefone do WhatsApp Business
     * @param {string} config.apiVersion - Versão da API (padrão: v24.0)
     */
    constructor(config = {}) {
        this.accessToken = config.accessToken || process.env.META_ACCESS_TOKEN || '';
        this.phoneNumberId = config.phoneNumberId || process.env.META_PHONE_NUMBER_ID || '';
        this.apiVersion = config.apiVersion || process.env.META_API_VERSION || 'v24.0';
        this.baseUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
    }

    /**
     * Valida se as configurações necessárias estão presentes
     * @throws {Error} Se faltar configuração obrigatória
     */
    validarConfiguracao() {
        if (!this.accessToken) {
            throw new Error('META_ACCESS_TOKEN não configurado');
        }
        if (!this.phoneNumberId) {
            throw new Error('META_PHONE_NUMBER_ID não configurado');
        }
    }

    /**
     * Formata número de telefone para o formato internacional (E.164)
     * @param {string} numero - Número de telefone (pode ter ou não código do país)
     * @returns {string} Número formatado no padrão E.164
     * @throws {Error} Se o número for inválido
     */
    formatarNumero(numero) {
        if (!numero || typeof numero !== 'string') {
            throw new Error('Número de telefone inválido: valor vazio ou não é string');
        }

        // Remove espaços e caracteres não numéricos (exceto +)
        let numeroLimpo = numero.trim().replace(/[^\d+]/g, '');

        // Se já começar com +, remove para processar
        const temMais = numeroLimpo.startsWith('+');
        if (temMais) {
            numeroLimpo = numeroLimpo.substring(1);
        }

        // Remove todos os caracteres não numéricos restantes
        numeroLimpo = numeroLimpo.replace(/\D/g, '');

        // Valida se tem pelo menos 10 dígitos (número mínimo válido)
        if (numeroLimpo.length < 10) {
            throw new Error(`Número de telefone muito curto: ${numeroLimpo.length} dígitos`);
        }

        // Se não começar com código do país, assume Brasil (55)
        // Números brasileiros têm 10 ou 11 dígitos (sem código do país)
        if (!numeroLimpo.startsWith('55') && numeroLimpo.length <= 11) {
            // Remove zeros à esquerda do DDD se houver
            if (numeroLimpo.startsWith('0')) {
                numeroLimpo = numeroLimpo.substring(1);
            }
            numeroLimpo = '55' + numeroLimpo;
        }

        // Valida formato final (deve ter entre 10 e 15 dígitos)
        if (numeroLimpo.length < 10 || numeroLimpo.length > 15) {
            throw new Error(`Número de telefone inválido: ${numeroLimpo.length} dígitos (deve ter entre 10 e 15)`);
        }

        // Retorna no formato E.164
        return '+' + numeroLimpo;
    }

    /**
     * Envia mensagem de texto simples
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} mensagem - Texto da mensagem
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarTexto(numeroDestino, mensagem, idConfig, idTelConectado) {
        this.validarConfiguracao();

        // Valida mensagem
        if (!mensagem || typeof mensagem !== 'string' || mensagem.trim() === '') {
            throw new Error('Mensagem inválida: deve ser uma string não vazia');
        }

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'text',
            text: {
                preview_url: false,
                body: mensagem.trim()
            }
        };

        return await this.fazerRequisicao(payload, idConfig, idTelConectado);
    }

    /**
     * Envia mensagem de texto com preview de URL
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} mensagem - Texto da mensagem
     * @param {boolean} previewUrl - Se deve mostrar preview de URLs (padrão: true)
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarTextoComPreview(numeroDestino, mensagem, previewUrl = true) {
        this.validarConfiguracao();

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'text',
            text: {
                preview_url: previewUrl,
                body: mensagem
            }
        };

        return await this.fazerRequisicao(payload);
    }

    /**
     * Envia imagem
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} urlImagem - URL da imagem
     * @param {string} legenda - Legenda da imagem (opcional)
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarImagem(numeroDestino, urlImagem, legenda = '') {
        this.validarConfiguracao();

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'image',
            image: {
                link: urlImagem,
                caption: legenda
            }
        };

        return await this.fazerRequisicao(payload);
    }

    /**
     * Envia documento
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} urlDocumento - URL do documento
     * @param {string} nomeArquivo - Nome do arquivo
     * @param {string} legenda - Legenda do documento (opcional)
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarDocumento(numeroDestino, urlDocumento, nomeArquivo, legenda = '') {
        this.validarConfiguracao();

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'document',
            document: {
                link: urlDocumento,
                filename: nomeArquivo,
                caption: legenda
            }
        };

        return await this.fazerRequisicao(payload);
    }

    /**
     * Envia áudio
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} urlAudio - URL do áudio
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarAudio(numeroDestino, urlAudio) {
        // Valida URL do áudio
        if (!urlAudio || typeof urlAudio !== 'string' || urlAudio.trim() === '') {
            throw new Error('URL do áudio inválida: deve ser uma string não vazia');
        }

        this.validarConfiguracao();

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const urlLimpa = urlAudio.trim();
        const isOGG = urlLimpa.toLowerCase().endsWith('.ogg');

        const audioPayload = {
            link: urlLimpa
        };

        if (isOGG) {
            audioPayload.voice = true;
        }

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'audio',
            audio: audioPayload
        };

        return await this.fazerRequisicao(payload);
    }

    /**
     * Envia vídeo
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} urlVideo - URL do vídeo
     * @param {string} legenda - Legenda do vídeo (opcional)
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarVideo(numeroDestino, urlVideo, legenda = '') {
        this.validarConfiguracao();

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'video',
            video: {
                link: urlVideo,
                caption: legenda
            }
        };

        return await this.fazerRequisicao(payload);
    }

    /**
     * Envia localização
     * @param {string} numeroDestino - Número do destinatário
     * @param {number} latitude - Latitude
     * @param {number} longitude - Longitude
     * @param {string} nome - Nome do local (opcional)
     * @param {string} endereco - Endereço do local (opcional)
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarLocalizacao(numeroDestino, latitude, longitude, nome = '', endereco = '') {
        this.validarConfiguracao();

        const numeroFormatado = this.formatarNumero(numeroDestino);

        const payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: numeroFormatado,
            type: 'location',
            location: {
                latitude: latitude,
                longitude: longitude,
                name: nome,
                address: endereco
            }
        };

        return await this.fazerRequisicao(payload);
    }

    /**
     * Envia mensagem usando template do WhatsApp
     * @param {string} numeroDestino - Número do destinatário
     * @param {string} templateName - Nome do template aprovado
     * @param {string} language - Código do idioma (ex: 'pt_BR', 'en_US')
     * @param {Array} templateParams - Array de parâmetros do template (opcional)
     * @param {string} parameterFormat - Formato dos parâmetros: 'POSITIONAL' ou 'NAMED' (padrão: 'POSITIONAL')
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async enviarTemplate(numeroDestino, templateName, language = 'pt_BR', templateParams = [], parameterFormat = 'POSITIONAL') {
        this.validarConfiguracao();

        // Valida templateName
        if (!templateName || typeof templateName !== 'string' || templateName.trim() === '') {
            throw new Error('Nome do template inválido: deve ser uma string não vazia');
        }

        // Valida language
        if (!language || typeof language !== 'string' || language.trim() === '') {
            throw new Error('Código do idioma inválido: deve ser uma string não vazia');
        }

        const numeroFormatado = this.formatarNumero(numeroDestino);

        // Monta o objeto template
        const template = {
            name: templateName.trim(),
            language: {
                code: language.trim()
            }
        };

        // Processa parâmetros baseado no formato
        if (templateParams && Array.isArray(templateParams) && templateParams.length > 0) {
            displayLog(`[EnviarMensagemMeta] Processando ${templateParams.length} parâmetro(s) para o template "${templateName}" (formato: ${parameterFormat})`);
            const components = [];
            const bodyParams = [];

            // Para templates NAMED, os parâmetros já devem vir no formato correto com parameter_name
            if (parameterFormat === 'NAMED') {
                templateParams.forEach((param) => {
                    if (typeof param === 'object' && param !== null) {
                        // Para templates NAMED, espera formato: { type: 'text', parameter_name: 'nome', text: 'valor' }
                        if (param.parameter_name && param.text !== undefined) {
                            bodyParams.push({
                                type: param.type || 'text',
                                parameter_name: param.parameter_name,
                                text: String(param.text)
                            });
                        } else if (param.text) {
                            // Fallback: se não tiver parameter_name, tenta usar key ou placeholder
                            const paramName = param.parameter_name || param.key || param.placeholder?.replace(/\{\{|\}\}/g, '');
                            if (paramName) {
                                bodyParams.push({
                                    type: param.type || 'text',
                                    parameter_name: paramName,
                                    text: String(param.text)
                                });
                            }
                        }
                    }
                });
            } else {
                // Para templates POSITIONAL, processa como antes
                templateParams.forEach((param) => {
                    if (typeof param === 'string') {
                        bodyParams.push({
                            type: 'text',
                            text: param
                        });
                    } else if (typeof param === 'number') {
                        bodyParams.push({
                            type: 'text',
                            text: String(param)
                        });
                    } else if (typeof param === 'object' && param !== null) {
                        if (param.type === 'text' || !param.type) {
                            bodyParams.push({
                                type: 'text',
                                text: param.text || String(param.value || '')
                            });
                        } else {
                            // Para outros tipos (image, video, document, location)
                            bodyParams.push(param);
                        }
                    }
                });
            }

            // Adiciona componente BODY com os parâmetros
            if (bodyParams.length > 0) {
                components.push({
                    type: 'body',
                    parameters: bodyParams
                });
            }

            if (components.length > 0) {
                template.components = components;
            }
        } else {
            displayWarn(`[EnviarMensagemMeta] ATENÇÃO: Template "${templateName}" foi enviado sem parâmetros!`);
            displayWarn(`[EnviarMensagemMeta] templateParams recebido:`, templateParams);
            displayWarn(`[EnviarMensagemMeta] parameterFormat:`, parameterFormat);
        }

        const payload = {
            messaging_product: 'whatsapp',
            to: numeroFormatado,
            type: 'template',
            template: template
        };

        displayLog('PAYLOAD ANTES DE ENVIAR PRA META:', JSON.stringify(payload, null, 2));
        

        return await this.fazerRequisicao(payload);
    }

    /**
     * Marca mensagem como lida
     * @param {string} messageId - ID da mensagem do WhatsApp
     * @returns {Promise<Object>} Resposta da API do Meta
     */
    async marcarMsgLidas(messageId) {
        this.validarConfiguracao();

        
        // Valida messageId
        if (!messageId || typeof messageId !== 'string' || messageId.trim() === '') {
            throw new Error('MessageId inválido: deve ser uma string não vazia');
        }

        const payload = {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId.trim()
        };

        try {
            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            const data = await response.json();

            if (!response.ok || !data.success) {
                const errorMessage = data.error?.message || `Erro ${response.status}: ${response.statusText}`;
                const errorCode = data.error?.code || response.status;
                const errorType = data.error?.type || 'UNKNOWN';
                const errorSubcode = data.error?.error_subcode || null;

                // Valida se é o erro 131047 (Re-engagement message - fora da janela de 24h)
                if (errorCode === 131047) {
                    const error = new Error(`Erro ao marcar mensagem como lida: ${errorMessage} (Código: ${errorCode}, Tipo: ${errorType}${errorSubcode ? ', Subcode: ' + errorSubcode : ''})`);
                    error.code = 131047;
                    throw error;
                }

                throw new Error(`Erro ao marcar mensagem como lida: ${errorMessage} (Código: ${errorCode}, Tipo: ${errorType}${errorSubcode ? ', Subcode: ' + errorSubcode : ''})`);
            }

            return {
                success: true,
                messageId: messageId,
                data: data
            };
        } catch (error) {
            throw error;
        }
    }

    /**
     * Busca credenciais na tabela agente_whatsapp_credenciais
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {string|number} idConfig - ID da configuração
     * @param {string|number} idTelConectado - ID do telefone conectado
     * @returns {Promise<Object|null>} Credenciais encontradas (todas as colunas) ou null
     */
    async buscarCredenciaisPorIdConfigEIdTelConectado(db, idConfig, idTelConectado) {
        try {
            if (!db || !idConfig || !idTelConectado) {
                return null;
            }


            const { Entidade } = await import('../../db/Entidade.js');
            const entidade = new Entidade(db);
            entidade.setConnection('md');

            const campos = {
                id: '',
                idConfig: '',
                tokenMeta: '',
                validacaoNumeroMeta: '',
                idWhatBusinessMeta: '',
                status: ''
            };

            const condicao = 'id = :id  AND status = :status';
            const dadosCondicao = {
                id: idTelConectado,
                status: 'A'
            };

            const credenciais = await entidade.selectRetornaArrayUnico(
                campos,
                'agente_pedir_numero_sincronizado',
                condicao,
                dadosCondicao
            );

            return credenciais || null;
        } catch (error) {
            displayError('[EnviarMensagemMeta] Erro ao buscar credenciais:', error.message);
            return null;
        }
    }

    /**
     * Faz a requisição HTTP para a API do Meta
     * @param {Object} payload - Payload da mensagem
     * @param {string|number} idConfig - ID da configuração (opcional)
     * @param {string|number} idTelConectado - ID do telefone conectado (opcional)
     * @param {Object} db - Objeto de conexão do banco de dados (opcional, necessário se idConfig e idTelConectado forem fornecidos)
     * @returns {Promise<Object>} Resposta da API
     * @throws {Error} Se a requisição falhar
     */
    async fazerRequisicao(payload, idConfig, idTelConectado, db = null) {
        try {

            displayLog('FAZER REQUISIÇÃO CHEGOU ******************                      ');

            if (!idConfig || !idTelConectado) {
                // Se não tiver idConfig ou idTelConectado, não faz nada
            } else if (db) {
                // Busca credenciais na tabela agente_whatsapp_credenciais
                const credenciais = await this.buscarCredenciaisPorIdConfigEIdTelConectado(db, idConfig, idTelConectado);
                
                if (credenciais) {
                    // Atualiza as credenciais da instância
                    this.accessToken = credenciais.token || this.accessToken;
                    this.phoneNumberId = credenciais.validacaoNumero || this.phoneNumberId;
                    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}/messages`;
                }
            }

            const response = await fetch(this.baseUrl, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
            });

            let data;
            try {
                data = await response.json();
            } catch (parseError) {
                // Se falhar ao fazer parse, tenta ler como texto para debug
                const textData = await response.text().catch(() => 'Não foi possível ler a resposta');
                displayError('[EnviarMensagemMeta] Erro ao fazer parse da resposta JSON:', parseError.message);
                displayError('[EnviarMensagemMeta] Resposta recebida (texto):', textData.substring(0, 500));
                throw new Error(`Erro ao processar resposta da API do Meta: ${parseError.message}`);
            }

            if (!response.ok) {
                const errorMessage = data?.error?.message || `Erro ${response.status}: ${response.statusText}`;
                const errorCode = data?.error?.code || response.status;
                const errorType = data?.error?.type || 'UNKNOWN';
                const errorSubcode = data?.error?.error_subcode || null;

                // Envia notificação para Discord
                const tipoMensagem = payload.type || 'desconhecido';
                const numeroDestino = payload.to || 'não informado';
                
                const errorObj = new Error(errorMessage);
                errorObj.code = errorCode;
                
                DiscordNotifier.enviarErroMeta('Chat WhatsApp - fazerRequisicao', errorObj, {
                    tipoMensagem: tipoMensagem,
                    numeroDestino: numeroDestino,
                    idConfig: idConfig,
                    idTelConectado: idTelConectado,
                    errorType: errorType,
                    errorSubcode: errorSubcode,
                    payload: JSON.stringify(payload).substring(0, 500)
                }).catch(err => displayError('[EnviarMensagemMeta] Erro ao enviar notificação Discord:', err));

                // Valida se é o erro 131047 (Re-engagement message - fora da janela de 24h)
                if (errorCode === 131047) {
                    const error = new Error(`Erro ao enviar mensagem: ${errorMessage} (Código: ${errorCode}, Tipo: ${errorType}${errorSubcode ? ', Subcode: ' + errorSubcode : ''})`);
                    error.code = 131047;
                    throw error;
                }

                throw new Error(`Erro ao enviar mensagem: ${errorMessage} (Código: ${errorCode}, Tipo: ${errorType}${errorSubcode ? ', Subcode: ' + errorSubcode : ''})`);
            }

            const messageId = data.messages?.[0]?.id;

            return {
                success: true,
                messageId: messageId,
                data: data
            };
        } catch (error) {
            // Envia notificação para Discord em caso de erro de rede ou outro erro não tratado
            if (error.code !== 131047 && !error.message?.includes('Erro ao processar resposta')) { 
                // Não notifica erro 131047 novamente (já foi notificado acima)
                // Não notifica erro de parse novamente (já foi notificado acima)
                DiscordNotifier.enviarErroMeta('Chat WhatsApp - fazerRequisicao (catch)', error, {
                    idConfig: idConfig,
                    idTelConectado: idTelConectado
                }).catch(err => displayError('[EnviarMensagemMeta] Erro ao enviar notificação Discord:', err));
            }
            throw error;
        }
    }
}
