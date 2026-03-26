import OpenAI from 'openai';
import { Readable } from 'stream';
import { error as displayError } from './displayLogWebhook.js';

/**
 * Cliente OpenAI configurado
 * Requer variável de ambiente OPENAI_API_KEY
 */
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Transcreve um áudio usando a API da OpenAI
 * @param {string} audioUrl - URL do arquivo de áudio
 * @param {string} audioBase64 - Base64 do áudio (alternativa à URL)
 * @returns {Promise<string>} Texto transcrito do áudio
 */
export async function transcreverAudio(audioUrl, audioBase64 = null) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    let audioFile;
    
    // Se tiver base64, converter para buffer
    if (audioBase64) {
      // Remove o prefixo data:audio/...;base64, se existir
      const base64Data = audioBase64.includes(',') 
        ? audioBase64.split(',')[1] 
        : audioBase64;
      
      audioFile = Buffer.from(base64Data, 'base64');
    } else if (audioUrl) {
      // Se tiver URL, fazer download do arquivo
      const response = await fetch(audioUrl);
      if (!response.ok) {
        throw new Error(`Erro ao baixar áudio: ${response.statusText}`);
      }
      audioFile = await response.arrayBuffer();
      audioFile = Buffer.from(audioFile);
    } else {
      throw new Error('É necessário fornecer audioUrl ou audioBase64');
    }

    // Criar um File object para a API da OpenAI
    // No Node.js 18+, File está disponível globalmente
    // Se não estiver disponível, usar ReadableStream como fallback
    let file;
    if (typeof File !== 'undefined') {
      file = new File([audioFile], 'audio.mp3', { type: 'audio/mpeg' });
    } else {
      // Fallback: criar um ReadableStream a partir do Buffer
      file = Readable.from(audioFile);
    }

    // Transcrever usando Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: file,
      model: 'whisper-1',
      language: 'pt' // Português
    });

    return transcription.text || '';
  } catch (error) {
    displayError('[OpenAI] Erro ao transcrever áudio:', error.message);
    throw error;
  }
}

/**
 * Descreve uma imagem usando GPT-4 Vision
 * @param {string} imageUrl - URL da imagem
 * @param {string} imageBase64 - Base64 da imagem (alternativa à URL)
 * @returns {Promise<string>} Descrição completa da imagem
 */
export async function extrairTextoImagem(imageUrl, imageBase64 = null) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY não configurada');
    }

    let imageContent;
    
    // Se tiver base64, usar diretamente
    if (imageBase64) {
      // Remove o prefixo data:image/...;base64, se existir
      const base64Data = imageBase64.includes(',') 
        ? imageBase64.split(',')[1] 
        : imageBase64;
      
      imageContent = {
        type: 'image_url',
        image_url: {
          url: `data:image/jpeg;base64,${base64Data}`
        }
      };
    } else if (imageUrl) {
      imageContent = {
        type: 'image_url',
        image_url: {
          url: imageUrl
        }
      };
    } else {
      throw new Error('É necessário fornecer imageUrl ou imageBase64');
    }

    // Usar GPT-4 Vision para descrever a imagem
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Descreva esta imagem em detalhes em português. Seja específico sobre o que você vê, incluindo objetos, pessoas, texto visível, cores, ações, contexto e qualquer informação relevante presente na imagem.'
            },
            imageContent
          ]
        }
      ],
      max_tokens: 1000
    });

    return response.choices[0]?.message?.content || '';
  } catch (error) {
    displayError('[OpenAI] Erro ao extrair texto da imagem:', error.message);
    throw error;
  }
}
