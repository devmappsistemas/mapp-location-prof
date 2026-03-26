import { Entidade } from "../../db/Entidade.js";
import { createClient } from '@supabase/supabase-js';
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Classe Solicitante
 * Gerencia operações relacionadas a solicitantes
 */
export class Pedir {
    /**
     * Construtor da classe Solicitante
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        this.entidade.setConnection('md');

        // Configurações do Supabase (fixas - SUBSTITUA pelas suas credenciais)
        this.supabaseConfig = {
            url: 'https://tzamlllpmlemwessrdvs.supabase.co', // SUBSTITUA pela sua URL do Supabase
            key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR6YW1sbGxwbWxlbXdlc3NyZHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA2ODY1MzEsImV4cCI6MjA2NjI2MjUzMX0.2YbARF5HnNwiezeP7Brjm6cmmw5konqsAgJYbSDp4tk', // SUBSTITUA pela sua chave anon
            serviceKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR6YW1sbGxwbWxlbXdlc3NyZHZzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1MDY4NjUzMSwiZXhwIjoyMDY2MjYyNTMxfQ.AoPDFfKAD0XYG8VLlJKisGSCJpH4NWo61CVWaM7FTdQ' // SUBSTITUA pela sua service role key (opcional)
        };

        // Configuração da OpenAI para embeddings
        this.openaiApiKey = process.env.OPENAI_API_KEY;

        // Cliente Supabase (lazy initialization)
        this.supabaseClient = null;
    }

    /**
     * Obtém ou cria o cliente do Supabase
     * @returns {Object} Cliente do Supabase
     */
    getSupabaseClient() {
        if (this.supabaseClient) {
            return this.supabaseClient;
        }

        if (!this.supabaseConfig.url || !this.supabaseConfig.key) {
            throw new Error('Configurações do Supabase não definidas. Configure supabaseConfig no construtor.');
        }

        this.supabaseClient = createClient(
            this.supabaseConfig.url,
            this.supabaseConfig.serviceKey || this.supabaseConfig.key,
            {
                db: {
                    schema: 'public'
                },
                global: {
                    headers: {
                        'x-client-info': 'mapp-request'
                    }
                }
            }
        );

        return this.supabaseClient;
    }

