import { comprimirImagem } from "./imageCompressor.js";
import { comprimirAudio, converterAudioParaOGG } from "./audioConverter.js";
import { comprimirVideo } from "./videoCompressor.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "./displayLogWebhook.js";

/**
 * Processa e valida mídia (imagem, áudio, documento) antes de enviar ao CDN
 * Reutiliza a mesma lógica do fluxo de envio
 * @param {Buffer|string} conteudo - Conteúdo em Buffer ou base64
 * @param {string} tipoArquivo - Tipo do arquivo ('image', 'audio', 'documento', etc)
 * @param {string} tipoMime - MIME type do arquivo
 * @param {string} nomeArquivo - Nome do arquivo (opcional)
 * @param {boolean} jaComprimido - Se true, arquivo já foi comprimido em outra camada (ex: PHP)
 * @param {{directUpload?: boolean}} options - Opções do pipeline
 * @returns {Promise<{base64?: string, buffer?: Buffer, tipoMime: string, nomeArquivo: string, originalSize?: number, compressedSize?: number}>}
 * @throws {Error} Se o arquivo for muito grande mesmo após compressão
 */
export async function processarEValidarMidia(conteudo, tipoArquivo, tipoMime, nomeArquivo = null, jaComprimido = false, options = {}) {
    const directUpload = options?.directUpload === true;
    // Normalizar tipo de arquivo
    let tipoArquivoNormalizado = tipoArquivo?.toLowerCase() || '';
    let tipoMimeParaCDN = tipoMime || 'application/octet-stream';
    let nomeArquivoParaCDN = nomeArquivo || `arquivo_${Date.now()}`;
    
    // CORREÇÃO: Se o tipo for "documento" mas o mimeType for audio/*, tratar como áudio
    // Isso corrige casos onde MP3, M4A, etc. vêm com tipo="documento"
    if (tipoArquivoNormalizado === 'documento' && tipoMimeParaCDN.startsWith('audio/')) {
        displayLog(`[mediaProcessor] 🔧 Correção: tipo="documento" mas mimeType="${tipoMimeParaCDN}" → tratando como áudio`);
        tipoArquivoNormalizado = 'audio';
    }
    
    const conteudoEhBuffer = Buffer.isBuffer(conteudo);
    let conteudoBuffer = null;
    let conteudoBase64 = null;

    if (conteudoEhBuffer) {
        conteudoBuffer = conteudo;
        if (!directUpload) {
            conteudoBase64 = conteudo.toString('base64');
        }
    } else {
        const conteudoString = String(conteudo || '');
        const base64DataInput = conteudoString.includes(',')
            ? conteudoString.split(',')[1]
            : conteudoString;
        conteudoBase64 = base64DataInput;
        conteudoBuffer = Buffer.from(base64DataInput, 'base64');
    }

    const base64Data = conteudoBase64 ?? conteudoBuffer.toString('base64');
    if (!conteudoBase64) {
        conteudoBase64 = base64Data;
    }
    const tamanhoOriginal = conteudoBuffer.byteLength;

    // Detectar tipo real por assinatura (magic bytes) para evitar mismatch (ex.: URL .mp3 contendo OGG/Opus)
    // A Meta rejeita quando declaramos audio/mpeg mas os bytes são OGG/Opus (erro 131053).
    const header4 = conteudoBuffer.subarray(0, 4).toString('ascii');
    const header3 = conteudoBuffer.subarray(0, 3).toString('ascii');
    const header4Upper = header4.toUpperCase();
    const header3Upper = header3.toUpperCase();

    // Heurísticas simples:
    // - OGG: começa com "OggS"
    // - MP3: começa com "ID3" ou frame sync 0xFFEx
    // - WAV: começa com "RIFF" e depois "WAVE" (bytes 8-11)
    let tipoReal = null;
    if (header4 === 'OggS') {
        tipoReal = 'ogg';
    } else if (header3Upper === 'ID3' || (conteudoBuffer.length >= 2 && conteudoBuffer[0] === 0xFF && (conteudoBuffer[1] & 0xE0) === 0xE0)) {
        tipoReal = 'mp3';
    } else if (header4Upper === 'RIFF' && conteudoBuffer.length >= 12 && conteudoBuffer.subarray(8, 12).toString('ascii').toUpperCase() === 'WAVE') {
        tipoReal = 'wav';
    }
    
    displayLog(`[mediaProcessor] 📦 Processando arquivo: tipo=${tipoArquivoNormalizado}, tamanho=${(tamanhoOriginal / 1024 / 1024).toFixed(2)}MB, mimeType=${tipoMimeParaCDN}, jaComprimido=${jaComprimido ? 'sim' : 'não'}`);
    
    let conteudoProcessado = conteudoBase64 ?? conteudoBuffer.toString('base64');
    let conteudoProcessadoBuffer = conteudoBuffer;
    let tipoMimeProcessado = tipoMimeParaCDN;
    let nomeArquivoProcessado = nomeArquivoParaCDN;
    let tamanhoProcessado = tamanhoOriginal;

    // Correção preventiva: se o conteúdo é OGG mas veio rotulado/nominalmente como MP3, ajustar antes do restante do pipeline
    if ((tipoArquivoNormalizado === 'audio' || tipoMimeParaCDN.startsWith('audio/')) && base64Data && tipoReal === 'ogg') {
        const mimeInformado = (tipoMimeParaCDN || '').toLowerCase();
        const nomeInformado = (nomeArquivoParaCDN || '').toLowerCase();
        const pareceMp3 = mimeInformado.includes('audio/mpeg') || nomeInformado.endsWith('.mp3');

        if (pareceMp3) {
            displayWarn(`[mediaProcessor] ⚠️ Detecção por magic bytes: arquivo é OGG (OggS) mas veio como mimeType="${tipoMimeParaCDN}" nome="${nomeArquivoParaCDN}". Ajustando para evitar erro 131053 na Meta...`);
            tipoMimeProcessado = 'audio/ogg; codecs=opus';

            // Ajustar nome do arquivo para .ogg mantendo o basename quando possível
            if (nomeArquivoProcessado) {
                const semExt = nomeArquivoProcessado.replace(/\.[^/.]+$/, '');
                nomeArquivoProcessado = `${semExt}.ogg`;
            } else {
                nomeArquivoProcessado = `audio_${Date.now()}.ogg`;
            }
        }
    }
    
    // Se for imagem, comprimir para garantir que fique abaixo do limite
    // Se já foi comprimida no PHP (flag jaComprimido), apenas validar e pular etapa pesada de compressão inicial,
    // mantendo ainda a validação de tamanho/JSON mais abaixo.
    if (!jaComprimido && (tipoArquivoNormalizado === 'image' || tipoArquivoNormalizado === 'imagem') && base64Data) {
        try {
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const imageSize = imageBuffer.byteLength;
            
            displayLog(`[mediaProcessor] 📸 Processando imagem: ${(imageSize / 1024 / 1024).toFixed(2)}MB, tipo: ${tipoMimeParaCDN}`);
            
            const limiteComprimir = directUpload
                ? 16 * 1024 * 1024 // No fluxo direto, alvo de 16MB
                : 2 * 1024 * 1024; // No legado, alvo de 2MB
            const qualidadeImagem = directUpload ? 90 : 70;
            
            // No direto só comprime se passar de 16MB; no legado mantém gatilho antigo
            const deveComprimirImagem = directUpload
                ? imageSize > limiteComprimir
                : imageSize > 1.5 * 1024 * 1024;
            if (deveComprimirImagem) {
                displayLog(`[mediaProcessor] 🔄 Comprimindo imagem (${(imageSize / 1024 / 1024).toFixed(2)}MB) para máximo ${(limiteComprimir / 1024 / 1024).toFixed(2)}MB...`);
                
                const resultadoCompressao = await comprimirImagem(
                    imageBuffer,
                    tipoMimeParaCDN,
                    limiteComprimir, // Limite de 2MB
                    qualidadeImagem
                );
                
                if (resultadoCompressao.compressed || resultadoCompressao.compressedSize < imageSize) {
                    // Converte o buffer comprimido de volta para base64
                    conteudoProcessadoBuffer = resultadoCompressao.buffer;
                    conteudoProcessado = resultadoCompressao.buffer.toString('base64');
                    tipoMimeProcessado = resultadoCompressao.mimeType;
                    tamanhoProcessado = resultadoCompressao.compressedSize;
                    
                    const tamanhoBase64Final = Buffer.byteLength(conteudoProcessado, 'utf8');
                    displayLog(`[mediaProcessor] ✅ Imagem comprimida: ${(resultadoCompressao.originalSize / 1024 / 1024).toFixed(2)}MB → ${(resultadoCompressao.compressedSize / 1024 / 1024).toFixed(2)}MB (redução de ${resultadoCompressao.reduction || ((imageSize - resultadoCompressao.compressedSize) / imageSize * 100).toFixed(2)}%)`);
                    displayLog(`[mediaProcessor] 📊 Tamanho base64 final: ${(tamanhoBase64Final / 1024 / 1024).toFixed(2)}MB`);
                } else if (resultadoCompressao.error) {
                    displayWarn(`[mediaProcessor] ⚠️ Erro ao comprimir imagem: ${resultadoCompressao.error}, usando imagem original`);
                } else {
                    displayLog(`[mediaProcessor] ℹ️ Imagem não foi comprimida (já estava abaixo do limite)`);
                }
            } else {
                displayLog(`[mediaProcessor] ℹ️ Imagem muito pequena (${(imageSize / 1024).toFixed(2)}KB), não precisa comprimir`);
            }
        } catch (error) {
            displayError(`[mediaProcessor] ❌ Erro ao comprimir imagem: ${error.message}`, error.stack);
            // Continua com a imagem original em caso de erro
        }
    }
    
    // Se for áudio, validar tamanho e comprimir se necessário
    // IMPORTANTE: Processar áudio ANTES de documento para pegar casos onde tipo="documento" mas mimeType="audio/*"
    if ((tipoArquivoNormalizado === 'audio' || tipoMimeParaCDN.startsWith('audio/')) && base64Data) {
        try {
            const audioBuffer = Buffer.from(base64Data, 'base64');
            const audioSize = audioBuffer.byteLength;
            
            displayLog(`[mediaProcessor] 🎵 Processando áudio: ${(audioSize / 1024 / 1024).toFixed(2)}MB, tipo: ${tipoMimeParaCDN}`);
            
            // Determinar formato original
            let formatoOriginal = null;
            if (nomeArquivo) {
                const extensao = nomeArquivo.split('.').pop()?.toLowerCase();
                if (extensao && ['webm', 'ogg', 'mp3', 'm4a', 'wav', 'aac', 'amr'].includes(extensao)) {
                    formatoOriginal = extensao;
                }
            }
            
            // Se detectamos magic bytes, isso tem prioridade (corrige arquivos renomeados incorretamente)
            if (tipoReal && ['ogg', 'mp3', 'wav'].includes(tipoReal)) {
                formatoOriginal = tipoReal;
            }

            // Se não conseguiu pelo nome, tentar pelo mimeType
            if (!formatoOriginal && tipoMime) {
                const match = tipoMime.match(/audio\/(\w+)/);
                if (match && match[1]) {
                    const mimeFormat = match[1].toLowerCase();
                    // Mapear formatos comuns do mimeType para extensões
                    const mimeToExt = {
                        'mpeg': 'mp3',
                        'mp3': 'mp3',
                        'x-mpeg': 'mp3',
                        'x-mp3': 'mp3',
                        'ogg': 'ogg',
                        'opus': 'ogg',
                        'webm': 'webm',
                        'wav': 'wav',
                        'x-wav': 'wav',
                        'm4a': 'm4a',
                        'x-m4a': 'm4a',
                        'aac': 'aac',
                        'amr': 'amr'
                    };
                    formatoOriginal = mimeToExt[mimeFormat] || mimeFormat;
                }
            }
            
            // Se ainda não conseguiu, usar 'mp3' como padrão (mais comum) ao invés de 'webm'
            if (!formatoOriginal) {
                formatoOriginal = 'mp3';
            }
            
            // Limite para áudio: 2MB (limite do servidor: Node.js, nginx e PHP)
            const limiteAudio = 2 * 1024 * 1024; // 2MB
            
            // Se for WebM (precisa converter para OGG) ou se o áudio for muito grande (exceto MP3), processar
            // IMPORTANTE: não converter MP3 para OGG – atender requisito de manter .mp3 como está.
            if (formatoOriginal === 'webm' || (audioSize > limiteAudio && formatoOriginal !== 'mp3')) {
                const acao = formatoOriginal === 'webm' ? 'conversão WebM→OGG' : 
                            audioSize > limiteAudio ? 'compressão necessária' : 'processamento';
                displayLog(`[mediaProcessor] 🔄 Processando áudio (${acao})...`);
                
                // Se for muito grande e não for MP3, usar compressão progressiva (gera OGG/Opus)
                if (audioSize > limiteAudio && formatoOriginal !== 'mp3') {
                    displayLog(`[mediaProcessor] 🔄 Comprimindo áudio ${formatoOriginal} (${(audioSize / 1024 / 1024).toFixed(2)}MB) para máximo ${(limiteAudio / 1024 / 1024).toFixed(2)}MB...`);
                    displayLog(`[mediaProcessor] ℹ️ Nota: Áudios grandes são convertidos para OGG Opus para melhor compressão (formato original: ${formatoOriginal})`);
                    
                    // IMPORTANTE: comprimirAudio sempre converte para OGG Opus porque:
                    // 1. OGG Opus permite compressão muito mais efetiva que MP3
                    // 2. É o formato necessário para notas de voz no WhatsApp
                    // 3. Permite reduzir bitrate progressivamente até atingir o tamanho desejado
                    const resultadoCompressao = await comprimirAudio(
                        conteudoBase64,
                        formatoOriginal,
                        limiteAudio // Limite de 2MB
                    );
                    
                    if (resultadoCompressao.compressed || resultadoCompressao.compressedSize < audioSize) {
                        conteudoProcessado = resultadoCompressao.base64;
                        conteudoProcessadoBuffer = Buffer.from(resultadoCompressao.base64.includes(',') ? resultadoCompressao.base64.split(',')[1] : resultadoCompressao.base64, 'base64');
                        tipoMimeProcessado = resultadoCompressao.tipoMime;
                        nomeArquivoProcessado = resultadoCompressao.nomeArquivo;
                        tamanhoProcessado = resultadoCompressao.compressedSize;
                        
                        const tamanhoBase64Final = Buffer.byteLength(conteudoProcessado, 'utf8');
                        displayLog(`[mediaProcessor] ✅ Áudio comprimido: ${(resultadoCompressao.originalSize / 1024 / 1024).toFixed(2)}MB → ${(resultadoCompressao.compressedSize / 1024 / 1024).toFixed(2)}MB (convertido para OGG Opus)`);
                        displayLog(`[mediaProcessor] 📊 Tamanho base64 final: ${(tamanhoBase64Final / 1024 / 1024).toFixed(2)}MB`);
                    } else if (resultadoCompressao.error) {
                        displayWarn(`[mediaProcessor] ⚠️ Erro ao comprimir áudio: ${resultadoCompressao.error}, usando conversão padrão`);
                        // Tenta conversão padrão
                        const resultadoConversao = await converterAudioParaOGG(conteudoBase64, formatoOriginal);
                        conteudoProcessado = resultadoConversao.base64;
                        conteudoProcessadoBuffer = Buffer.from(resultadoConversao.base64.includes(',') ? resultadoConversao.base64.split(',')[1] : resultadoConversao.base64, 'base64');
                        tipoMimeProcessado = resultadoConversao.tipoMime;
                        nomeArquivoProcessado = resultadoConversao.nomeArquivo;
                    }
                } else {
                    // Se não precisa comprimir, apenas converte WebM para OGG (WebM precisa ser convertido)
                    if (formatoOriginal === 'webm') {
                        displayLog(`[mediaProcessor] 🔄 Convertendo WebM para OGG Opus (formato necessário para WhatsApp)...`);
                        const resultadoConversao = await converterAudioParaOGG(conteudoBase64, formatoOriginal);
                        conteudoProcessado = resultadoConversao.base64;
                        conteudoProcessadoBuffer = Buffer.from(resultadoConversao.base64.includes(',') ? resultadoConversao.base64.split(',')[1] : resultadoConversao.base64, 'base64');
                        tipoMimeProcessado = resultadoConversao.tipoMime;
                        nomeArquivoProcessado = resultadoConversao.nomeArquivo;
                    } else {
                        // Se não é WebM e não precisa comprimir, manter formato original
                        displayLog(`[mediaProcessor] ℹ️ Áudio ${formatoOriginal} dentro do limite (${(audioSize / 1024 / 1024).toFixed(2)}MB), mantendo formato original`);
                    }
                }
            } else {
                // Áudio pequeno e não é WebM, usar como está (manter formato original)
                displayLog(`[mediaProcessor] ℹ️ Áudio ${formatoOriginal} dentro do limite (${(audioSize / 1024 / 1024).toFixed(2)}MB), não precisa comprimir nem converter`);
            }
            
            // Validação final: se o áudio ainda estiver muito grande após compressão
            const audioBufferFinal = conteudoProcessadoBuffer || Buffer.from(conteudoProcessado.includes(',') ? conteudoProcessado.split(',')[1] : conteudoProcessado, 'base64');
            const audioSizeFinal = audioBufferFinal.byteLength;
            
            // Calcular tamanho do JSON final
            const jsonStringAudio = JSON.stringify({
                base64: conteudoProcessado,
                tipoMime: tipoMimeProcessado,
                nomeArquivo: nomeArquivoProcessado,
                tipoArquivo: tipoArquivoNormalizado
            });
            const tamanhoJSONAudio = Buffer.byteLength(jsonStringAudio, 'utf8');
            
            // Limite flexível: se comprimiu bastante (redução > 50%) mas ainda está um pouco acima,
            // aceita se o JSON final estiver abaixo de 2MB (limite do servidor)
            const reducaoPercentual = ((audioSize - audioSizeFinal) / audioSize) * 100;
            const limiteFlexivel = 2 * 1024 * 1024; // 2MB (limite do servidor)
            
            // Para MP3, não bloquear por tamanho aqui – mantém exatamente o arquivo original,
            // mesmo que ultrapasse o limite de 2MB, atendendo o requisito de não converter nem rejeitar MP3.
            if (formatoOriginal === 'mp3') {
                displayLog(`[mediaProcessor] ℹ️ Áudio MP3 mantido sem conversão/compressão (tamanho: ${(audioSizeFinal / 1024 / 1024).toFixed(2)}MB)`);
            } else if (audioSizeFinal > limiteAudio) {
                // Se comprimiu bastante e JSON está abaixo do limite do servidor, aceita
                if (reducaoPercentual > 50 && tamanhoJSONAudio <= limiteFlexivel) {
                    displayLog(`[mediaProcessor] ⚠️ Áudio comprimido ${reducaoPercentual.toFixed(1)}% mas ainda acima do limite ideal (${(audioSizeFinal / 1024 / 1024).toFixed(2)}MB > ${(limiteAudio / 1024 / 1024).toFixed(2)}MB)`);
                    displayLog(`[mediaProcessor] ✅ Mas JSON final (${(tamanhoJSONAudio / 1024 / 1024).toFixed(2)}MB) está dentro do limite do servidor, aceitando...`);
                    // Continua o processamento normalmente
                } else {
                    // Se não comprimiu o suficiente ou JSON está muito grande, lança erro
                    displayError(`[mediaProcessor] ❌ Áudio muito grande após compressão: ${(audioSizeFinal / 1024 / 1024).toFixed(2)}MB > ${(limiteAudio / 1024 / 1024).toFixed(2)}MB`);
                    displayError(`[mediaProcessor] Redução: ${reducaoPercentual.toFixed(1)}%, JSON: ${(tamanhoJSONAudio / 1024 / 1024).toFixed(2)}MB`);
                    
                    const tipoArquivoDescricao = 'áudio';
                    throw new Error(`${tipoArquivoDescricao.charAt(0).toUpperCase() + tipoArquivoDescricao.slice(1)} muito grande mesmo após compressão. Tamanho: ${(audioSizeFinal / 1024 / 1024).toFixed(2)}MB. Tamanho do JSON: ${(tamanhoJSONAudio / 1024 / 1024).toFixed(2)}MB. Limite máximo: ${(limiteAudio / 1024 / 1024).toFixed(2)}MB. Áudios muito longos podem não ser comprimidos o suficiente.`);
                }
            }
            
        } catch (error) {
            // Se já é um erro de tamanho, relançar
            if (error.message.includes('muito grande')) {
                throw error;
            }
            displayError(`[mediaProcessor] ❌ Erro ao processar áudio: ${error.message}`, error.stack);
            // Em caso de outro erro, continua com o áudio original
        }
    }

    // Se for vídeo, comprimir para garantir que o JSON enviado ao CDN fique abaixo de 2MB.
    // Base64 aumenta ~33% o tamanho; alvo de 1,5MB no arquivo deixa o payload (base64 + chaves) < 2MB.
    if (!jaComprimido && tipoArquivoNormalizado === 'video' && base64Data) {
        try {
            const videoSize = conteudoBuffer.byteLength;
            displayLog(`[mediaProcessor] 🎬 Processando vídeo: ${(videoSize / 1024 / 1024).toFixed(2)}MB, tipo: ${tipoMimeParaCDN}`);

            const limiteVideo = directUpload
                ? 16 * 1024 * 1024 // No fluxo direto deve caber em 16MB
                : 1.5 * 1024 * 1024; // 1,5MB para fluxo legado base64->PHP

            let formatoVideo = 'mp4';
            if (nomeArquivoParaCDN) {
                const ext = nomeArquivoParaCDN.split('.').pop()?.toLowerCase();
                if (ext && ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v'].includes(ext)) formatoVideo = ext;
            }
            if (tipoMimeParaCDN.includes('webm')) formatoVideo = 'webm';
            if (tipoMimeParaCDN.includes('quicktime') || tipoMimeParaCDN.includes('x-mov')) formatoVideo = 'mov';

            const resultadoCompressao = await comprimirVideo(
                conteudoProcessadoBuffer || conteudoBuffer,
                formatoVideo,
                limiteVideo,
                {
                    strictMaxSize: directUpload,
                    minQualityPercent: directUpload ? 90 : 60,
                    hardMaxSizeBytes: directUpload ? 21 * 1024 * 1024 : null,
                    onProgress: options?.onVideoProgress
                }
            );

            if (resultadoCompressao.compressed || resultadoCompressao.compressedSize < videoSize) {
                conteudoProcessado = resultadoCompressao.base64;
                conteudoProcessadoBuffer = resultadoCompressao.buffer || Buffer.from(resultadoCompressao.base64.includes(',') ? resultadoCompressao.base64.split(',')[1] : resultadoCompressao.base64, 'base64');
                tipoMimeProcessado = resultadoCompressao.tipoMime;
                nomeArquivoProcessado = resultadoCompressao.nomeArquivo;
                tamanhoProcessado = resultadoCompressao.compressedSize;
                displayLog(`[mediaProcessor] ✅ Vídeo comprimido: ${(resultadoCompressao.originalSize / 1024 / 1024).toFixed(2)}MB → ${(resultadoCompressao.compressedSize / 1024 / 1024).toFixed(2)}MB`);
            } else if (resultadoCompressao.error) {
                displayWarn(`[mediaProcessor] ⚠️ Erro ao comprimir vídeo: ${resultadoCompressao.error}, usando original`);
            }
        } catch (error) {
            if (error?.message && error.message.includes('muito grande')) {
                throw error;
            }
            displayError(`[mediaProcessor] ❌ Erro ao comprimir vídeo: ${error.message}`, error.stack);
        }
    }
    
    // Se for documento (PDF, etc), validar tamanho antes de enviar
    // IMPORTANTE: Excluir áudios que podem vir com tipo="documento" mas já foram processados acima
    // PDFs não podem ser comprimidos como imagens, então apenas validamos
    if ((tipoArquivoNormalizado === 'documento' || tipoMimeParaCDN.includes('pdf') || tipoMimeParaCDN.includes('document')) 
        && !tipoMimeParaCDN.startsWith('audio/') && base64Data) {
        try {
            const documentoBuffer = Buffer.from(base64Data, 'base64');
            const documentoSize = documentoBuffer.byteLength;
            
            displayLog(`[mediaProcessor] 📄 Processando documento: ${(documentoSize / 1024 / 1024).toFixed(2)}MB, tipo: ${tipoMimeParaCDN}`);
            
            // Limite para documentos: 2MB (limite do servidor: Node.js, nginx e PHP)
            const limiteDocumento = 2 * 1024 * 1024; // 2MB
            
            if (documentoSize > limiteDocumento) {
                displayError(`[mediaProcessor] ❌ Documento muito grande: ${(documentoSize / 1024 / 1024).toFixed(2)}MB > ${(limiteDocumento / 1024 / 1024).toFixed(2)}MB`);
                
                // Calcular tamanho do JSON final
                const jsonStringDoc = JSON.stringify({
                    base64: conteudoProcessado,
                    tipoMime: tipoMimeProcessado,
                    nomeArquivo: nomeArquivoProcessado,
                    tipoArquivo: tipoArquivoNormalizado
                });
                const tamanhoJSONDoc = Buffer.byteLength(jsonStringDoc, 'utf8');
                
                const tipoArquivoDescricao = 'documento';
                throw new Error(`${tipoArquivoDescricao.charAt(0).toUpperCase() + tipoArquivoDescricao.slice(1)} muito grande. Tamanho: ${(documentoSize / 1024 / 1024).toFixed(2)}MB. Tamanho do JSON: ${(tamanhoJSONDoc / 1024 / 1024).toFixed(2)}MB. Limite máximo: ${(limiteDocumento / 1024 / 1024).toFixed(2)}MB. PDFs não podem ser comprimidos automaticamente.`);
            } else {
                displayLog(`[mediaProcessor] ✅ Documento dentro do limite: ${(documentoSize / 1024 / 1024).toFixed(2)}MB`);
            }
        } catch (error) {
            // Se já é um erro de tamanho, relançar
            if (error.message.includes('muito grande')) {
                throw error;
            }
            displayError(`[mediaProcessor] ❌ Erro ao validar documento: ${error.message}`);
            // Continua com o documento original em caso de outro erro
        }
    }
    
    // Preparar dados para validação final do JSON
    const dadosCDN = {
        base64: conteudoProcessado,
        tipoMime: tipoMimeProcessado,
        nomeArquivo: nomeArquivoProcessado,
        tipoArquivo: tipoArquivoNormalizado
    };
    
    // Verificar tamanho do JSON antes de enviar
    const jsonString = JSON.stringify(dadosCDN);
    const tamanhoJSON = Buffer.byteLength(jsonString, 'utf8');
    if (!directUpload) {
        displayLog(`[mediaProcessor] 📦 Tamanho do JSON para CDN: ${(tamanhoJSON / 1024 / 1024).toFixed(2)}MB`);
    }
    
    // Se o JSON ainda estiver muito grande (> 1.8MB), tentar comprimir mais agressivamente (apenas imagens)
    const limiteJSON = 1.8 * 1024 * 1024; // 1.8MB (margem antes do limite de 2MB)
    if (!directUpload && tamanhoJSON > limiteJSON && (tipoArquivoNormalizado === 'image' || tipoArquivoNormalizado === 'imagem')) {
        displayWarn(`[mediaProcessor] ⚠️ JSON ainda muito grande (${(tamanhoJSON / 1024 / 1024).toFixed(2)}MB > ${(limiteJSON / 1024 / 1024).toFixed(2)}MB), tentando comprimir mais agressivamente...`);
        
        try {
            const base64DataRecompress = conteudoProcessado.includes(',') 
                ? conteudoProcessado.split(',')[1] 
                : conteudoProcessado;
            const imageBufferRecompress = Buffer.from(base64DataRecompress, 'base64');
            
            // Limite agressivo: 1.6MB (para garantir que JSON final fique abaixo de 2MB)
            const limiteAgressivo = 1.6 * 1024 * 1024; // 1.6MB
            
            displayLog(`[mediaProcessor] 🔄 Recompressão agressiva: limitando a ${(limiteAgressivo / 1024 / 1024).toFixed(2)}MB...`);
            
            const resultadoCompressao = await comprimirImagem(
                imageBufferRecompress,
                tipoMimeProcessado,
                limiteAgressivo, // Limite agressivo: 1.6MB
                60 // Qualidade menor: 60%
            );
            
            if (resultadoCompressao.compressed || resultadoCompressao.compressedSize < imageBufferRecompress.byteLength) {
                conteudoProcessadoBuffer = resultadoCompressao.buffer;
                conteudoProcessado = resultadoCompressao.buffer.toString('base64');
                tipoMimeProcessado = resultadoCompressao.mimeType;
                dadosCDN.base64 = conteudoProcessado;
                dadosCDN.tipoMime = tipoMimeProcessado;
                
                const novoJsonString = JSON.stringify(dadosCDN);
                const novoTamanhoJSON = Buffer.byteLength(novoJsonString, 'utf8');
                displayLog(`[mediaProcessor] ✅ Recompressão concluída: JSON agora tem ${(novoTamanhoJSON / 1024 / 1024).toFixed(2)}MB`);
                
                // Se ainda estiver muito grande, lançar erro
                if (novoTamanhoJSON > 2 * 1024 * 1024) {
                    displayError(`[mediaProcessor] ❌ ERRO: JSON ainda muito grande após recompressão (${(novoTamanhoJSON / 1024 / 1024).toFixed(2)}MB). Imagem muito grande para processar.`);
                    const tipoArquivoDescricao = 'imagem';
                    throw new Error(`${tipoArquivoDescricao.charAt(0).toUpperCase() + tipoArquivoDescricao.slice(1)} muito grande. Tamanho após compressão: ${(novoTamanhoJSON / 1024 / 1024).toFixed(2)}MB. Limite máximo: 2MB.`);
                }
            } else {
                displayWarn(`[mediaProcessor] ⚠️ Recompressão não conseguiu reduzir o tamanho`);
            }
        } catch (error) {
            // Se já é um erro de tamanho, relançar
            if (error.message.includes('muito grande')) {
                throw error;
            }
            displayError(`[mediaProcessor] ❌ Erro na recompressão: ${error.message}`);
            throw new Error(`Erro ao comprimir imagem: ${error.message}`);
        }
    }
    
    // Validação final: se JSON ainda estiver > 2MB, lançar erro ANTES de enviar
    // Limite do servidor: 2MB (Node.js, nginx e PHP)
    const jsonStringFinal = JSON.stringify(dadosCDN);
    const tamanhoJSONFinal = Buffer.byteLength(jsonStringFinal, 'utf8');
    const limiteFinal = 2 * 1024 * 1024; // 2MB (limite do servidor)
    
    if (!directUpload && tamanhoJSONFinal > limiteFinal) {
        const tipoArquivoDescricao = tipoArquivoNormalizado === 'audio' ? 'áudio' : 
                                     tipoArquivoNormalizado === 'image' || tipoArquivoNormalizado === 'imagem' ? 'imagem' : 
                                     tipoArquivoNormalizado === 'documento' ? 'documento' : 
                                     tipoArquivoNormalizado === 'video' ? 'vídeo' : 'arquivo';
        
        displayError(`[mediaProcessor] ❌ ERRO CRÍTICO: JSON final ainda muito grande (${(tamanhoJSONFinal / 1024 / 1024).toFixed(2)}MB > ${(limiteFinal / 1024 / 1024).toFixed(2)}MB)`);
        displayError(`[mediaProcessor] Detalhes: tipo=${tipoArquivoNormalizado}, tamanhoBase64=${(Buffer.byteLength(conteudoProcessado, 'utf8') / 1024 / 1024).toFixed(2)}MB`);
        
        throw new Error(`${tipoArquivoDescricao.charAt(0).toUpperCase() + tipoArquivoDescricao.slice(1)} muito grande mesmo após compressão. Tamanho: ${(tamanhoJSONFinal / 1024 / 1024).toFixed(2)}MB. Limite máximo: ${(limiteFinal / 1024 / 1024).toFixed(2)}MB. Por favor, use um arquivo menor.`);
    }
    
    if (!directUpload) {
        displayLog(`[mediaProcessor] ✅ Validação OK: JSON final tem ${(tamanhoJSONFinal / 1024 / 1024).toFixed(2)}MB (limite: ${(limiteFinal / 1024 / 1024).toFixed(2)}MB)`);
    }
    
    return {
        base64: directUpload ? undefined : conteudoProcessado,
        buffer: conteudoProcessadoBuffer || Buffer.from(conteudoProcessado.includes(',') ? conteudoProcessado.split(',')[1] : conteudoProcessado, 'base64'),
        tipoMime: tipoMimeProcessado,
        nomeArquivo: nomeArquivoProcessado,
        originalSize: tamanhoOriginal,
        compressedSize: tamanhoProcessado
    };
}
