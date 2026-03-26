import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { log as displayLog, warn as displayWarn, error as displayError } from './displayLogWebhook.js';

// Configurar o caminho do ffmpeg
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

/**
 * Converte áudio base64 para OGG Opus (formato para nota de voz no WhatsApp)
 * @param {string} audioBase64 - Áudio em base64
 * @param {string} formatoOriginal - Formato original do áudio (ex: 'webm', 'mp3', 'm4a')
 * @param {number} bitrate - Bitrate em kbps (padrão: 64, pode ser reduzido para compressão)
 * @returns {Promise<{base64: string, nomeArquivo: string, tipoMime: string, originalSize: number, compressedSize: number}>} Base64 do OGG, nome do arquivo e tipo MIME
 */
export async function converterAudioParaOGG(audioBase64, formatoOriginal = 'webm', bitrate = 64) {
    try {
        // Remover prefixo data:audio/...;base64, se existir
        const base64Data = audioBase64.includes(',') 
            ? audioBase64.split(',')[1] 
            : audioBase64;
        
        // Converter base64 para buffer
        const audioBuffer = Buffer.from(base64Data, 'base64');
        const originalSize = audioBuffer.byteLength;
        
        // Criar arquivo temporário de entrada
        const tempInputPath = join(tmpdir(), `audio_input_${Date.now()}.${formatoOriginal}`);
        const tempOutputPath = join(tmpdir(), `audio_output_${Date.now()}.ogg`);
        
        try {
            // Escrever buffer no arquivo temporário
            writeFileSync(tempInputPath, audioBuffer);
            
            // Converter para OGG Opus usando ffmpeg
            // OGG Opus é o formato necessário para aparecer como nota de voz no WhatsApp
            await new Promise((resolve, reject) => {
                ffmpeg(tempInputPath)
                    .toFormat('ogg')
                    .audioCodec('libopus')  // Codec Opus para nota de voz
                    .audioBitrate(bitrate)  // Bitrate configurável (padrão: 64kbps)
                    .audioChannels(1)       // Mono para voz
                    .audioFrequency(48000)   // Frequência padrão do Opus
                    .on('end', () => {
                        resolve();
                    })
                    .on('error', (err) => {
                        reject(err);
                    })
                    .save(tempOutputPath);
            });
            
            // Ler arquivo OGG convertido
            const oggBuffer = readFileSync(tempOutputPath);
            const compressedSize = oggBuffer.byteLength;
            
            // Converter para base64
            const oggBase64 = oggBuffer.toString('base64');
            
            // Gerar nome do arquivo OGG
            const nomeArquivo = `audio_${Date.now()}.ogg`;
            
            return {
                base64: oggBase64,
                nomeArquivo: nomeArquivo,
                tipoMime: 'audio/ogg; codecs=opus',
                originalSize: originalSize,
                compressedSize: compressedSize
            };
            
        } finally {
            // Limpar arquivos temporários
            try {
                if (existsSync(tempInputPath)) {
                    unlinkSync(tempInputPath);
                }
            } catch (err) {
                // Ignorar erro ao remover arquivo temporário
            }
            
            try {
                if (existsSync(tempOutputPath)) {
                    unlinkSync(tempOutputPath);
                }
            } catch (err) {
                // Ignorar erro ao remover arquivo temporário
            }
        }
        
    } catch (error) {
        throw new Error(`Erro ao converter áudio para OGG Opus: ${error.message}`);
    }
}

/**
 * Comprime áudio reduzindo bitrate progressivamente até atingir tamanho máximo
 * @param {string} audioBase64 - Áudio em base64
 * @param {string} formatoOriginal - Formato original do áudio
 * @param {number} maxSizeBytes - Tamanho máximo desejado em bytes
 * @returns {Promise<{base64: string, nomeArquivo: string, tipoMime: string, originalSize: number, compressedSize: number, compressed: boolean}>}
 */