    /**
     * Gera embedding usando OpenAI
     * @param {string} text - Texto para gerar embedding
     * @returns {Promise<Array<number>>} Array com o embedding
     */
    async gerarEmbedding(text) {
        if (!this.openaiApiKey) {
            throw new Error('OpenAI API Key não configurada');
        }

        try {
            const response = await fetch('https://api.openai.com/v1/embeddings', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'text-embedding-3-small', // ou 'text-embedding-ada-002'
                    input: text
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`Erro ao gerar embedding: ${response.status} - ${errorData}`);
            }

            const data = await response.json();
            return data.data[0].embedding;
        } catch (error) {
            displayError('Erro ao gerar embedding:', error.message);
            throw error;
        }
    }

    /**
     * Busca conversas não validadas e formata para análise
     * @param {number} idAgentePedir - ID do agente pedir
     * @returns {Promise<Array>} Array com as conversas formatadas
     */
    async buscarConversasNaoValidadas(idAgentePedir) {
        if (!idAgentePedir || idAgentePedir <= 0) {
            return [];
        }

        const sql = `
            SELECT origem, mensagem, dataHora
            FROM (
                SELECT id, origem, mensagem, dataHora
                FROM agente_conversas_mensagens
                WHERE idAgentePedir = ?
                AND validadoBase IS NULL
                ORDER BY timeData DESC
                LIMIT 5000
            ) AS ultimos
            ORDER BY id ASC
        `;
        // return sql;

        try {
            const [rows] = await this.db.dbMD.query(sql, [idAgentePedir]);
            return rows || [];
        } catch (error) {
            displayError('Erro ao buscar conversas:', error.message);
            return [];
        }
    }

    /**
     * Formata conversas para envio ao agente de IA
     * @param {Array} conversas - Array de conversas do banco
     * @returns {string} Conversa formatada
     */
    formatarConversa(conversas) {
        let conversaFormatada = '';

        for (const item of conversas) {
            let texto = item.mensagem || '';
            const origem = item.origem;
            const dataHora = item.dataHora || '';

            if (texto === '\n') {
                texto = '';
            }

            if (texto !== '') {
                if (origem === 'U' || origem === 'UB') {
                    conversaFormatada += `Usuário (${dataHora}): ${texto}\n`;
                } else {
                    if (origem === 'E') {
                        conversaFormatada += `Atendente (${dataHora}): ${texto}\n`;
                    } else {
                        conversaFormatada += `Agente (${dataHora}): ${texto}\n`;
                    }
                }
            }
        }

        return conversaFormatada;
    }

    /**
     * Chama OpenAI para extrair contexto das conversas
     * @param {string} conversa - Conversa formatada
     * @returns {Promise<Object>} Resultado da extração de contexto
     */
    async extrairContextoOpenAI(conversa) {
        const openaiApiKey = process.env.OPENAI_API_KEY;

        const systemMessage = `# Papel do Agente
Você é um agente responsável por extrair APENAS conhecimento útil de conversas de suporte, com foco exclusivo em identificar NOVO conhecimento gerado por atendentes humanos para treinar um agente de WhatsApp.

---

# Entrada
Você receberá uma conversa contendo:
- Mensagens do usuário
- Mensagens respondidas por um agente de IA
- Mensagens respondidas por um atendente humano
- Datas e horários
- Ruídos operacionais e mensagens sociais

Cada mensagem indica claramente quem enviou (usuário, agente ou atendente).

---

# Objetivo (MUITO IMPORTANTE)
Gerar contexto treinável SOMENTE quando houver resposta de ATENDENTE HUMANO.

⚠️ Respostas dadas por agente de IA devem ser totalmente desconsideradas, pois já foram geradas com base na base_conhecimento_geral existente.

---

# Regra principal de extração (OBRIGATÓRIA)
- Se uma pergunta do usuário foi respondida APENAS por agente de IA → NÃO gerar contexto.
- Se uma pergunta do usuário foi respondida por ATENDENTE HUMANO → gerar contexto.
- Sempre manter no contexto:
  - O que o usuário perguntou ou relatou
  - O que o atendente humano respondeu

---

# O que DEVE ser considerado conhecimento útil
Inclua apenas quando a resposta do atendente humano contiver:
- Explicações novas
- Procedimentos não documentados
- Limitações ou exceções não cobertas pela base
- Correções, ajustes ou comportamentos do sistema
- Orientações práticas usadas no suporte

---

# O que DEVE ser IGNORADO
Descartar obrigatoriamente:
- Respostas do agente de IA
- Cumprimentos e mensagens sociais
- Status ou número de tickets
- Confirmações administrativas
- Avaliações de atendimento
- Mensagens sem conteúdo técnico

---

# Como analisar a conversa
1) Identifique perguntas ou relatos do usuário.
2) Verifique quem respondeu cada pergunta:
   - Agente de IA → ignorar resposta
   - Atendente humano → analisar resposta
3) Quando houver resposta humana:
   - Extraia o problema relatado pelo usuário
   - Extraia a intenção real do usuário
   - Extraia a resposta/orientação do atendente humano
4) Consolide mensagens relacionadas ao mesmo tema.

---

# Regra de data/hora
Use data/hora SOMENTE quando estiver relacionada a:
- Correção de erro
- Ajuste técnico
- Bug resolvido
- Mudança que resolveu um problema

Sempre informar dia, mês e ano.
Nunca informar apenas dia e mês.

---

# Estrutura do campo "contexto" (OBRIGATÓRIA)
Use hashtags como hierarquia semântica:

# Assunto
## Subassunto (se houver)

Dentro de cada assunto, use rótulos claros:

**Pergunta/Relato do usuário:**  
**Resposta do atendente humano:**  
**Limitações/Regras:** (se houver)  
**Correção/Ajuste:** (somente se houver, com data)

---

# Regras de formatação
- Usar \`#\`, \`##\`, \`###\`
- Usar **negrito**
- Quebras de linha reais
- Linguagem neutra, clara e objetiva
- Sem HTML
- Sem listas com marcadores
- Não inventar informações

---

# Quando retornar status false
Retorne status false quando:
- Não houver nenhuma resposta de atendente humano
- A conversa tiver apenas respostas do agente de IA
- Não existir conhecimento novo a ser extraído

---

# Saída (OBRIGATÓRIA)
Retorne SEMPRE um JSON exatamente neste formato:

{
  "status": true | false,
  "contexto": "texto estruturado com conhecimento novo extraído de resposta humana"
}

Se status for false, o campo "contexto" deve ser uma string vazia.

---

# Restrições
- Não explique decisões
- Não faça perguntas
- Não inclua nada fora do JSON
- Não altere o formato da saída`;

        try {
            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4.1-mini',
                    messages: [
                        {
                            role: 'system',
                            content: systemMessage
                        },
                        {
                            role: 'user',
                            content: conversa
                        }
                    ],
                    temperature: 0.3,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`Erro na API OpenAI: ${response.status} - ${errorData}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;

            if (!content) {
                return {
                    status: false,
                    contexto: ''
                };
            }

            // Tenta fazer parse do JSON retornado
            try {
                const parsed = JSON.parse(content);
                return {
                    status: parsed.status || false,
                    contexto: parsed.contexto || ''
                };
            } catch (parseError) {
                // Se não conseguir fazer parse, retorna o conteúdo como contexto
                return {
                    status: true,
                    contexto: content
                };
            }
        } catch (error) {
            displayError('Erro ao chamar OpenAI:', error.message);
            throw error;
        }
    }

    /**
     * Processa a resposta do agente de IA (equivalente ao nó "Nota do atendimento" do n8n)
     * Limpa possíveis cercas de código markdown e faz parse do JSON
     * @param {string|Object} output - Resposta do agente (pode ser string ou objeto)
     * @returns {Object} Objeto parseado ou objeto vazio em caso de erro
     */
    processarRespostaAgente(output) {
        // Se não tiver output ou não for string, retorna objeto vazio
        if (!output || typeof output !== 'string') {
            return {};
        }

        try {
            // Limpa possíveis cercas de código e espaços
            const textoLimpo = output
                .replace(/^\s*```(?:json)?/i, '')
                .replace(/```\s*$/i, '')
                .trim();

            const obj = JSON.parse(textoLimpo);

            // Garante que é um objeto JSON válido
            if (typeof obj !== 'object' || Array.isArray(obj) || obj === null) {
                return {};
            }

            // Retorna SOMENTE o objeto original
            return obj;
        } catch (e) {
            // Em caso de erro, não quebra o fluxo
            return {};
        }
    }

    /**
     * Valida se o contexto não está vazio (equivalente ao nó "If1" do n8n)
     * @param {string} contexto - Contexto a ser validado
     * @returns {boolean} true se o contexto não estiver vazio, false caso contrário
     */
    validarContextoNaoVazio(contexto) {
        if (!contexto || typeof contexto !== 'string') {
            return false;
        }
        return contexto.trim() !== '';
    }

    /**
     * Prepara e atribui o contexto (equivalente ao nó "prompt5" do n8n)
     * @param {string} contexto - Contexto a ser preparado
     * @returns {Object} Objeto com o contexto preparado
     */
    prepararContexto(contexto) {
        return {
            contexto: contexto || ''
        };
    }

    /**
     * Processa o contexto extraído - orquestra os nós em sequência
     * Equivalente ao fluxo: "Nota do atendimento" → "If1" → "prompt5"
     * @param {Object|string} resultadoOpenAI - Resultado retornado pela OpenAI (pode ser objeto com 'output', objeto parseado, ou string com contexto direto)
     * @returns {Object} Objeto com status e contexto processado
     */
    processarContextoExtraido(resultadoOpenAI) {
        try {
            // Passo 1: Processar resposta do agente (nó "Nota do atendimento")
            let objetoProcessado;
            let contexto = '';

            // Se o resultado já for um objeto com 'output', processa o output
            if (resultadoOpenAI && typeof resultadoOpenAI === 'object' && resultadoOpenAI.output) {
                objetoProcessado = this.processarRespostaAgente(resultadoOpenAI.output);
                contexto = objetoProcessado.contexto || '';
            }
            // Se o resultado já for o objeto parseado (sem campo output), usa diretamente
            else if (resultadoOpenAI && typeof resultadoOpenAI === 'object') {
                objetoProcessado = resultadoOpenAI;
                contexto = objetoProcessado.contexto || '';
            }
            // Se for string, tenta processar como JSON primeiro
            else if (typeof resultadoOpenAI === 'string') {
                // Tenta processar como JSON (pode ter markdown ou não)
                objetoProcessado = this.processarRespostaAgente(resultadoOpenAI);
                contexto = objetoProcessado.contexto || '';

                // Se não conseguiu extrair contexto do JSON, trata a string como contexto direto
                if (!contexto || contexto.trim() === '') {
                    contexto = resultadoOpenAI.trim();
                    objetoProcessado = { contexto: contexto };
                }
            }
            // Caso contrário, objeto vazio
            else {
                objetoProcessado = {};
                contexto = '';
            }

            // Passo 2: Validar se contexto não está vazio (nó "If1")
            const contextoValido = this.validarContextoNaoVazio(contexto);

            // Se o contexto não for válido, retorna com status false
            if (!contextoValido) {
                return {
                    status: false,
                    contexto: '',
                    message: 'Contexto vazio ou inválido'
                };
            }

            // Passo 3: Preparar contexto (nó "prompt5")
            const contextoPreparado = this.prepararContexto(contexto);

            return {
                status: true,
                ...contextoPreparado,
                objetoProcessado: objetoProcessado
            };
        } catch (error) {
            displayError('Erro ao processar contexto extraído:', error.message);
            return {
                status: false,
                contexto: '',
                message: error.message
            };
        }
    }

    /**
     * Busca na base de conhecimento usando Supabase Vector Store
     * Equivalente ao nó "base_conhecimento_geral" do n8n
     * @param {string} query - Texto para busca semântica
     * @param {Object} options - Opções de busca (topK, metadata, etc)
     * @returns {Promise<Array>} Array com documentos encontrados
     */
    async buscarBaseConhecimentoGeralSupabase(query, options = {}) {
        displayLog('query:', query);
        
        const {
            topK = 50,
            metadata = {
                nomeTreinamento: 'Treinamento_base',
                idConfig: '386',
                contexto: 'SUPORTE'
            }
        } = options;

        const debugInfo = {
            configurado: false,
            embeddingGerado: false,
            clienteSupabase: false,
            rpcChamado: false,
            erro: null,
            dadosRetornados: null
        };

        try {
            // Verifica se as configurações do Supabase estão definidas
            if (!this.supabaseConfig.url || !this.supabaseConfig.key || this.supabaseConfig.url.includes('seu-projeto')) {
                displayWarn('Supabase não configurado. Retornando array vazio.');
                debugInfo.erro = 'Supabase não configurado';
                return { dados: [], debug: debugInfo };
            }
            debugInfo.configurado = true;

            // Gera embedding da query
            let queryEmbedding;
            try {
                queryEmbedding = await this.gerarEmbedding(query);
                debugInfo.embeddingGerado = true;
                debugInfo.tamanhoEmbedding = queryEmbedding ? queryEmbedding.length : 0;
            } catch (error) {
                debugInfo.erro = `Erro ao gerar embedding: ${error.message}`;
                displayError('Erro ao gerar embedding:', error);
                return { dados: [], debug: debugInfo };
            }

            // Obtém cliente do Supabase
            let supabase;
            try {
                supabase = this.getSupabaseClient();
                debugInfo.clienteSupabase = true;
            } catch (error) {
                debugInfo.erro = `Erro ao criar cliente Supabase: ${error.message}`;
                displayError('Erro ao criar cliente Supabase:', error);
                return { dados: [], debug: debugInfo };
            }

            // Prepara filtros de metadata
            const metadataFilter = {};
            if (metadata.nomeTreinamento) {
                metadataFilter.nomeTreinamento = metadata.nomeTreinamento;
            }
            if (metadata.idConfig) {
                metadataFilter.idConfig = metadata.idConfig;
            }
            if (metadata.contexto) {
                metadataFilter.contexto = metadata.contexto;
            }
            debugInfo.filtrosMetadata = metadataFilter;

            // Chama a função match_documents do Supabase
            // A ordem dos parâmetros no Supabase pode ser diferente
            // Tenta várias ordens possíveis
            debugInfo.rpcChamado = true;
            let data, error;
            
            // Tentativa 1: Ordem sugerida pelo erro - filter, match_count, query_embedding
            ({ data, error } = await supabase.rpc('match_documents', {
                filter: metadataFilter,
                match_count: topK,
                query_embedding: queryEmbedding
            }));

            // Tentativa 2: Com match_threshold (pode ser opcional)
            if (error && (error.code === 'PGRST202' || error.message.includes('parameters'))) {
                displayWarn('Tentativa 1 falhou, tentando com match_threshold...');
                ({ data, error } = await supabase.rpc('match_documents', {
                    filter: metadataFilter,
                    match_count: topK,
                    query_embedding: queryEmbedding,
                    match_threshold: 0.7
                }));
            }

            // Tentativa 3: Ordem original do SQL - query_embedding, match_threshold, match_count, filter
            if (error && (error.code === 'PGRST202' || error.message.includes('parameters'))) {
                displayWarn('Tentativa 2 falhou, tentando ordem original do SQL...');
                ({ data, error } = await supabase.rpc('match_documents', {
                    query_embedding: queryEmbedding,
                    match_threshold: 0.7,
                    match_count: topK,
                    filter: metadataFilter
                }));
            }

            debugInfo.parametrosRPC = {
                tentativas: [
                    { ordem: 'filter, match_count, query_embedding' },
                    { ordem: 'filter, match_count, query_embedding, match_threshold' },
                    { ordem: 'query_embedding, match_threshold, match_count, filter' }
                ],
                parametrosUsados: {
                    filter: metadataFilter,
                    match_count: topK,
                    query_embedding: `vector(${queryEmbedding.length} dimensões)`,
                    match_threshold: 0.7
                }
            };

            if (error) {
                displayError('Erro ao buscar documentos no Supabase:', error);
                debugInfo.erro = {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                    hint: error.hint
                };
                
                // Se a função RPC não existir, tenta busca direta na tabela
                if (error.code === '42883' || error.message.includes('function') || error.message.includes('does not exist')) {
                    displayWarn('Função match_documents não encontrada. Tentando busca alternativa...');
                    debugInfo.buscaAlternativa = true;
                    const resultadoAlt = await this.buscarBaseConhecimentoAlternativa(query, queryEmbedding, topK, metadataFilter);
                    debugInfo.dadosRetornados = resultadoAlt.length;
                    return { dados: resultadoAlt, debug: debugInfo };
                }
                return { dados: [], debug: debugInfo };
            }

            debugInfo.dadosRetornados = data ? data.length : 0;
            debugInfo.dados = data;

            // Retorna os documentos encontrados
            return { dados: data || [], debug: debugInfo };
        } catch (error) {
            displayError('Erro em buscarBaseConhecimentoGeralSupabase:', error.message);
            debugInfo.erro = error.message;
            debugInfo.stack = error.stack;
            // Em caso de erro, retorna array vazio para não quebrar o fluxo
            return { dados: [], debug: debugInfo };
        }
    }

    /**
     * Busca alternativa quando a função RPC não está disponível
     * @param {string} query - Texto da query
     * @param {Array<number>} queryEmbedding - Embedding da query
     * @param {number} topK - Número máximo de resultados
     * @param {Object} metadataFilter - Filtros de metadata
     * @returns {Promise<Array>} Array com documentos encontrados
     */
    async buscarBaseConhecimentoAlternativa(query, queryEmbedding, topK, metadataFilter) {
        try {
            const supabase = this.getSupabaseClient();

            // Busca direta na tabela documents com filtros de metadata
            let queryBuilder = supabase
                .from('documents')
                .select('*')
                .limit(topK);

            // Aplica filtros de metadata
            if (metadataFilter.nomeTreinamento) {
                queryBuilder = queryBuilder.eq('metadata->nomeTreinamento', metadataFilter.nomeTreinamento);
            }
            if (metadataFilter.idConfig) {
                queryBuilder = queryBuilder.eq('metadata->idConfig', metadataFilter.idConfig);
            }
            if (metadataFilter.contexto) {
                queryBuilder = queryBuilder.eq('metadata->contexto', metadataFilter.contexto);
            }

            const { data, error } = await queryBuilder;

            if (error) {
                displayError('Erro na busca alternativa:', error);
                return [];
            }

            // Nota: Esta busca alternativa não faz busca semântica (não calcula similaridade)
            // Para busca semântica completa, é necessário criar a função match_documents no Supabase
            return data || [];
        } catch (error) {
            displayError('Erro em buscarBaseConhecimentoAlternativa:', error.message);
            return [];
        }
    }

    /**
     * Chama o AI Agent para atualizar a base de conhecimento
     * Equivalente ao nó "AI Agent1" do n8n
     * @param {string} contexto - Contexto extraído das conversas
     * @returns {Promise<Object>} Resultado do agente com output bruto
     */
    async atualizarBaseConhecimento(contexto) {
        const openaiApiKey = process.env.OPENAI_API_KEY;

        const systemMessage = `# Papel do Agente
Você é um agente responsável por ATUALIZAR a base_conhecimento_geral de um agente de WhatsApp.

Você atua dentro de um fluxo no n8n e possui acesso à ferramenta **base_conhecimento_geral**, que contém todo o conhecimento já existente do agente.

---

# Entrada
Você receberá:
- Um contexto estruturado extraído de conversas reais de suporte
- Acesso à ferramenta base_conhecimento_geral

---

# Objetivo (CLARO E OPERACIONAL)
Identificar, dentro do contexto recebido, QUAIS informações AINDA NÃO EXISTEM na base_conhecimento_geral e retornar APENAS essas informações para serem adicionadas.

# Regra obrigatória sobre origem do conhecimento (CRÍTICA)
Considere para retorno SOMENTE informações que tenham sido claramente explicadas por um ATENDENTE HUMANO na conversa original.

# NÃO considere como conhecimento válido:
- Perguntas do usuário que não tiveram resposta clara do atendente humano
- Assuntos que ficaram em aberto, pendentes ou sem explicação conclusiva
- Inferências, deduções ou interpretações do agente
- Informações implícitas que não foram explicitamente ditas pelo atendente humano

## Se um tema foi levantado pelo usuário, mas NÃO houve uma resposta humana clara, objetiva e esclarecedora, esse tema deve ser totalmente descartado e NÃO deve ser retornado.


## Deduplicação (OBRIGATÓRIA)
Descartar apenas quando o mesmo conhecimento (regra/procedimento/limitação) já estiver claramente registrado na base_conhecimento_geral e já permitir responder o cliente.
Se existir apenas o tema de forma genérica, mas faltar o detalhe prático explicado pelo atendente, considere como novo e retorne.


---

# Como analisar corretamente (OBRIGATÓRIO)
1) Divida o contexto recebido em blocos de conhecimento (por assunto).
2) Para CADA bloco:
   - Consulte a ferramenta base_conhecimento_geral
   - Verifique se aquela informação específica já existe
