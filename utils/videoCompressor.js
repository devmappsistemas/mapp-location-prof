import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { log as displayLog, warn as displayWarn, error as displayError } from './displayLogWebhook.js';

// Configurar caminho do ffmpeg e ffprobe (binários instalados via npm)
ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

/**
 * Obtém metadados do vídeo (duração, largura, altura) via ffprobe
 * @param {string} filePath - Caminho do arquivo de vídeo
 * @returns {Promise<{duration: number, width?: number, height?: number, avgFrameRate?: string, rFrameRate?: string}>}
 */
function getVideoMetadata(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const format = metadata.format || {};
            const videoStream = (metadata.streams || []).find(s => s.codec_type === 'video');
            resolve({
                duration: parseFloat(format.duration) || 1,
                width: videoStream?.width,
                height: videoStream?.height,
                avgFrameRate: videoStream?.avg_frame_rate,
                rFrameRate: videoStream?.r_frame_rate
            });
        });
    });
}

function parseFrameRate(frameRateValue) {
    const raw = String(frameRateValue || '').trim();
    if (!raw) return null;
    if (raw.includes('/')) {
        const [n, d] = raw.split('/');
        const num = Number(n);
        const den = Number(d);
        if (num > 0 && den > 0) return num / den;
        return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function calcularQualidadeMinimaDinamica({ requestedMinQuality, width, height, fps }) {
    const qualidadeSolicitada = Math.max(1, Math.min(100, Number(requestedMinQuality ?? 90)));
    const eh4kOuMais = (width >= 3840) || (height >= 2160);
    const eh60fpsOuMais = (fps || 0) >= 59.5;
    const ehAltaResolucao = (width >= 2560) || (height >= 1440);
    const ehFpsAlto = (fps || 0) >= 45;

    if (eh4kOuMais || eh60fpsOuMais) {
        return Math.min(qualidadeSolicitada, 75);
    }
    if (ehAltaResolucao || ehFpsAlto) {
        return Math.min(qualidadeSolicitada, 85);
    }
    return qualidadeSolicitada;
}

/**
 * Comprime vídeo para caber no tamanho máximo, preservando qualidade mínima.
 * @param {Buffer|string} videoInput - Vídeo em Buffer ou base64 (com/sem prefixo data:)
 * @param {string} formatoOriginal - Extensão original (ex: 'mp4', 'webm', 'mov')
 * @param {number} maxSizeBytes - Tamanho máximo em bytes
 * @param {{strictMaxSize?: boolean, minQualityPercent?: number}} options - Opções de compressão
 * @returns {Promise<{base64: string, buffer: Buffer, nomeArquivo: string, tipoMime: string, originalSize: number, compressedSize: number, compressed: boolean}>}
 */
export async function comprimirVideo(videoInput, formatoOriginal = 'mp4', maxSizeBytes = 2 * 1024 * 1024, options = {}) {
    const strictMaxSize = options?.strictMaxSize === true;
    const minQualityPercent = Math.max(1, Math.min(100, Number(options?.minQualityPercent ?? 90)));
    const onProgress = typeof options?.onProgress === 'function' ? options.onProgress : null;
    const hardMaxSizeBytes = Number(options?.hardMaxSizeBytes || 0) > 0
        ? Number(options.hardMaxSizeBytes)
        : null;

    let videoBuffer;
    if (Buffer.isBuffer(videoInput)) {
        videoBuffer = videoInput;
    } else {
        const base64Data = String(videoInput || '').includes(',') ? String(videoInput).split(',')[1] : String(videoInput || '');
        videoBuffer = Buffer.from(base64Data, 'base64');
    }
    const originalSize = videoBuffer.byteLength;

    if (originalSize <= maxSizeBytes) {
        displayLog(`[VideoCompressor] Vídeo já dentro do limite (${(originalSize / 1024 / 1024).toFixed(2)}MB), sem compressão`);
        const originalBase64 = videoBuffer.toString('base64');
        return {
            base64: originalBase64,
            buffer: videoBuffer,
            nomeArquivo: `video_${Date.now()}.mp4`,
            tipoMime: 'video/mp4',
            originalSize,
            compressedSize: originalSize,
            compressed: false
        };
    }

    const ext = (formatoOriginal || 'mp4').toString().split('.').pop() || 'mp4';
    const tempInputPath = join(tmpdir(), `video_in_${Date.now()}.${ext}`);
    const tempOutputPath = join(tmpdir(), `video_out_${Date.now()}.mp4`);

    const cleanup = () => {
        try { if (existsSync(tempInputPath)) unlinkSync(tempInputPath); } catch (_) {}
        try { if (existsSync(tempOutputPath)) unlinkSync(tempOutputPath); } catch (_) {}
    };

    try {
        writeFileSync(tempInputPath, videoBuffer);
        const meta = await getVideoMetadata(tempInputPath);
        const durationSec = Math.max(0.5, meta.duration);
        const width = meta.width || 1280;
        const height = meta.height || 720;
        const fps = parseFrameRate(meta?.avgFrameRate || meta?.rFrameRate || null);
        const minQualityDynamic = calcularQualidadeMinimaDinamica({
            requestedMinQuality: minQualityPercent,
            width,
            height,
            fps
        });

        // Margem mais conservadora para reduzir chance de estourar o alvo já na 1ª tentativa.
        // Isso aumenta a probabilidade de o primeiro encode cair dentro do limite final.
        const targetTotalKbps = ((maxSizeBytes * 0.84 * 8) / durationSec) / 1000;
        const audioKbps = 96;
        const videoKbpsTarget = Math.max(100, Math.floor(targetTotalKbps - audioKbps));

        const originalTotalKbps = ((originalSize * 8) / durationSec) / 1000;
        const originalVideoKbpsEstimate = Math.max(120, Math.floor(originalTotalKbps - audioKbps));
        const minVideoKbpsByQuality = Math.max(100, Math.floor(originalVideoKbpsEstimate * (minQualityDynamic / 100)));
        const videoKbps = Math.max(videoKbpsTarget, minVideoKbpsByQuality);
        const vKbps = videoKbps;
        const maxrate = Math.min(2500, Math.ceil(vKbps * 1.05));
        const bufsize = Math.min(5000, Math.ceil(vKbps * 1.2));
        let ultimoPercentualLogado = -10;
        const tentativa = 1;

        displayLog(`[VideoCompressor] Vídeo original: ${(originalSize / 1024 / 1024).toFixed(2)}MB, duração: ${durationSec.toFixed(1)}s, alvo ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB, qualidade dinâmica ${minQualityDynamic}% (solicitada ${minQualityPercent}%), resolução ${width}x${height}${fps ? `, ${fps.toFixed(2)}fps` : ''}`);

        const outputOptions = [
            '-c:v libx264',
            '-preset fast',
            '-profile:v main',
            `-b:v ${vKbps}k`,
            `-maxrate ${maxrate}k`,
            `-bufsize ${bufsize}k`,
            '-c:a aac',
            `-b:a ${audioKbps}k`,
            '-movflags +faststart',
            '-y'
        ];

        try {
            await new Promise((resolve, reject) => {
                ffmpeg(tempInputPath)
                    .outputOptions(outputOptions)
                    .on('progress', (progressInfo = {}) => {
                        if (!onProgress) return;
                        const timemark = String(progressInfo.timemark || '0:00:00.00');
                        let segundosProcessados = 0;
                        const partes = timemark.split(':');
                        if (partes.length === 3) {
                            const h = Number(partes[0]) || 0;
                            const m = Number(partes[1]) || 0;
                            const s = Number(partes[2]) || 0;
                            segundosProcessados = (h * 3600) + (m * 60) + s;
                        }
                        const percentualCalculado = Math.max(0, Math.min(100, (segundosProcessados / durationSec) * 100));
                        const percentualInteiro = Math.floor(percentualCalculado);
                        if (percentualInteiro >= (ultimoPercentualLogado + 10) || percentualInteiro >= 99) {
                            ultimoPercentualLogado = percentualInteiro;
                            displayLog(`[VideoCompressor] Progresso tentativa ${tentativa}: ${percentualInteiro}% (${timemark}/${durationSec.toFixed(1)}s)`);
                        }
                        onProgress({
                            attempt: tentativa,
                            percent: Number(percentualCalculado.toFixed(2)),
                            timemark,
                            durationSec
                        });
                    })
                    .on('end', resolve)
                    .on('error', reject)
                    .save(tempOutputPath);
            });
        } catch (err) {
            cleanup();
            throw new Error(`Tentativa ${tentativa} (${vKbps}k): ${err.message}`);
        }

        const outBuffer = readFileSync(tempOutputPath);
        const compressedSize = outBuffer.byteLength;
        cleanup();

        if (compressedSize <= maxSizeBytes) {
            const base64Out = outBuffer.toString('base64');
            displayLog(`[VideoCompressor] ✅ Comprimido: ${(originalSize / 1024 / 1024).toFixed(2)}MB → ${(compressedSize / 1024 / 1024).toFixed(2)}MB (bitrate vídeo: ${vKbps}k)`);
            return {
                base64: base64Out,
                buffer: outBuffer,
                nomeArquivo: `video_${Date.now()}.mp4`,
                tipoMime: 'video/mp4',
                originalSize,
                compressedSize,
                compressed: true
            };
        }

        if (hardMaxSizeBytes && compressedSize >= hardMaxSizeBytes) {
            throw new Error(`Vídeo muito grande mesmo após compressão. Tamanho final: ${(compressedSize / 1024 / 1024).toFixed(2)}MB. Limite de corte: ${(hardMaxSizeBytes / 1024 / 1024).toFixed(2)}MB`);
        }

        if (strictMaxSize) {
            displayWarn(`[VideoCompressor] ⚠️ Tentativa única ficou acima do alvo de ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB, mas dentro do corte. Mantendo comprimido: ${(compressedSize / 1024 / 1024).toFixed(2)}MB`);
        }

        displayWarn(`[VideoCompressor] ⚠️ Tentativa única não atingiu alvo; enviando comprimido: ${(compressedSize / 1024 / 1024).toFixed(2)}MB`);
        return {
            base64: outBuffer.toString('base64'),
            buffer: outBuffer,
            nomeArquivo: `video_${Date.now()}.mp4`,
            tipoMime: 'video/mp4',
            originalSize,
            compressedSize,
            compressed: true
        };
    } catch (err) {
        cleanup();
        displayError(`[VideoCompressor] Erro: ${err.message}`);
        throw new Error(`Erro ao comprimir vídeo: ${err.message}`);
    }
}