export async function comprimirAudio(audioBase64, formatoOriginal = 'webm', maxSizeBytes = 2 * 1024 * 1024) {
    try {
        // Remover prefixo data:audio/...;base64, se existir
        const base64Data = audioBase64.includes(',') 
            ? audioBase64.split(',')[1] 
            : audioBase64;
        
        // Converter base64 para buffer para verificar tamanho original
        const audioBuffer = Buffer.from(base64Data, 'base64');
        const originalSize = audioBuffer.byteLength;
        
        // Se já está abaixo do limite, retorna sem comprimir
        if (originalSize <= maxSizeBytes) {
            const resultado = await converterAudioParaOGG(audioBase64, formatoOriginal, 64);
            return {
                ...resultado,
                compressed: false
            };
        }
        
        displayLog(`[AudioCompressor] Áudio original: ${(originalSize / 1024 / 1024).toFixed(2)}MB, comprimindo para máximo ${(maxSizeBytes / 1024).toFixed(2)}KB...`);
        
        // Bitrates progressivos para tentar (em kbps) - mais agressivos para áudios grandes
        // Bitrates muito baixos (8-12kbps) podem ser usados para áudios muito grandes
        const bitrates = [64, 48, 32, 24, 16, 12, 8];
        let lastSize = originalSize;
        let bestResult = null;
        let tentativasSemReducao = 0;
        
        for (let i = 0; i < bitrates.length; i++) {
            const bitrate = bitrates[i];
            displayLog(`[AudioCompressor] Tentativa ${i + 1}: Bitrate ${bitrate}kbps...`);
            
            try {
                const resultado = await converterAudioParaOGG(audioBase64, formatoOriginal, bitrate);
                
                // Se conseguiu comprimir abaixo do limite, retorna
                if (resultado.compressedSize <= maxSizeBytes) {
                    displayLog(`[AudioCompressor] ✅ Compressão bem-sucedida: ${(resultado.compressedSize / 1024).toFixed(2)}KB (bitrate: ${bitrate}kbps)`);
                    return {
                        ...resultado,
                        compressed: true
                    };
                }
                
                // Se não conseguiu, mas reduziu o tamanho, salva como melhor resultado
                if (resultado.compressedSize < lastSize) {
                    bestResult = {
                        ...resultado,
                        compressed: true
                    };
                    lastSize = resultado.compressedSize;
                    tentativasSemReducao = 0; // Reset contador
                } else {
                    tentativasSemReducao++;
                }
                
                // Só para se não reduziu nada em 2 tentativas consecutivas
                // Isso permite tentar bitrates mais baixos mesmo com reduções pequenas
                if (tentativasSemReducao >= 2) {
                    displayLog(`[AudioCompressor] Compressão não está reduzindo mais após ${tentativasSemReducao} tentativas, usando melhor resultado...`);
                    break;
                }
                
            } catch (error) {
                displayWarn(`[AudioCompressor] Erro ao comprimir com bitrate ${bitrate}kbps: ${error.message}`);
                tentativasSemReducao++;
                // Continua para próximo bitrate
            }
        }
        
        // Se conseguiu algum resultado, retorna o melhor
        if (bestResult) {
            displayLog(`[AudioCompressor] ⚠️ Não conseguiu atingir o limite, mas comprimiu para ${(bestResult.compressedSize / 1024).toFixed(2)}KB`);
            return bestResult;
        }
        
        // Se não conseguiu comprimir, retorna conversão padrão
        displayWarn(`[AudioCompressor] Não conseguiu comprimir, usando conversão padrão...`);
        const resultado = await converterAudioParaOGG(audioBase64, formatoOriginal, 64);
        return {
            ...resultado,
            compressed: false
        };
        
    } catch (error) {
        displayError(`[AudioCompressor] Erro ao comprimir áudio: ${error.message}`);
        // Em caso de erro, tenta conversão padrão
        try {
            const resultado = await converterAudioParaOGG(audioBase64, formatoOriginal, 64);
            return {
                ...resultado,
                compressed: false,
                error: error.message
            };
        } catch (err) {
            throw new Error(`Erro ao comprimir áudio: ${error.message}`);
        }
    }
}