3) Considere que um conhecimento JÁ EXISTE apenas se:
   - Ele já está descrito de forma clara na base
   - Ele já permite responder uma dúvida real do cliente
4) Se existir apenas de forma genérica, incompleta ou técnica demais, considere como CONHECIMENTO NOVO.

---

# O que DEVE ser adicionado à base_conhecimento_geral
Inclua no retorno:
- Explicações práticas usadas no suporte
- Comparações que esclarecem dúvidas do cliente
- Limitações explicadas em linguagem simples
- Diferenças de comportamento do sistema percebidas pelo cliente
- Procedimentos reais de resolução
- Orientações usadas para responder reclamações

Mesmo que o tema exista na base, inclua se o detalhe NÃO existir.

---

# O que NÃO deve ser adicionado
Descartar obrigatoriamente:
- Repetição literal de documentação
- Explicações de menus já documentadas
- Fluxos administrativos internos
- Status, histórico ou número de tickets
- Cumprimentos e mensagens sociais

---
# Regra de qualidade do embedding (OBRIGATÓRIA)
Mesmo que a informação NÃO exista na base_conhecimento_geral, só retorne se for conhecimento treinável (ajuda a responder um cliente no WhatsApp com ação/explicação prática).

NÃO retornar (mesmo que seja novo):
- Status/andamento ("em análise", "aberto", "aguardando retorno", "sem instabilidade no painel")
- Links enviados apenas como referência genérica, monitoramento, status externo ou sem instrução clara devem ser descartados.
- Casos isolados sem regra reutilizável (ex.: "boleto do Banco do Brasil" sem procedimento geral)
- Detalhes técnicos internos (banco/coluna/limite técnico) sem tradução prática do que o cliente deve fazer
- Conteúdo repetido ou apenas "caminho de menu" já documentado (a menos que o passo-a-passo seja a resposta prática do atendente e não exista na base)
- Muitos assuntos misturados no mesmo bloco.
- NÃO retornar conteúdos que descrevam apenas: 
    Que ocorre ocasionalmente
    Que pode apresentar falha intermitente
    Que o comportamento depende de teste ou validação do cliente
    Se não houver ação clara, configuração objetiva ou procedimento reproduzível,
      o conteúdo deve ser descartado integralmente.

