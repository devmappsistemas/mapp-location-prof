/**
 * Array global para armazenar mensagens
 * Estrutura: { [idNumeroSincronizado]: { [idAgentePedir]: { mensagens: [] } } }
 */
const arrayMensagens = {};

/**
 * Map para armazenar timeouts ativos
 */
const timeouts = new Map();

/**
 * Adiciona mensagem ao array e renova timeout de 30 segundos
 * @param {number|string} idNumeroSincronizado 
 * @param {number|string} idAgentePedir 
 * @param {Object} mensagem 
 * @param {Function} callback - Função chamada após 30s sem novas mensagens
 * @param {number} time - Tempo em ms até disparar o callback
 * @param {number|null} idMensagem - ID da mensagem salva (agente_conversas_mensagens)
 */
export function adicionarMensagem(idNumeroSincronizado, idAgentePedir, mensagem, callback, time, idMensagem) {
    const chaveNumero = String(idNumeroSincronizado);
    const chaveAgente = String(idAgentePedir);
    const chaveTimeout = `${chaveNumero}_${chaveAgente}`;

    // Inicializa estrutura se não existir
    if (!arrayMensagens[chaveNumero]) {
        arrayMensagens[chaveNumero] = {};
    }
    if (!arrayMensagens[chaveNumero][chaveAgente]) {
        arrayMensagens[chaveNumero][chaveAgente] = {
            mensagens: []
        };
    }

    // Adiciona mensagem ao array (com id da mensagem salva)
    arrayMensagens[chaveNumero][chaveAgente].mensagens.push({ mensagem, id: idMensagem ?? null });

    // Cancela timeout anterior se existir
    if (timeouts.has(chaveTimeout)) {
        clearTimeout(timeouts.get(chaveTimeout));
    }

    // Cria novo timeout de 30 segundos
    const timeoutId = setTimeout(() => {
        timeouts.delete(chaveTimeout);
        
        // Pega mensagens e limpa
        const mensagens = [...arrayMensagens[chaveNumero][chaveAgente].mensagens];
        arrayMensagens[chaveNumero][chaveAgente].mensagens = [];
        
        // Remove estruturas vazias
        if (arrayMensagens[chaveNumero][chaveAgente].mensagens.length === 0) {
            delete arrayMensagens[chaveNumero][chaveAgente];
        }
        if (Object.keys(arrayMensagens[chaveNumero]).length === 0) {
            delete arrayMensagens[chaveNumero];
        }

        // Chama callback
        if (callback) {
            callback(mensagens);
        }
    }, time);

    timeouts.set(chaveTimeout, timeoutId);
}
