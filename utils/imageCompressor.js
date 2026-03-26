import sharp from 'sharp';
import { log as displayLog, error as displayError } from './displayLogWebhook.js';

/**
 * Comprime uma imagem mantendo boa qualidade visual
 * @param {Buffer} imageBuffer - Buffer da imagem original
 * @param {string} mimeType - Tipo MIME da imagem (ex: 'image/jpeg', 'image/png')
 * @param {number} maxSizeBytes - Tamanho máximo desejado em bytes (padrão: 2MB)
 * @param {number} quality - Qualidade da compressão (1-100, padrão: 85)
 * @returns {Promise<{buffer: Buffer, mimeType: string, originalSize: number, compressedSize: number, compressed: boolean}>}
 */
export async function comprimirImagem(imageBuffer, mimeType, maxSizeBytes = 2 * 1024 * 1024, quality = 85) {
    try {
        const originalSize = imageBuffer.byteLength;
        
        // Se a imagem já está abaixo do limite, retorna sem comprimir
        if (originalSize <= maxSizeBytes) {
            return {
                buffer: imageBuffer,
                mimeType: mimeType,
                originalSize: originalSize,
                compressedSize: originalSize,
                compressed: false
            };
        }

        displayLog(`[ImageCompressor] Imagem original: ${(originalSize / 1024 / 1024).toFixed(2)}MB, comprimindo para ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB...`);

        // Determina o formato de saída baseado no MIME type
        let formatoSaida = 'jpeg'; // Padrão JPEG para melhor compressão
        let extensao = 'jpg';

        if (mimeType.includes('png')) {
            formatoSaida = 'png';
            extensao = 'png';
        } else if (mimeType.includes('webp')) {
            formatoSaida = 'webp';
            extensao = 'webp';
        } else if (mimeType.includes('gif')) {
            // GIF não suporta compressão de qualidade, apenas redimensionamento
            formatoSaida = 'gif';
            extensao = 'gif';
        }

        // Cria uma instância do sharp com a imagem
        let sharpInstance = sharp(imageBuffer);

        // Obtém metadados da imagem
        const metadata = await sharpInstance.metadata();
        const width = metadata.width;
        const height = metadata.height;

        // Se a imagem for muito grande, redimensiona mantendo proporção
        // Limite de 1920px na maior dimensão para reduzir tamanho
        const maxDimension = 1920;
        if (width > maxDimension || height > maxDimension) {
            const ratio = Math.min(maxDimension / width, maxDimension / height);
            const newWidth = Math.round(width * ratio);
            const newHeight = Math.round(height * ratio);
            
            displayLog(`[ImageCompressor] Redimensionando de ${width}x${height} para ${newWidth}x${newHeight}`);
            sharpInstance = sharpInstance.resize(newWidth, newHeight, {
                fit: 'inside',
                withoutEnlargement: true
            });
        }

        // Aplica compressão baseada no formato
        let compressedBuffer;
        
        if (formatoSaida === 'jpeg') {
            // JPEG: usa qualidade ajustável
            compressedBuffer = await sharpInstance
                .jpeg({ 
                    quality: quality,
                    progressive: true,
                    mozjpeg: true // Melhor compressão
                })
                .toBuffer();
        } else if (formatoSaida === 'png') {
            // PNG: usa compressão com qualidade
            compressedBuffer = await sharpInstance
                .png({ 
                    quality: quality,
                    compressionLevel: 9 // Máxima compressão
                })
                .toBuffer();
        } else if (formatoSaida === 'webp') {
            // WebP: melhor compressão mantendo qualidade
            compressedBuffer = await sharpInstance
                .webp({ 
                    quality: quality
                })
                .toBuffer();
        } else {
            // GIF ou outros formatos: apenas redimensiona se necessário
            compressedBuffer = await sharpInstance
                .toBuffer();
        }

        // Se ainda estiver acima do limite, reduz qualidade progressivamente
        let currentQuality = quality;
        let attempts = 0;
        const maxAttempts = 12; // Mais tentativas para imagens difíceis
        let lastSize = compressedBuffer.byteLength;
        let tentouConverterParaJPEG = false; // Flag para converter PNG/WebP para JPEG se necessário
        
        while (compressedBuffer.byteLength > maxSizeBytes && attempts < maxAttempts && currentQuality > 15) {
            attempts++;
            
            // Se PNG/WebP não está comprimindo bem após 3 tentativas, converter para JPEG
            if ((formatoSaida === 'png' || formatoSaida === 'webp') && attempts > 3 && !tentouConverterParaJPEG) {
                displayLog(`[ImageCompressor] PNG/WebP não está comprimindo bem, convertendo para JPEG para melhor compressão...`);
                formatoSaida = 'jpeg';
                tentouConverterParaJPEG = true;
                currentQuality = 60; // Reset qualidade para 60% ao converter
            }
            
            // Reduz qualidade progressivamente
            if (attempts > 1) {
                currentQuality -= 5; // Reduz em passos menores (5% ao invés de 10%)
            }
            
            displayLog(`[ImageCompressor] Tentativa ${attempts}: Reduzindo qualidade para ${currentQuality}%... (tamanho atual: ${(compressedBuffer.byteLength / 1024 / 1024).toFixed(2)}MB, formato: ${formatoSaida})`);
            
            // Redimensiona mais agressivamente se necessário
            let newMaxDimension = maxDimension;
            if (attempts > 2) {
                newMaxDimension = 1600; // Reduz mais a dimensão após 2 tentativas
            }
            if (attempts > 4) {
                newMaxDimension = 1280; // Reduz mais após 4 tentativas
            }
            if (attempts > 6) {
                newMaxDimension = 1024; // Reduz ainda mais após 6 tentativas
            }
            if (attempts > 8) {
                newMaxDimension = 800; // Muito agressivo após 8 tentativas
            }
            
            const shouldResize = width > newMaxDimension || height > newMaxDimension;
            
            if (formatoSaida === 'jpeg') {
                let sharpInstance = sharp(imageBuffer);
                if (shouldResize) {
                    sharpInstance = sharpInstance.resize(newMaxDimension, newMaxDimension, { fit: 'inside', withoutEnlargement: true });
                }
                compressedBuffer = await sharpInstance
                    .jpeg({ quality: currentQuality, progressive: true, mozjpeg: true })
                    .toBuffer();
            } else if (formatoSaida === 'png') {
                let sharpInstance = sharp(imageBuffer);
                if (shouldResize) {
                    sharpInstance = sharpInstance.resize(newMaxDimension, newMaxDimension, { fit: 'inside', withoutEnlargement: true });
                }
                compressedBuffer = await sharpInstance
                    .png({ quality: currentQuality, compressionLevel: 9 })
                    .toBuffer();
            } else if (formatoSaida === 'webp') {
                let sharpInstance = sharp(imageBuffer);
                if (shouldResize) {
                    sharpInstance = sharpInstance.resize(newMaxDimension, newMaxDimension, { fit: 'inside', withoutEnlargement: true });
                }
                compressedBuffer = await sharpInstance
                    .webp({ quality: currentQuality })
                    .toBuffer();
            }
            
            // Se não houve redução significativa (menos de 3%), para para evitar loop infinito
            // Mas só para se já tentou várias vezes
            if (compressedBuffer.byteLength >= lastSize * 0.97 && attempts > 5) {
                displayLog(`[ImageCompressor] Compressão não está reduzindo mais o tamanho (redução < 3%), parando após ${attempts} tentativas...`);
                break;
            }
            lastSize = compressedBuffer.byteLength;
        }

        const compressedSize = compressedBuffer.byteLength;
        const reduction = ((originalSize - compressedSize) / originalSize * 100).toFixed(2);
        
        displayLog(`[ImageCompressor] Compressão concluída: ${(compressedSize / 1024 / 1024).toFixed(2)}MB (redução de ${reduction}%)`);
        if (tentouConverterParaJPEG) {
            displayLog(`[ImageCompressor] ⚠️ Imagem foi convertida de ${mimeType} para JPEG para melhor compressão`);
        }

        // Atualiza o MIME type se necessário (ex: PNG comprimido pode virar JPEG)
        const finalMimeType = formatoSaida === 'jpeg' ? 'image/jpeg' : 
                             formatoSaida === 'png' ? 'image/png' : 
                             formatoSaida === 'webp' ? 'image/webp' : mimeType;

        return {
            buffer: compressedBuffer,
            mimeType: finalMimeType,
            originalSize: originalSize,
            compressedSize: compressedSize,
            compressed: true,
            reduction: parseFloat(reduction)
        };

    } catch (error) {
        displayError('[ImageCompressor] Erro ao comprimir imagem:', error.message);
        // Em caso de erro, retorna a imagem original
        return {
            buffer: imageBuffer,
            mimeType: mimeType,
            originalSize: imageBuffer.byteLength,
            compressedSize: imageBuffer.byteLength,
            compressed: false,
            error: error.message
        };
    }
}