## Regra sobre afirmações de estado do sistema (OBRIGATÓRIA)
Quando o atendente humano descrever o comportamento do sistema no contexto de um cliente específico,
o agente DEVE converter a informação para forma genérica e configurável, evitando afirmar estado atual.

Utilizar sempre linguagem de possibilidade ou capacidade do sistema, como:
- "É possível configurar…"
- "O sistema permite…"
- "Existe configuração para…"

NUNCA afirmar:
- Que o sistema "está configurado"
- Que o comportamento ocorre automaticamente para todos os clientes
- Que a funcionalidade já está ativa por padrão


## Regra de exceção para links externos (OBRIGATÓRIA)
Links externos DEVEM ser retornados quando:
- Foram enviados explicitamente por um ATENDENTE HUMANO
- Estão associados a uma orientação prática clara ao cliente
- Foram apresentados como ação recomendada (ex.: tutorial, configuração, passo a passo)


## Regra específica para links de tutorial
Quando um atendente humano enviar um link de tutorial como orientação direta ao cliente,
o link DEVE ser incluído no conhecimento retornado, desde que:
- O atendente tenha explicado o motivo do link
- O link ajude o cliente a executar uma ação no sistema


SEMPRE preferir:
- Regra + motivo + o que fazer (procedimento) + limitações (em linguagem simples)


