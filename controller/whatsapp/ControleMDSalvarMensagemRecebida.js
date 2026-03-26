import { ControleMD_agente_conversas_mensagens } from "./ControleMD_agente_conversas_mensagens.js";
import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import SocketController from "../../socket/SocketController.js";
import { processarEValidarMidia } from "../../utils/mediaProcessor.js";
import { canFallbackToPhp, isDirectUploadEnabled, uploadBase64ViaPhp, uploadBufferDiretoCDN, uploadFileDiretoCDN } from "../../utils/cdnUploader.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Classe ControleMDSalvarMensagemRecebida
 * Gerencia o salvamento de mensagens recebidas do webhook do WhatsApp
 * Usa conexão MD (MD_CLMAPP)
 */
export class ControleMDSalvarMensagemRecebida {
    /**
     * Construtor da classe ControleMDSalvarMensagemRecebida
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.controleMensagem = new ControleMD_agente_conversas_mensagens(db);
        this.CDN_PHP_URL = process.env.NODE_ENV === 'development'
            ? (process.env.CDN_PHP_URL || '')
            : (process.env.CDN_PHP_URL_PRODUCTION || '');
    }

    async baixarRespostaParaArquivoTemporario(response, nomeArquivoBase, extensao) {
        const safeExt = (extensao || "bin").replace(/[^a-zA-Z0-9]/g, "").toLowerCase() || "bin";
        const tempFileName = `${nomeArquivoBase}_${Date.now()}_${Math.random().toString(16).slice(2)}.${safeExt}`;
        const tempFilePath = path.join(os.tmpdir(), tempFileName);

        if (!response.body) {
            throw new Error("Resposta da mídia sem body para streaming");
        }

        const nodeReadable = Readable.fromWeb(response.body);
        await pipeline(nodeReadable, fsSync.createWriteStream(tempFilePath));
        return tempFilePath;
    }

    formatarBytes(bytes) {
        const valor = Number(bytes || 0);
        if (!valor || valor < 1024) return `${valor}B`;
        const kb = valor / 1024;
        if (kb < 1024) return `${kb.toFixed(2)}KB`;
        const mb = kb / 1024;
        if (mb < 1024) return `${mb.toFixed(2)}MB`;
        const gb = mb / 1024;
        return `${gb.toFixed(2)}GB`;
    }

    extrairTamanhoDeHeaders(headers) {
        const contentLength = headers?.get?.("content-length");
        if (contentLength && /^\d+$/.test(contentLength)) {
            return Number(contentLength);
        }

        const contentRange = headers?.get?.("content-range");
        // Exemplo: bytes 0-0/123456
        if (contentRange && /\/(\d+)$/.test(contentRange)) {
            const match = contentRange.match(/\/(\d+)$/);
            if (match && match[1]) return Number(match[1]);
        }
        return null;
    }

    async obterTamanhoMidiaAntesDownload(mediaUrl, accessToken) {
        try {
            const headResponse = await fetch(mediaUrl, {
                method: "HEAD",
                headers: {
                    "Authorization": `Bearer ${accessToken}`
                },
                redirect: "follow"
            });
            const sizeByHead = this.extrairTamanhoDeHeaders(headResponse.headers);
            if (sizeByHead && sizeByHead > 0) {
                return sizeByHead;
            }
        } catch (_) {}

        try {
            const rangeResponse = await fetch(mediaUrl, {
                method: "GET",
                headers: {
                    "Authorization": `Bearer ${accessToken}`,
                    "Range": "bytes=0-0"
                },
                redirect: "follow"
            });
            const sizeByRange = this.extrairTamanhoDeHeaders(rangeResponse.headers);
            if (sizeByRange && sizeByRange > 0) {
                return sizeByRange;
            }
        } catch (_) {}

        return null;
    }

    /**
     * Converte timestamp Unix para dataHora formatada no fuso horário de São Paulo
     * @param {number|string} timestampUnix - Timestamp em segundos Unix
     * @returns {Object} Objeto com dataHora formatada e timeData em segundos (Unix)
     */
    converterTimestampParaDataHora(timestampUnix) {
        const timestamp = parseInt(timestampUnix) || Math.floor(Date.now() / 1000);
        const dataHoraUTC = new Date(timestamp * 1000);

        // Converte para fuso horário de São Paulo
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/Sao_Paulo',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });

        const parts = formatter.formatToParts(dataHoraUTC);
        const dateParts = {};
        parts.forEach(part => {
            dateParts[part.type] = part.value;
        });

        // Formata dataHora no formato MySQL: YYYY-MM-DD HH:mm:ss
        const dataHoraFormatada = `${dateParts.year}-${dateParts.month}-${dateParts.day} ${dateParts.hour}:${dateParts.minute}:${dateParts.second}`;

        // timeData em segundos Unix (como strtotime do PHP) - cabe em coluna INT
        const timeData = timestamp;

        return {
            dataHora: dataHoraFormatada,
            timeData: timeData,
            timestamp: timestamp
        };
    }

