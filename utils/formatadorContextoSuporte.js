

/**
 * Formata o contexto de mensagens de suporte para envio ao agente.
 * OPÇÃO 1: quando só o suporte enviou mensagens (origem somente E).
 * OPÇÃO 2: quando houve diálogo entre suporte e cliente (existe origem U).
 *
 * @param {Array<{origem: string, mensagem: string}>} mensagensSuporte - Array retornado por buscarMensagensSuporte
 * @param {string} ultimaMensagemCliente - Texto puro da última mensagem do cliente
 * @returns {string} Texto formatado pronto para processarMensagem
 */
export function formatarContextoMensagensSuporte(mensagensSuporte, ultimaMensagemCliente) {
    // Excluir mensagens do tipo contacts e reaction — não enviar para a IA
    const filtradas = (mensagensSuporte || [])
        .filter((msg) => (msg.type || msg.tipo) !== 'contacts' && (msg.type || msg.tipo) !== 'reaction')
        .filter(
            (msg) => msg.mensagem != null && String(msg.mensagem).trim() !== ''
        );

    const blocoUltimaMsg = `Última mensagem do cliente:\n"${String(ultimaMensagemCliente ?? '').trim()}"`;
    const instrucao1 =
        'INSTRUÇÃO: Responda normalmente o cliente a partir da última mensagem, considerando o contexto acima.';
    const instrucao2 =
        'INSTRUÇÃO: Continue o atendimento normalmente, respondendo apenas a última mensagem do cliente e levando em conta o histórico acima.';

    const origensUnicas = [...new Set(filtradas.map((m) => String(m.origem || '').trim()))].filter(Boolean);
    const somenteSuporte = origensUnicas.length === 1 && origensUnicas[0] === 'E';
    const semAtendenteHumano = !origensUnicas.includes('E');

    if (semAtendenteHumano) {
        return String(ultimaMensagemCliente ?? '').trim();
    }

    if (filtradas.length === 0) {
        return [
            'Agora o cliente voltou a falar com o agente.',
            '',
            blocoUltimaMsg,
            '',
            instrucao1
        ].join('\n');
    }

    

    if (somenteSuporte) {
        // OPÇÃO 1: apenas atendente humano enviou mensagens
        const listaMensagens = filtradas
            .map((m) => String(m.mensagem).trim())
            .join(',\n');
        return [
            'Durante a conversa, um atendente humano enviou mensagens diretamente ao cliente.',
            '',
            'Mensagens enviadas pelo atendente humano:',
            listaMensagens + ',',
            '',
            'Agora o cliente voltou a falar com o agente.',
            '',
            blocoUltimaMsg,
            '',
            instrucao1
        ].join('\n');
    }

    // OPÇÃO 2: diálogo entre suporte e cliente — ordem segue o banco, ex.: atendente humano / Cliente / atendente humano / ...
    const rotulo = (origem) => {
        const o = String(origem || '').trim();
        if (o === 'E') return 'atendente humano';
        if (o === 'U') return 'Cliente';
        return 'Outro';
    };
    const linhas = filtradas.map(
        (msg) => `${rotulo(msg.origem)}: ${String(msg.mensagem).trim()}`
    );
    return [
        'O cliente conversou diretamente com um atendente humano.',
        '',
        'Trecho da conversa (mensagens do atendente humano e do cliente):',
        '',
        linhas.join('\n'),
        '',
        'Fim do trecho humano.',
        '',
        'Agora o cliente voltou para o agente.',
        '',
        'Última mensagem atual do cliente:',
        `"${String(ultimaMensagemCliente ?? '').trim()}"`,
        '',
        instrucao2
    ].join('\n');
}
