/**
 * Formata uma linha no padrão de texto de suporte WhatsApp: "<identificador>:\n<mensagem>"
 *
 * @param {string} identificador - Ex.: "Cliente", "atendente humano"
 * @param {string} mensagem - Texto da mensagem
 * @returns {string} "<identificador>:\n<mensagem>" (valores trimados)
 */
export function formatarMensagemWhatsApp(identificador, mensagem) {
    let id = String(identificador ?? '').trim();
    if (id.includes('Logado Mapp:')) {
        id = id.replace(/Logado Mapp:\s*/gi, '').trim();
    }
    const msg = String(mensagem ?? '').trim();
    return `${id}:\n${msg}`;
}
