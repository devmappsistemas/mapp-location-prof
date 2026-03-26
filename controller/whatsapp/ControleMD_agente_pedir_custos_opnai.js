import { Entidade } from "../../db/Entidade.js";
import { error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * ControleMD_agente_pedir_custos_opnai
 * Responsável por calcular e debitar créditos do usuário baseado em tokens utilizados
 */
export class ControleMD_agente_pedir_custos_opnai {
    /**
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        // Usa sempre a conexão MD (MD_CLMAPP)
        this.entidade.setConnection('md');
    }

    /**
     * Calcula tokens e custos, e debita créditos do usuário em uma única operação transacional
     * 
     * @param {string} mensagem - Mensagem enviada pelo usuário
     * @param {string|Array} respostaAgente - Resposta do agente (pode ser string ou array JSON)
     * @param {number|string} idTelConectado - ID do telefone conectado
     * @param {number|string} idConfig - ID da configuração
     * @param {number|string} idAgentePedir - ID do agente pedir
     * @param {number} custoAudio - Custo adicional do áudio (opcional, padrão 0)
     * @returns {Promise<Object>} Objeto com dados de cálculo (totalTokens, custoTotal, valorFinalMappReal) e débito (saldo_antes, saldo_depois, idSaldoCliente, idCustoInserido)
     */
    async calcularCustos(mensagem, respostaAgente, idTelConectado, idConfig, idAgentePedir, custoAudio = 0) {
        try {
            // Validações básicas
            if (!mensagem || typeof mensagem !== 'string') {
                throw new Error('mensagem é obrigatória e deve ser uma string');
            }

            if (!idTelConectado || idTelConectado === '') {
                throw new Error('idTelConectado é obrigatório');
            }

            if (!idConfig || idConfig === '') {
                throw new Error('idConfig é obrigatório');
            }

            if (!idAgentePedir || idAgentePedir === '') {
                throw new Error('idAgentePedir é obrigatório');
            }

            // Valida se custoAudio é número válido
            const custoAudioNumero = Number(custoAudio);
            if (isNaN(custoAudioNumero)) {
                custoAudio = 0.00;
            } else {
                custoAudio = custoAudioNumero;
            }

            // Constantes de cálculo
            const valorToken = 0.00024; // centavos por cada token
            const percentualMapp = 30; // margem de lucro Mapp (30%)
            const IDENTIFICADOR_AUDIO = 'Usuário enviou este audio';

            // Função de estimativa de tokens
            const estimateTokens = (text) => {
                if (!text || typeof text !== "string") return 0;
                return Math.ceil(text.length / 4);
            };

            // Valida se é áudio
            const msg = mensagem.trim();
            const isAudio = typeof msg === 'string' &&
                msg.toLowerCase().startsWith(IDENTIFICADOR_AUDIO.toLowerCase());

            // ================================
            // Processa resposta do agente
            // (pode vir como string de array JSON ou string simples)
            // ================================
            let respostaTexto = "";

            try {
                if (typeof respostaAgente === 'string' && respostaAgente.trim() !== '') {
                    // Tenta fazer parse se for JSON
                    const parsed = JSON.parse(respostaAgente);
                    if (Array.isArray(parsed)) {
                        respostaTexto = parsed.join(" ");
                    } else {
                        respostaTexto = String(parsed);
                    }
                } else if (Array.isArray(respostaAgente)) {
                    respostaTexto = respostaAgente.join(" ");
                } else {
                    respostaTexto = String(respostaAgente ?? "");
                }
            } catch {
                // Se não conseguir fazer parse, usa como string simples
                respostaTexto = String(respostaAgente ?? "");
            }

            // ================================
            // Cálculo dos tokens
            // ================================
            const tokensMensagem = estimateTokens(mensagem);
            const tokensResposta = estimateTokens(respostaTexto);

            // Soma base
            let totalTokens = tokensMensagem + tokensResposta;

            // 🔊 Se for áudio, cobra em dobro
            if (isAudio) {
                totalTokens = totalTokens * 2;
            }

            // Custo final
            const custoTotal = (totalTokens + custoAudio) * valorToken;
            // IMPORTANTE: Arredonda para 2 casas decimais desde o início (mesmo formato da coluna DECIMAL(10,2))
            const valorFinalMappReal = parseFloat((custoTotal * (percentualMapp / 100)).toFixed(2));

            // ================================
            // Transação SQL para debitar créditos
            // ================================
            const connection = await this.db.dbMD.getConnection();
            
            try {
                // Inicia transação
                await connection.beginTransaction();

                // Garante que idConfig seja tratado como número se necessário
                const idConfigNum = typeof idConfig === 'string' ? parseInt(idConfig) : idConfig;

                // 1) Buscar o saldo atual e o id, travando a linha
                const [saldoRows] = await connection.query(
                    `SELECT 
                        id,
                        saldo_atual
                    FROM agente_saldos_clientes
                    WHERE idConfig = ?
                    FOR UPDATE`,
                    [idConfigNum]
                );

                if (!saldoRows || saldoRows.length === 0) {
                    await connection.rollback();
                    throw new Error(`Saldo não encontrado para idConfig: ${idConfig}`);
                }

                const idSaldoCliente = saldoRows[0].id;
                const saldo_antes = parseFloat(saldoRows[0].saldo_atual) || 0;
                // valorFinalMappReal já está arredondado para 2 casas decimais
                const valor_debito = valorFinalMappReal;
                // Calcula o saldo depois (já com 2 casas decimais)
                const saldo_depois = parseFloat((saldo_antes - valor_debito).toFixed(2));

                // (Opcional) Validar saldo não negativo
                // Se você quiser bloquear saldo negativo, descomente:
                // if (saldo_depois < 0) {
                //     await connection.rollback();
                //     throw new Error('Saldo insuficiente');
                // }

                // 2) Atualizar o saldo
                // Como valor_debito já está com 2 casas decimais, podemos usar o valor direto
                const [updateResult] = await connection.query(
                    `UPDATE agente_saldos_clientes
                    SET 
                        saldo_atual = ?,
                        atualizado_em_time = UNIX_TIMESTAMP(),
                        atualizado_em = NOW()
                    WHERE id = ?`,
                    [saldo_depois, idSaldoCliente]
                );

                if (updateResult.affectedRows === 0) {
                    await connection.rollback();
                    throw new Error(`Falha ao atualizar saldo do cliente. idSaldoCliente: ${idSaldoCliente}, valor_debito: ${valor_debito}`);
                }

                // Busca o saldo atualizado após o UPDATE (para usar no INSERT)
                const [verificacaoImediata] = await connection.query(
                    `SELECT saldo_atual FROM agente_saldos_clientes WHERE id = ?`,
                    [idSaldoCliente]
                );
                
                const saldoAposUpdate = parseFloat(verificacaoImediata[0]?.saldo_atual) || 0;
                // Atualiza saldo_depois com o valor real do banco (já arredondado para 2 casas)
                const saldo_depois_real = saldoAposUpdate;

                // 3) Inserir registro na tabela de custos usando o saldo DEPOIS (valor real do banco)
                const [insertResult] = await connection.query(
                    `INSERT INTO agente_pedir_custos_openai (
                        idSaldoCliente,
                        idConfig,
                        idTelConectado,
                        idZap,
                        time,
                        token,
                        custoReal,
                        valorFinalMappReal,
                        custoAudioDolar,
                        saldo,
                        log
                    )
                    VALUES (?, ?, ?, ?, UNIX_TIMESTAMP(), ?, ?, ?, ?, ?, ?)`,
                    [
                        idSaldoCliente,
                        idConfigNum,
                        idTelConectado,
                        idAgentePedir,
                        totalTokens || 0,
                        custoTotal || 0,
                        valorFinalMappReal,
                        custoAudio || 0,
                        saldo_depois_real, // ✅ usa o valor real do banco (já arredondado para DECIMAL(10,2))
                        'Uso de IA'
                    ]
                );

                const idCustoInserido = insertResult.insertId;

                // Commit da transação
                await connection.commit();

                // ================================
                // Retorna dados completos (cálculo + débito)
                // ================================
                return {
                    totalTokens,
                    custoTotal,
                    valorFinalMappReal,
                    idConfig,
                    idTelConectado,
                    idAgentePedir,
                    // Dados adicionais para debug/log
                    tokensMensagem,
                    tokensResposta,
                    isAudio: isAudio ? 'S' : 'N',
                    custoAudio,
                    // Dados do débito
                    saldo_antes,
                    saldo_depois: saldo_depois_real, // Valor real do banco após UPDATE
                    valor_debito,
                    idSaldoCliente,
                    idCustoInserido
                };
            } catch (error) {
                // Rollback em caso de erro na transação
                await connection.rollback();
                throw error;
            } finally {
                // Libera a conexão de volta ao pool
                connection.release();
            }
        } catch (error) {
            displayError('[ControleMD_agente_pedir_custos_opnai] Erro ao calcular custos:', {
                message: error.message,
                mensagem: mensagem?.substring(0, 50),
                idTelConectado,
                idConfig,
                idAgentePedir
            });
            displayError('[ControleMD_agente_pedir_custos_opnai] Stack:', error.stack);
            throw error;
        }
    }
}
