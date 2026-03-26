import { error as displayError } from './displayLogWebhook.js';

/**
 * Classe DiscordNotifier
 * Envia notificações para o Discord através do webhook
 */
export class DiscordNotifier {
    /**
     * URL do webhook do Discord
     */
    static DISCORD_WEBHOOK_URL = 'https://discord.com/api/webhooks/1464364312557781238/xdvzLw9SY2Dj7vOXjEyYsFJtiiwNnNMgk2gB0QfQ7VHHaCaATdqptvwiAMBpMXg_H_bV';

    /**
     * Envia uma notificação para o Discord
     * @param {string} titulo - Título da notificação (será prefixado com "> ")
     * @param {string} msg - Mensagem completa formatada
     * @returns {Promise<Object>} Resposta da API
     */
    static async enviarNotificacao(titulo, msg) {
        try {
            // Garante que o título tenha o prefixo "> "
            const tituloFormatado = titulo.startsWith('> ') ? titulo : `> ${titulo}`;

            // Monta a mensagem completa com título e conteúdo
            const mensagemCompleta = `${tituloFormatado}\n\n${msg || ''}`;

            // Formata o body para o webhook do Discord
            const body = {
                content: mensagemCompleta
            };

            const response = await fetch(this.DISCORD_WEBHOOK_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                displayError(`[DiscordNotifier] Erro ao enviar notificação: ${response.status} ${response.statusText} - ${errorText}`);
                return {
                    success: false,
                    error: `Erro HTTP ${response.status}: ${errorText}`
                };
            }

            // Webhook do Discord retorna 204 No Content em caso de sucesso
            // ou 200 com JSON em alguns casos
            const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
            
            return {
                success: true,
                data: data
            };
        } catch (error) {
            // Não lança erro para não quebrar o fluxo principal
            displayError('[DiscordNotifier] Erro ao enviar notificação para Discord:', error.message);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Envia notificação de erro formatada
     * @param {string} contexto - Contexto onde ocorreu o erro (ex: "Envio de mensagem Meta")
     * @param {Error|string} error - Objeto de erro ou mensagem de erro
     * @param {Object} dadosAdicionais - Dados adicionais para incluir na mensagem (opcional)
     * @param {string} origemDados - Origem dos dados adicionais (ex: "Retorno CDN", "Erro Meta", etc) (opcional)
     * @returns {Promise<Object>} Resposta da API
     */
    static async enviarErro(contexto, error, dadosAdicionais = {}, origemDados = null) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorStack = error instanceof Error ? error.stack : '';
        const errorCode = error?.code || dadosAdicionais.code || null;

        let msg = `🚨 **ERRO NO CHAT DE MENSAGENS DO WHATSAPP** 🚨\n\n`;
        msg += `**Contexto:** ${contexto}\n`;
        msg += `**Erro:** ${errorMessage}\n`;
        
        if (errorCode) {
            msg += `**Código:** ${errorCode}\n`;
        }

        if (errorStack) {
            msg += `\n**Stack Trace:**\n\`\`\`\n${errorStack.substring(0, 1000)}\n\`\`\``;
        }

        if (Object.keys(dadosAdicionais).length > 0) {
            const tituloDados = origemDados ? `Dados Adicionais - ${origemDados}` : 'Dados Adicionais';
            msg += `\n\n**${tituloDados}:**\n\`\`\`json\n${JSON.stringify(dadosAdicionais, null, 2).substring(0, 500)}\n\`\`\``;
        }

        return await this.enviarNotificacao(`WhatsApp Chat - Erro: ${contexto}`, msg);
    }

    /**
     * Envia notificação de erro do Meta
     * @param {string} operacao - Operação que falhou (ex: "enviarTexto", "enviarImagem")
     * @param {Error} error - Objeto de erro
     * @param {Object} dados - Dados da requisição (opcional)
     * @returns {Promise<Object>} Resposta da API
     */
    static async enviarErroMeta(operacao, error, dados = {}) {
        const errorMessage = error.message || String(error);
        const errorCode = error.code || null;

        let msg = `🚨 **ERRO NO CHAT DE MENSAGENS DO WHATSAPP** 🚨\n\n`;
        msg += `**Operação:** ${operacao}\n`;
        msg += `**Erro:** ${errorMessage}\n`;
        
        if (errorCode) {
            msg += `**Código do Erro:** ${errorCode}\n`;
        }

        if (dados.numeroDestino) {
            msg += `**Destinatário:** ${dados.numeroDestino}\n`;
        }

        if (dados.tipoMensagem) {
            msg += `**Tipo de Mensagem:** ${dados.tipoMensagem}\n`;
        }

        if (dados.idConfig) {
            msg += `**ID Config:** ${dados.idConfig}\n`;
        }

        if (dados.idTelConectado) {
            msg += `**ID Tel Conectado:** ${dados.idTelConectado}\n`;
        }

        if (dados.errorType) {
            msg += `**Tipo de Erro Meta:** ${dados.errorType}\n`;
        }

        if (dados.errorSubcode) {
            msg += `**Subcódigo:** ${dados.errorSubcode}\n`;
        }

        // Adiciona dados adicionais se houver payload ou outros campos
        const dadosExtras = {};
        if (dados.payload) {
            dadosExtras.payload = dados.payload;
        }
        // Remove campos já exibidos acima para não duplicar
        const camposExibidos = ['numeroDestino', 'tipoMensagem', 'idConfig', 'idTelConectado', 'errorType', 'errorSubcode', 'payload'];
        const dadosRestantes = Object.keys(dados)
            .filter(key => !camposExibidos.includes(key))
            .reduce((obj, key) => {
                obj[key] = dados[key];
                return obj;
            }, {});

        if (Object.keys(dadosExtras).length > 0 || Object.keys(dadosRestantes).length > 0) {
            const todosDadosExtras = { ...dadosExtras, ...dadosRestantes };
            msg += `\n\n**Dados Adicionais - Retorno Meta/Node:**\n\`\`\`json\n${JSON.stringify(todosDadosExtras, null, 2).substring(0, 500)}\n\`\`\``;
        }

        return await this.enviarNotificacao(`WhatsApp Chat - Erro ao enviar mensagem para Meta`, msg);
    }
}