# Regra para correções técnicas
Correções devem ser incluídas apenas se:
- Influenciam respostas futuras
- Explicam exceções ou comportamentos específicos
- Ajudam o agente a orientar corretamente o cliente

Se incluir correção:
- Informar data completa (dia, mês e ano)

## Regra obrigatória sobre correções e falhas pontuais (CRÍTICA)
NÃO retornar conteúdos que:
- Relatem apenas que um erro existiu e foi corrigido
- Informem datas de correção sem gerar procedimento reutilizável
- Orientem o cliente a "validar", "testar", "confirmar" ou "verificar se a correção está funcionando"
- Descrevam problemas pontuais sem ação clara que o cliente possa executar

Correções técnicas só podem ser retornadas se:
- Alterarem o comportamento esperado do sistema de forma permanente
- Gerarem uma nova orientação prática para o cliente
- Explicarem uma limitação ou exceção que ainda pode ocorrer após a correção

Se a correção apenas resolve um erro interno e NÃO gera ação reutilizável para o cliente, o conteúdo deve ser descartado integralmente.

## Regra obrigatória de padronização de termos (CRÍTICA)
Sempre que o conteúdo se referir a:
- Entregador
- Prestador de serviço
- Quem executa a corrida, serviço ou entrega

O termo utilizado DEVE ser exclusivamente:
- profissional
OU
- prestador de serviço

