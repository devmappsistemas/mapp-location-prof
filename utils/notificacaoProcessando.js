/**
 * Controle centralizado da notificação "agente processando" por par (idNumeroSincronizado, idAgentePedir).
 * Evita duplicar o evento AGENTE_PROCESSANDO no Socket e permite remover o registro após o processamento.
 */
import SocketController from '../socket/SocketController.js';
import { error as displayError } from './displayLogWebhook.js';

/** Set para evitar duplicar evento "agente processando" por par (idNumeroSincronizado, idAgentePedir) */
const notificacaoProcessandoPorBuffer = new Set();

/**
 * Monta a chave interna do par.
 * @param {number|string} idNumeroSincronizado
 * @param {number|string} idAgentePedir
 * @returns {string}
 */
function chave(idNumeroSincronizado, idAgentePedir) {
    return `${String(idNumeroSincronizado)}_${String(idAgentePedir)}`;
}

/**
 * Notifica "agente processando" uma vez por par (idNumeroSincronizado, idAgentePedir).
 * Se o par já estiver registrado, não envia de novo. Retorna uma função remover() para limpar depois.
 *
 * @param {number|string} idNumeroSincronizado - ID do número sincronizado
 * @param {number|string} idAgentePedir - ID do agente pedir
 * @param {Object} webhookBody - Body do webhook do WhatsApp (para SocketController.notificarAgenteProcessando)
 * @returns {{ alreadyNotified: boolean, remover: () => void }}
 */
export function notificarProcessando(idNumeroSincronizado, idAgentePedir, webhookBody = {}) {
    const key = chave(idNumeroSincronizado, idAgentePedir);
    const alreadyNotified = notificacaoProcessandoPorBuffer.has(key);

    if (!alreadyNotified) {
        try {
            SocketController.notificarAgenteProcessando(idAgentePedir, webhookBody);
            notificacaoProcessandoPorBuffer.add(key);
        } catch (err) {
            displayError('[notificacaoProcessando] Erro ao notificar agente processando:', err?.message);
        }
    }

    return {
        alreadyNotified,
        remover: () => removerNotificacaoProcessando(idNumeroSincronizado, idAgentePedir)
    };
}

/**
 * Remove o registro de "agente processando" do par, permitindo que a próxima mensagem dispare a notificação de novo.
 *
 * @param {number|string} idNumeroSincronizado - ID do número sincronizado
 * @param {number|string} idAgentePedir - ID do agente pedir
 */
export function removerNotificacaoProcessando(idNumeroSincronizado, idAgentePedir) {
    notificacaoProcessandoPorBuffer.delete(chave(idNumeroSincronizado, idAgentePedir));
}