    /**
     * Baixa mídia (imagem ou vídeo) da Graph API do Meta e envia para CDN
     * @param {Object} dados - Dados da mensagem recebida
     * @param {Object} dadosUsuario - Dados do usuário/agente
     * @param {number} timestampUnix - Timestamp Unix para nome do arquivo
     * @returns {Promise<string|null>} Link da mídia no CDN ou null se falhar
     */
    async processarMidiaECDN(dados, dadosUsuario, timestampUnix, webhookBody = {}, notificacaoMidia = {}) {
        let tempFilePath = null;
        try {
            const limiteProcessamentoVideo = 16 * 1024 * 1024;
            const limiteProcessamentoImagem = 16 * 1024 * 1024;
            const limiteCortePreDownload = 21 * 1024 * 1024;
            const tipoComLimiteDireto = tipo => (tipo === "video" || tipo === "image");
            let ultimoPercentualNotificado = -1;
            // Determinar tipo de mídia e ID
            let mediaId = null;
            let mimeType = null;
            let tipoMidia = null;
            let nomeArquivoBase = null;

            if (dados.tipoMensagem === 'image' && dados.mensagem.image?.id) {
                mediaId = dados.mensagem.image.id;
                mimeType = dados.mensagem.image.mime_type;
                tipoMidia = 'image';
                nomeArquivoBase = 'imagem';
            } else if (dados.tipoMensagem === 'video' && dados.mensagem.video?.id) {
                mediaId = dados.mensagem.video.id;
                mimeType = dados.mensagem.video.mime_type;
                tipoMidia = 'video';
                nomeArquivoBase = 'video';
            } else if (dados.tipoMensagem === 'sticker' && dados.mensagem.sticker?.id) {
                mediaId = dados.mensagem.sticker.id;
                mimeType = dados.mensagem.sticker.mime_type;
                tipoMidia = 'image';
                nomeArquivoBase = 'sticker';
            } else if (dados.tipoMensagem === 'audio' && dados.mensagem.audio?.id) {
                mediaId = dados.mensagem.audio.id;
                mimeType = dados.mensagem.audio.mime_type;
                tipoMidia = 'audio';
                nomeArquivoBase = 'audio';
            } else if (dados.tipoMensagem === 'document' && dados.mensagem.document?.id) {
                mediaId = dados.mensagem.document.id;
                mimeType = dados.mensagem.document.mime_type;
                tipoMidia = 'documento';
                nomeArquivoBase = 'documento';
                // Usar o nome do arquivo do documento se disponível
                if (dados.mensagem.document.filename) {
                    nomeArquivoBase = dados.mensagem.document.filename.replace(/\.[^/.]+$/, ''); // Remove extensão
                }
            } else {
                return null;
            }

            displayLog(`[ControleMDSalvarMensagemRecebida] Processando ${tipoMidia}, baixando da Graph API do Meta...`);

            // Buscar credenciais do WhatsApp (obrigatório para baixar da Graph API)
            let credenciaisMeta = null;

            if (dadosUsuario.dadosNumeroSincronizado?.tipoAgente && dadosUsuario.dadosNumeroSincronizado?.idConfig) {
                // Usar a instância já criada no construtor
                credenciaisMeta = await this.controleMensagem.buscarCredenciaisMeta(
                    dadosUsuario.dadosNumeroSincronizado.tipoAgente,
                    dadosUsuario.dadosNumeroSincronizado.idConfig
                );
            }

            if (!credenciaisMeta || !credenciaisMeta.accessToken) {
                throw new Error(`Credenciais do Meta não encontradas. É necessário accessToken para baixar o ${tipoMidia}.`);
            }

            // Baixar a mídia usando a Graph API do Meta
            // Endpoint: GET https://graph.facebook.com/v{version}/{media-id}
            const apiVersion = credenciaisMeta.apiVersion || 'v24.0';
            const graphApiUrl = `https://graph.facebook.com/${apiVersion}/${mediaId}`;

            displayLog(`[ControleMDSalvarMensagemRecebida] Baixando ${tipoMidia} da Graph API: ${graphApiUrl}`);

            // Primeira requisição: pode retornar JSON com URL ou redirecionamento
            const imageResponse = await fetch(graphApiUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${credenciaisMeta.accessToken}`
                },
                redirect: 'follow' // Seguir redirecionamentos automaticamente
            });

            if (!imageResponse.ok) {
                const errorText = await imageResponse.text();
                throw new Error(`Erro ao baixar ${tipoMidia} da Graph API: ${imageResponse.status} ${imageResponse.statusText} - ${errorText}`);
            }

            // Verificar se a resposta é JSON (contém URL) ou mídia direta
            const contentType = imageResponse.headers.get('content-type') || '';
            let mediaUrl = null;
            let mediaBuffer = null;
            let finalResponse = imageResponse;

            if (contentType.includes('application/json')) {
                // Se for JSON, extrair a URL da mídia
                const jsonData = await imageResponse.json();
                mediaUrl = jsonData.url || jsonData.data?.url || null;

                if (!mediaUrl) {
                    throw new Error(`URL do ${tipoMidia} não encontrada na resposta da Graph API`);
                }

                displayLog(`[ControleMDSalvarMensagemRecebida] URL do ${tipoMidia} obtida: ${mediaUrl}`);

                if (isDirectUploadEnabled() && tipoComLimiteDireto(tipoMidia)) {
                    const tamanhoAntesDownload = await this.obterTamanhoMidiaAntesDownload(mediaUrl, credenciaisMeta.accessToken);
                    if (tamanhoAntesDownload && tamanhoAntesDownload > 0) {
                        displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} detectado antes do download: ${this.formatarBytes(tamanhoAntesDownload)} (corte: ${this.formatarBytes(limiteCortePreDownload)}, alvo sem compressão: ${this.formatarBytes(tipoMidia === "video" ? limiteProcessamentoVideo : limiteProcessamentoImagem)})`);
                    } else {
                        displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} sem content-length confiável antes do download; seguindo para download e validação por arquivo`);
                    }
                    if (tamanhoAntesDownload && tamanhoAntesDownload >= limiteCortePreDownload) {
                        const tamanhoFormatado = this.formatarBytes(tamanhoAntesDownload);
                        const limiteFormatado = this.formatarBytes(limiteCortePreDownload);
                        const labelTipo = tipoMidia === "video" ? "Vídeo" : "Imagem";
                        throw new Error(`Arquivo muito grande. ${labelTipo} recebida com ${tamanhoFormatado}; limite de corte é ${limiteFormatado}.`);
                    }
                }

                // Baixar a mídia real da URL retornada
                // A URL da Graph API ainda requer autenticação
                finalResponse = await fetch(mediaUrl, {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${credenciaisMeta.accessToken}`
                    },
                    redirect: 'follow'
                });

                if (!finalResponse.ok) {
                    throw new Error(`Erro ao baixar ${tipoMidia} da URL: ${finalResponse.status} ${finalResponse.statusText}`);
                }

                tempFilePath = await this.baixarRespostaParaArquivoTemporario(finalResponse, nomeArquivoBase, mimeType?.split("/")[1] || "bin");
            } else {
                if (isDirectUploadEnabled() && tipoComLimiteDireto(tipoMidia)) {
                    const tamanhoDiretoHeader = this.extrairTamanhoDeHeaders(imageResponse.headers);
                    if (tamanhoDiretoHeader && tamanhoDiretoHeader > 0) {
                        displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} detectado no header direto: ${this.formatarBytes(tamanhoDiretoHeader)} (corte: ${this.formatarBytes(limiteCortePreDownload)}, alvo sem compressão: ${this.formatarBytes(tipoMidia === "video" ? limiteProcessamentoVideo : limiteProcessamentoImagem)})`);
                    } else {
                        displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} direto sem content-length; tamanho será validado após download`);
                    }
                    if (tamanhoDiretoHeader && tamanhoDiretoHeader >= limiteCortePreDownload) {
                        const tamanhoFormatado = this.formatarBytes(tamanhoDiretoHeader);
                        const limiteFormatado = this.formatarBytes(limiteCortePreDownload);
                        const labelTipo = tipoMidia === "video" ? "Vídeo" : "Imagem";
                        throw new Error(`Arquivo muito grande. ${labelTipo} recebida com ${tamanhoFormatado}; limite de corte é ${limiteFormatado}.`);
                    }
                }
                // Se for mídia direta, usar a resposta atual
                tempFilePath = await this.baixarRespostaParaArquivoTemporario(imageResponse, nomeArquivoBase, mimeType?.split("/")[1] || "bin");
            }

            // Validar se o arquivo temporário tem conteúdo
            const statsArquivo = await fs.stat(tempFilePath);
            if (!statsArquivo || statsArquivo.size === 0) {
                throw new Error(`${tipoMidia} baixado está vazio ou corrompido`);
            }
            displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} baixado em arquivo temporário: ${this.formatarBytes(statsArquivo.size)} (corte: ${this.formatarBytes(limiteCortePreDownload)}, alvo sem compressão: ${this.formatarBytes(tipoMidia === "video" ? limiteProcessamentoVideo : limiteProcessamentoImagem)})`);
            if (isDirectUploadEnabled() && tipoComLimiteDireto(tipoMidia) && statsArquivo.size >= limiteCortePreDownload) {
                const tamanhoFormatado = this.formatarBytes(statsArquivo.size);
                const limiteFormatado = this.formatarBytes(limiteCortePreDownload);
                const labelTipo = tipoMidia === "video" ? "Vídeo" : "Imagem";
                throw new Error(`Arquivo muito grande. ${labelTipo} recebida com ${tamanhoFormatado}; limite de corte é ${limiteFormatado}.`);
            }

            // Caminho streaming/chunk: vídeo já dentro do limite direto pode subir sem carregar tudo em memória
            if (
                isDirectUploadEnabled() &&
                tipoComLimiteDireto(tipoMidia) &&
                statsArquivo.size <= (tipoMidia === "video" ? limiteProcessamentoVideo : limiteProcessamentoImagem)
            ) {
                displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} dentro do alvo (${this.formatarBytes(statsArquivo.size)} <= ${this.formatarBytes(tipoMidia === "video" ? limiteProcessamentoVideo : limiteProcessamentoImagem)}), enviando via stream direto sem compressão`);
                const ext = mimeType?.split("/")[1]?.split(";")[0] || "mp4";
                const nomeArquivoDireto = `${nomeArquivoBase}_${timestampUnix}.${ext}`;
                const linkStream = await uploadFileDiretoCDN({
                    filePath: tempFilePath,
                    mimeType: mimeType?.split(";")[0]?.trim() || (tipoMidia === "video" ? "video/mp4" : "image/jpeg"),
                    fileName: nomeArquivoDireto
                });
                await fs.unlink(tempFilePath).catch(() => {});
                tempFilePath = null;
                displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} enviado via stream direto para CDN`);
                return linkStream;
            }

            // Fluxo de processamento completo (compressão/validação) quando necessário
            displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} acima do alvo de upload direto (${this.formatarBytes(statsArquivo.size)} > ${this.formatarBytes(tipoMidia === "video" ? limiteProcessamentoVideo : limiteProcessamentoImagem)}), iniciando processamento/compressão`);
            const mediaBufferNode = await fs.readFile(tempFilePath);
            await fs.unlink(tempFilePath).catch(() => {});
            tempFilePath = null;

            // Determinar nome do arquivo
            let nomeArquivoTemp = nomeArquivoBase;
            if (tipoMidia === 'documento' && dados.mensagem.document?.filename) {
                nomeArquivoTemp = dados.mensagem.document.filename;
            }
            
            // Processar e validar mídia usando função compartilhada
            const resultadoProcessamento = await processarEValidarMidia(
                mediaBufferNode,
                tipoMidia,
                mimeType,
                nomeArquivoTemp,
                false,
                {
                    directUpload: isDirectUploadEnabled(),
                    onVideoProgress: ({ percent }) => {
                        if (!SocketController || !dadosUsuario?.idAgentePedir || tipoMidia !== 'video') return;
                        const percentual = Math.max(0, Math.min(100, Math.floor(Number(percent || 0))));
                        if (percentual === ultimoPercentualNotificado) return;
                        ultimoPercentualNotificado = percentual;
                        SocketController.notificarMidiaProgresso(
                            dadosUsuario.idAgentePedir,
                            percentual,
                            webhookBody,
                            {
                                uploadId: notificacaoMidia?.uploadId || null,
                                tipoMidia: notificacaoMidia?.tipoMidia || tipoMidia
                            }
                        );
                    }
                }
            );
            
            // Usar resultado do processamento
            const mediaBufferProcessado = resultadoProcessamento.buffer || mediaBufferNode;
            mimeType = resultadoProcessamento.tipoMime;

            // Garantir que o mimeType não seja JSON e remover parâmetros extras
            if (mimeType.includes('application/json')) {
                const mimeTypeFallback = {
                    'image': 'image/jpeg',
                    'video': 'video/mp4',
                    'audio': 'audio/ogg',
                    'documento': 'application/pdf'
                };
                mimeType = mimeTypeFallback[tipoMidia] || 'application/octet-stream'; // Fallback
            }
            // Remover parâmetros do content-type (ex: "image/jpeg; charset=utf-8" -> "image/jpeg")
            mimeType = mimeType.split(';')[0].trim();

            // Usar nome do arquivo do resultado do processamento ou gerar um
            let nomeArquivo = resultadoProcessamento.nomeArquivo;
            if (!nomeArquivo || nomeArquivo === nomeArquivoTemp) {
                // Se não mudou, gerar nome com timestamp
                const extensaoFallback = {
                    'image': 'jpg',
                    'video': 'mp4',
                    'audio': 'ogg',
                    'documento': 'pdf'
                };
                
                // Para documentos, tentar obter extensão do nome do arquivo original
                let extensao = null;
                if (tipoMidia === 'documento' && dados.mensagem.document?.filename) {
                    const match = dados.mensagem.document.filename.match(/\.([^.]+)$/);
                    if (match) {
                        extensao = match[1].toLowerCase();
                    }
                }
                
                // Se não conseguiu extensão do nome do arquivo, usar do MIME type ou fallback
                if (!extensao) {
                    extensao = mimeType.split('/')[1]?.split(';')[0] || extensaoFallback[tipoMidia] || 'bin';
                }
                
                nomeArquivo = `${nomeArquivoBase}_${timestampUnix}.${extensao}`;
            }

            // Calcular tamanho do buffer final para logs
            const bufferFinal = mediaBufferProcessado;
            displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} preparado (${bufferFinal.byteLength} bytes, tipo: ${mimeType}), enviando para CDN...`);

            // Fluxo preferencial: upload direto para GCS sem base64->PHP
            if (isDirectUploadEnabled()) {
                try {
                    const linkDireto = await uploadBufferDiretoCDN({
                        buffer: mediaBufferProcessado,
                        mimeType: mimeType,
                        fileName: nomeArquivo
                    });
                    displayLog(`[ControleMDSalvarMensagemRecebida] ${tipoMidia} enviado via CDN direto: ${linkDireto}`);
                    return linkDireto;
                } catch (errorDireto) {
                    if (!canFallbackToPhp()) {
                        throw new Error(`Falha no upload direto sem fallback: ${errorDireto.message}`);
                    }
                    displayWarn(`[ControleMDSalvarMensagemRecebida] Upload direto falhou, usando fallback PHP: ${errorDireto.message}`);
                }
            }

            // Fallback: fluxo legado via PHP com base64
            const mediaBase64Fallback = mediaBufferProcessado.toString('base64');
            const linkFallback = await uploadBase64ViaPhp({
                base64: mediaBase64Fallback,
                tipoMime: mimeType,
                nomeArquivo: nomeArquivo,
                tipoArquivo: tipoMidia,
                phpUrl: this.CDN_PHP_URL
            });
            if (!linkFallback) {
                throw new Error(`Erro ao enviar ${tipoMidia} para CDN (sem link retornado)`);
            }
            return linkFallback;
        } catch (error) {
            if (tempFilePath) {
                await fs.unlink(tempFilePath).catch(() => {});
            }
            displayError(`[ControleMDSalvarMensagemRecebida] Erro ao processar mídia:`, error.message);
            
            // Se for erro de tamanho (arquivo muito grande), lançar erro descritivo
            if (error.message && error.message.includes('muito grande')) {
                throw new Error(`Arquivo muito grande e não pôde ser processado. ${error.message}`);
            }
            
            // Para outros erros, lançar também para que seja tratado em salvarMensagemRecebida
            throw error;
        }
    }

    /**
     * Método de compatibilidade - mantido para não quebrar código existente
     * @deprecated Use processarMidiaECDN ao invés
     */
    async processarImagemECDN(dados, dadosUsuario, timestampUnix) {
        return this.processarMidiaECDN(dados, dadosUsuario, timestampUnix);
    }

    /**
     * Salva mensagem recebida do webhook no banco de dados
     * @param {Object} dados - Dados da mensagem recebida do webhook
     * @param {Object} dadosUsuario - Dados do usuário/agente retornados por busacarDadosUsuario
     * @returns {Promise<Object>} Resultado do salvamento { success: boolean, id: number, message: string }
     */
    async salvarMensagemRecebida(dados, dadosUsuario, webhookBody = {}) {
        try {
            // Validar se tem dados necessários
            if (!dadosUsuario.success || !dadosUsuario.idAgentePedir) {
                return {
                    success: false,
                    id: 0,
                    message: 'dadosUsuario.success = false ou idAgentePedir não encontrado'
                };
            }

            // Converter timestamp para dataHora
            const timestampUnix = parseInt(dados.mensagem.timestamp) || Math.floor(Date.now() / 1000);
            const { dataHora, timeData, timestamp } = this.converterTimestampParaDataHora(timestampUnix);

            // Prepara os dados para salvar
            // Prioriza texto transcrito/descrito (para áudio/imagem) sobre texto normal
            // Para tipo contacts: salvar JSON com type e contacts (não usar coluna tipo)
            const captionMidia = (
                dados.mensagem?.image?.caption ||
                dados.mensagem?.video?.caption ||
                dados.mensagem?.document?.caption ||
                ''
            ).trim();
            const ehMidiaComLegenda = dados.tipoMensagem === 'image' || dados.tipoMensagem === 'video' || dados.tipoMensagem === 'document';
            let textoMensagem = dados.textoTranscrito || dados.mensagem.text?.body || '';
            if (!ehMidiaComLegenda && !textoMensagem) {
                textoMensagem = captionMidia;
            }
            if (dados.tipoMensagem === 'contacts' && Array.isArray(dados.mensagem.contacts)) {
                textoMensagem = JSON.stringify({ type: 'contacts', contacts: dados.mensagem.contacts });
            } else if (dados.tipoMensagem === 'reaction' && dados.mensagem.reaction) {
                const r = dados.mensagem.reaction;
                textoMensagem = JSON.stringify({
                    type: 'reaction',
                    emoji: r.emoji || '',
                    message_id: r.message_id || ''
                });
            }

            // Para reação: atualizar existente em vez de inserir nova (evita duplicar ao trocar emoji)
            if (dados.tipoMensagem === 'reaction' && dados.mensagem.reaction?.message_id) {
                const messageIdRef = dados.mensagem.reaction.message_id;
                const reacaoExistente = await this.controleMensagem.buscarReactionPorMessageIdRef(
                    dadosUsuario.idAgentePedir,
                    messageIdRef
                );
                if (reacaoExistente && reacaoExistente.id) {
                    const atualizado = await this.controleMensagem.atualizarReaction(reacaoExistente.id, {
                        mensagem: textoMensagem,
                        dataHora: dataHora,
                        timeData: timeData
                    });
                    if (atualizado) {
                        if (SocketController && webhookBody) {
                            try {
                                const result = SocketController.processWebhook(webhookBody);
                                if (result.success) {
                                    displayLog(`[WhatsApp Webhook] ${result.message}`);
                                }
                            } catch (error) {
                                displayError('[ControleMDSalvarMensagemRecebida] Erro ao enviar via Socket.IO:', error.message);
                            }
                        }
                        return {
                            success: true,
                            id: reacaoExistente.id,
                            message: 'Reação atualizada com sucesso'
                        };
                    }
                }
            }

            const dadosConteudo = {
                idAgentePedir: dadosUsuario.idAgentePedir,
                origem: 'U', // 'U' = mensagem recebida do usuário (não deve ser enviada ao Meta)
                dataHora: dataHora,
                timeData: timeData,
                tipo: dados.tipoMensagem || 'text',
                type: dados.tipoMensagem || 'text',
                mensagem: textoMensagem,
                idMsgMeta: (dados.tipoMensagem === 'reaction' && dados.mensagem.reaction?.message_id)
                    ? dados.mensagem.reaction.message_id
                    : (dados.mensagem.id || null)
            };
            if (ehMidiaComLegenda && captionMidia) {
                dadosConteudo.descricao_imagem = captionMidia;
            }

            // Log para debug
            if (process.env.NODE_ENV === 'development') {
                displayLog(`[ControleMDSalvarMensagemRecebida] Preparando para salvar mensagem - origem: ${dadosConteudo.origem}, tipo: ${dadosConteudo.tipo}`);
            }

            // Se for imagem, vídeo, áudio ou documento, processar e enviar para CDN
            if ((dados.tipoMensagem === 'image' && dados.mensagem.image?.id) ||
                (dados.tipoMensagem === 'video' && dados.mensagem.video?.id) ||
                (dados.tipoMensagem === 'sticker' && dados.mensagem.sticker?.id) ||
                (dados.tipoMensagem === 'audio' && dados.mensagem.audio?.id) ||
                (dados.tipoMensagem === 'document' && dados.mensagem.document?.id)) {
                const uploadIdMidia = `midia_${dados.mensagem?.id || `${dados.tipoMensagem}_${timestamp}`}`;
                const notificacaoMidia = {
                    uploadId: uploadIdMidia,
                    tipoMidia: dados.tipoMensagem || null
                };
                let sucessoProcessamentoMidia = false;

                // Notificação visual no chat de suporte: mídia pesada em processamento
                if (SocketController && webhookBody && dadosUsuario?.idAgentePedir) {
                    try {
                        SocketController.notificarMidiaProcessando(
                            dadosUsuario.idAgentePedir,
                            webhookBody,
                            {
                                ...notificacaoMidia,
                                percentual: 0
                            }
                        );
                    } catch (_) {}
                }
                try {
                    const linkMidia = await this.processarMidiaECDN(dados, dadosUsuario, timestamp, webhookBody, notificacaoMidia);
                    if (linkMidia) {
                        sucessoProcessamentoMidia = true;
                        // Para áudio, salvar na coluna 'audio'
                        if (dados.tipoMensagem === 'audio') {
                            dadosConteudo.audio = linkMidia;
                            // Se tiver duração do áudio, salvar também
                            if (dados.mensagem.audio?.duration) {
                                dadosConteudo.duracao_audio = parseInt(dados.mensagem.audio.duration) || null;
                            }
                        } else {
                            // Para imagem, vídeo e documento, salvar na coluna 'documento'
                            dadosConteudo.documento = linkMidia;

                            // Para documento, salvar o nome do arquivo na mensagem se disponível
                            // Para imagem, não sobrescrever o texto transcrito (se houver)
                            if (dados.tipoMensagem === 'document' && dados.mensagem.document?.filename) {
                                dadosConteudo.mensagem = dados.mensagem.document.filename;
                            }
                            // Para imagem, manter o texto transcrito (já definido anteriormente)
                            // Se não houver texto transcrito, a mensagem ficará vazia (comportamento esperado)
                        }
                    }
                } catch (error) {
                    // Se for erro de tamanho (arquivo muito grande), salvar mensagem com texto de erro
                    if (error.message && error.message.includes('muito grande')) {
                        displayWarn(`[ControleMDSalvarMensagemRecebida] Arquivo muito grande, salvando mensagem com texto de erro: ${error.message}`);
                        // Sobrescrever mensagem com texto de erro (mas manter texto transcrito se for imagem/áudio)
                        if (!dadosConteudo.mensagem || dadosConteudo.mensagem.trim() === '') {
                            dadosConteudo.mensagem = error.message;
                        } else {
                            // Se já tiver mensagem (texto transcrito), adicionar aviso
                            dadosConteudo.mensagem = `${dadosConteudo.mensagem}\n\n⚠️ ${error.message}`;
                        }
                    } else {
                        // Para outros erros, logar e continuar (pode tentar salvar sem link)
                        displayError(`[ControleMDSalvarMensagemRecebida] Erro ao processar mídia (não é de tamanho): ${error.message}`);
                    }
                } finally {
                    if (SocketController && webhookBody && dadosUsuario?.idAgentePedir) {
                        try {
                            SocketController.notificarMidiaDisponivel(
                                dadosUsuario.idAgentePedir,
                                webhookBody,
                                {
                                    ...notificacaoMidia,
                                    sucesso: sucessoProcessamentoMidia
                                }
                            );
                        } catch (_) {}
                    }
                }
            }

            // Salva a mensagem no banco de dados
            const resultado = await this.controleMensagem.salvarMensagem({
                dadosConteudo: dadosConteudo
            });

            const idMensagem = resultado?.idMensagem || resultado || 0;

            if (idMensagem > 0) {

                displayWarn('[ControleMDSalvarMensagemRecebida] enviar mensagem via Socket.IO:');

                // Envia mensagem via Socket.IO se SocketController estiver disponível e webhookBody fornecido
                if (SocketController && webhookBody) {
                    try {
                        //SocketController.sendMessage(webhookBody, true);
                        // Processa o webhook e envia mensagens via Socket.IO
                        const result = SocketController.processWebhook(webhookBody);

                        if (result.success) {
                            displayLog(`[WhatsApp Webhook] ${result.message}`);
                            if (result.totalSent > 0) {
                                displayLog(`[WhatsApp Webhook] ${result.totalSent} mensagem(ns) enviada(s) via Socket.IO`);
                            }
                        } else {
                            displayWarn(`[WhatsApp Webhook] ${result.message}`);
                        }
                    } catch (error) {
                        displayError('[ControleMDSalvarMensagemRecebida] Erro ao enviar mensagem via Socket.IO:', error.message);
                    }
                }

                return {
                    success: true,
                    id: idMensagem,
                    message: 'Mensagem salva com sucesso'
                };

            } else {
                return {
                    success: false,
                    id: 0,
                    message: 'Falha ao salvar mensagem no banco de dados'
                };
            }
        } catch (error) {
            displayError('[ControleMDSalvarMensagemRecebida] Erro ao salvar mensagem:', error.message);
            return {
                success: false,
                id: 0,
                message: `Erro ao salvar mensagem: ${error.message}`
            };
        }
    }
}