É PROIBIDO retornar ou gerar os termos:
- motorista
- motoboy
- mototáxi
- motociclista
- entregador (como papel principal)

Essa padronização é obrigatória porque o sistema atende diferentes modelos de operação
e o conhecimento deve ser reutilizável para todos os clientes.

## Regra de consistência semântica do conhecimento
O conteúdo retornado deve:
- Ser válido para qualquer cliente do sistema
- Não depender de contexto específico, data, ambiente ou tipo de operação
- Usar termos neutros e reutilizáveis definidos neste prompt

Qualquer conteúdo que só faça sentido para um cliente específico deve ser descartado.

---

# Formato do conteúdo retornado
- Usar hashtags \`#\`, \`##\`, \`###\`
- Usar **negrito** para rótulos
- Texto claro, objetivo e treinável
- Quebras de linha reais
- Sem HTML
- Sem listas com marcadores

# Granularidade (OBRIGATÓRIA)
Retorne o conteúdo dividido por assuntos (um bloco por assunto usando # / ##).
Evite agrupar assuntos diferentes no mesmo bloco.
Se houver muitos assuntos, retorne apenas os blocos realmente novos e úteis.

---

# Quando retornar status false
Retorne status false somente se:
- Todo o contexto já estiver completamente coberto pela base_conhecimento_geral
- Nenhuma informação nova ou complementar for identificada

---

# Saída (OBRIGATÓRIA)
Retorne SEMPRE um JSON exatamente neste formato:

{
  "status": true | false,
  "contexto": "apenas o conteúdo que deve ser adicionado à base_conhecimento_geral"
}

Se status for false, o campo contexto deve ser vazio.

---

# Restrições
- Não explique decisões
- Não faça perguntas
- Não altere o formato da saída
- Não inclua conteúdo fora do JSON
- Não invente nada.
- Retorna somente informações com base no que recebeu nas respostas do atendente humano sem inventar ou acrescentar informações. Se o que o usuário respondeu não tiver resposta clara do atendente humano não retorna nada sobre o assunto.
- NÃO adicionar rótulos interpretativos ou qualificadores como:
  "Informação nova", "Resumo", "Observação", "Nota", "Importante", "Atenção".
- O conteúdo retornado deve ser apenas a informação objetiva explicada pelo atendente humano.
- NÃO comentar se a informação é nova, antiga, óbvia ou conhecida.`;

        try {
            // Busca na base de conhecimento antes de chamar o agente (igual ao n8n)
            // Isso simula a ferramenta "base_conhecimento_geral" que o AI Agent usa
            let baseConhecimento = [];
            let promptUsuario = contexto;
            let debugInfoSupabase = null;
            
            try {
                // Busca na base usando o contexto como query
                baseConhecimento = await this.buscarBaseConhecimentoGeralSupabase(contexto, {
                    topK: 50,
                    metadata: {
                        nomeTreinamento: 'Treinamento_base',
                        idConfig: '386',
                        contexto: 'SUPORTE'
                    }
                });
                
                // Guarda informações de debug
                // baseConhecimento pode ser um objeto { dados: [], debug: {} } ou array direto
                const docs = Array.isArray(baseConhecimento) ? baseConhecimento : (baseConhecimento.dados || []);
                const debugSupabase = baseConhecimento.debug || null;
                
                debugInfoSupabase = {
                    query: contexto.substring(0, 100) + (contexto.length > 100 ? '...' : ''),
                    documentosEncontrados: docs.length,
                    documentos: docs.map(doc => ({
                        id: doc.id,
                        content: doc.content ? doc.content.substring(0, 200) + (doc.content.length > 200 ? '...' : '') : null,
                        similarity: doc.similarity,
                        metadata: doc.metadata
                    })),
                    debugSupabase: debugSupabase
                };
                
                // Atualiza baseConhecimento para ser array
                baseConhecimento = docs;
                
                // Se encontrou documentos, adiciona ao prompt
                if (baseConhecimento && baseConhecimento.length > 0) {
                    const conhecimentoExistente = baseConhecimento
                        .map(doc => {
                            // Formata cada documento encontrado
                            const content = doc.content || '';
                            const similarity = doc.similarity ? ` (similaridade: ${(doc.similarity * 100).toFixed(1)}%)` : ''; 
                            return content + similarity;
                        })
                        .filter(text => text.trim() !== '')
                        .join('\n\n---\n\n');
                    
                    if (conhecimentoExistente) {
                        promptUsuario = `Contexto extraído das conversas:\n\n${contexto}\n\n---\n\nBase de conhecimento existente (para referência e deduplicação):\n\n${conhecimentoExistente}`;
                    }
                }
            } catch (error) {
                // Se der erro na busca, continua sem a base (não quebra o fluxo)
                displayWarn('Erro ao buscar base de conhecimento, continuando sem ela:', error.message);
                debugInfoSupabase = {
                    erro: error.message,
                    documentosEncontrados: 0
                };
            }

            const response = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${openaiApiKey}`
                },
                body: JSON.stringify({
                    model: 'gpt-4o-mini', // Usando gpt-4o-mini como no n8n
                    messages: [
                        {
                            role: 'system',
                            content: systemMessage
                        },
                        {
                            role: 'user',
                            content: promptUsuario
                        }
                    ],
                    temperature: 0.3,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`Erro na API OpenAI: ${response.status} - ${errorData}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;

            if (!content) {
                return {
                    output: JSON.stringify({
                        status: false,
                        contexto: ''
                    })
                };
            }

            // Retorna o output bruto para ser processado pela função "Nota do atendimento1"
            return {
                output: content,
                debugSupabase: debugInfoSupabase // Informações de debug da busca
            };
        } catch (error) {
            displayError('Erro ao chamar AI Agent para atualizar base:', error.message);
            throw error;
        }
    }

    /**
     * Processa o resultado do AI Agent (equivalente ao nó "Nota do atendimento1")
     * Esta função já existe como processarRespostaAgente, mas criamos um alias para clareza
     * @param {string|Object} output - Output do AI Agent
     * @returns {Object} Objeto parseado
     */
    processarResultadoAIAgent(output) {
        return this.processarRespostaAgente(output);
    }

    /**
     * Fluxo completo: Atualiza base de conhecimento com contexto extraído
     * Orquestra: AI Agent1 → Nota do atendimento1
     * @param {string} contexto - Contexto extraído das conversas
     * @param {boolean} debug - Se true, retorna informações detalhadas de cada etapa
     * @returns {Promise<Object>} Resultado processado com conhecimento novo
     */
    async atualizarBaseConhecimentoCompleto(contexto, debug = false) {
        try {
            // Validação
            if (!contexto || typeof contexto !== 'string' || contexto.trim() === '') {
                return {
                    output: JSON.stringify({
                        status: false,
                        contexto: ''
                    })
                };
            }

            const debugInfo = {
                etapa1_buscaSupabase: null,
                etapa2_aiAgent: null,
                etapa3_processamento: null
            };

            // Passo 1 e 2: Chama AI Agent (que já faz a busca no Supabase internamente)
            const resultadoAI = await this.atualizarBaseConhecimento(contexto);
            
            // Pega informações de debug da busca (vem do resultadoAI)
            if (debug) {
                debugInfo.etapa1_buscaSupabase = resultadoAI.debugSupabase || {
                    mensagem: 'Busca realizada dentro do AI Agent',
                    documentosEncontrados: 0
                };
                
                debugInfo.etapa2_aiAgent = {
                    outputBruto: resultadoAI.output ? resultadoAI.output.substring(0, 500) + (resultadoAI.output.length > 500 ? '...' : '') : null,
                    tamanhoOutput: resultadoAI.output ? resultadoAI.output.length : 0,
                    outputCompleto: resultadoAI.output
                };
            }

            // Passo 3: Processa resposta do agente (nó "Nota do atendimento1")
            const resultadoProcessado = this.processarResultadoAIAgent(resultadoAI.output || resultadoAI);
            
            if (debug) {
                debugInfo.etapa3_processamento = {
                    status: resultadoProcessado.status,
                    contextoProcessado: resultadoProcessado.contexto ? resultadoProcessado.contexto.substring(0, 300) + '...' : '',
                    tamanhoContexto: resultadoProcessado.contexto ? resultadoProcessado.contexto.length : 0,
                    objetoCompleto: resultadoProcessado
                };
            }

            // Retorna apenas o output como string JSON (igual ao n8n)
            const output = JSON.stringify({
                status: resultadoProcessado.status !== undefined ? resultadoProcessado.status : true,
                contexto: resultadoProcessado.contexto || ''
            });

            // Se debug estiver ativo, retorna com informações adicionais
            if (debug) {
                return {
                    output: output,
                    debug: debugInfo
                };
            }

            // Retorno padrão: apenas output (igual ao n8n)
            return {
                output: output
            };
        } catch (error) {
            displayError('Erro em atualizarBaseConhecimentoCompleto:', error.message);
            throw error;
        }
    }

    /**
     * Gera embedding de conversas - fluxo completo
     * @param {number} idAgentePedir - ID do agente pedir
     * @returns {Promise<Object>} Resultado da extração de contexto
     */
    async geraEmbeddingConversas(idAgentePedir) {
        try {
            // Validação inicial
            if (!idAgentePedir || idAgentePedir <= 0) {
                return {
                    status: false,
                    contexto: '',
                    message: 'idAgentePedir inválido'
                };
            }

            // Busca conversas não validadas
            const conversas = await this.buscarConversasNaoValidadas(idAgentePedir);
            // return conversas;


            if (!conversas || conversas.length === 0) {
                return {
                    status: false,
                    contexto: '',
                    message: 'Nenhuma conversa não validada encontrada'
                };
            }

            // Filtra conversas com mensagem não vazia
            const conversasComMensagem = conversas.filter(c => c.mensagem && c.mensagem.trim() !== '');

            if (conversasComMensagem.length === 0) {
                return {
                    status: false,
                    contexto: '',
                    message: 'Nenhuma conversa com mensagem válida encontrada'
                };
            }

            // Formata conversa
            const conversaFormatada = this.formatarConversa(conversasComMensagem);

            if (!conversaFormatada || conversaFormatada.trim() === '') {
                return {
                    status: false,
                    contexto: '',
                    message: 'Conversa formatada está vazia'
                };
            }

            // Chama OpenAI para extrair contexto
            const resultado = await this.extrairContextoOpenAI(conversaFormatada);

            return resultado;
        } catch (error) {
            displayError('Erro em geraEmbeddingConversas:', error.message);
            throw error;
        }
    }
}