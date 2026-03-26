import { Entidade } from "../../db/Entidade.js";
import { ControleMD_agente_assuntos_nomes } from "./ControleMD_agente_assuntos_nomes.js";
import { ControleMD_agente_pedir_custos_opnai } from "./ControleMD_agente_pedir_custos_opnai.js";
import { ControleMD_agente_conversas_mensagens } from "./ControleMD_agente_conversas_mensagens.js";
import { ControleMDBusacarDadosUsuario } from "./ControleMDBusacarDadosUsuario.js";
import { ControleMD_agente_pedir_numero_sincronizado } from "./ControleMD_agente_pedir_numero_sincronizado.js";
import { ControleMD_agente_kanban_comentario } from "./ControleMD_agente_kanban_comentario.js";
import { getDataHoraPorFuso } from "../../utils/fusoHorario.js";
import SocketController from "../../socket/SocketController.js";
import { DiscordNotifier } from "../../utils/discordNotifier.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

export class ControleEnviarMensagem {
    /**
     * Construtor da classe ControleEnviarMensagem
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        this.entidade.setConnection('md');
    }

    /**
     * Busca o idCliente (idSolicitante) a partir do idConfig na tabela sys_cliente
     * @param {string|number} idConfig - ID da configuração
     * @returns {Promise<string>} ID do cliente (idSolicitante) ou '2' como padrão se não encontrar
     */
    async buscarIdSolicitantePorIdConfig(idConfig) {
        try {
            if (!idConfig || idConfig === '') {
                displayWarn('[ControleEnviarMensagem] idConfig vazio');
                return '0';
            }

            const campos = {
                idCliente: '',
                dominio: ''
            };

            const condicao = 'idConfig = :idConfig';
            const dadosCondicao = {
                idConfig: idConfig
            };

            const resultado = await this.entidade.selectRetornaArrayUnico(
                campos,
                'sys_cliente',
                condicao,
                dadosCondicao
            );

            if (resultado && resultado.idCliente && resultado.idCliente !== '') {
                return resultado;
            }

            displayWarn(`[ControleEnviarMensagem] idCliente não encontrado para idConfig: ${idConfig}`);
            return '';
        } catch (error) {
            displayError('[ControleEnviarMensagem] Erro ao buscar idSolicitante:', error.message);
            displayError('[ControleEnviarMensagem] Stack:', error.stack);
            
            // Envia notificação para Discord
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao buscar idSolicitante', error, {
                idConfig: idConfig
            }, 'Node.js - ControleEnviarMensagem').catch(err => displayError('[ControleEnviarMensagem] Erro ao enviar notificação Discord:', err));
            
            // Em caso de erro, retorna o valor padrão
            return '';
        }
    }

    /**
     * Extrai phone_number_id e contato do webhookBody
     * @param {Object} webhookBody - Body do webhook do WhatsApp
     * @returns {Object} Objeto com phone_number_id e contato { phone_number_id: string|null, contato: Object|null }
     */
    extrairDadosWebhook(webhookBody) {
        let phone_number_id = null;
        let contato = null;

        if (webhookBody && webhookBody.entry && Array.isArray(webhookBody.entry) && webhookBody.entry.length > 0) {
            const changesValue = webhookBody.entry[0]?.changes?.[0]?.value;
            if (changesValue) {
                phone_number_id = changesValue.metadata?.phone_number_id || null;
                contato = changesValue.contacts?.[0] || null;
            }
        }

        return {
            phone_number_id,
            contato
        };
    }

    /**
     * Processa e envia mensagem
     * @param {string} mensagemConcatenada - Mensagem concatenada a ser processada
     * @param {Object} dadosUsuario - Dados do usuário
     * @param {Object} webhookBody - Body do webhook do WhatsApp (opcional)
     * @param {Object} opcoes - Opções (opcional). notificarProcessando: default false; passar true para disparar evento "agente processando" (ex.: fluxo áudio/imagem)
     * @returns {Promise<void>}
     */
    async processarMensagem(mensagemConcatenada, dadosUsuario,  webhookBody = {}, opcoes = { notificarProcessando: false }) {
        try {
            // Extrai dados necessários
            const idConfig = dadosUsuario.dadosNumeroSincronizado?.idConfig || '';
            const idTelConectado = dadosUsuario.dadosNumeroSincronizado?.id || '';
            const idUsuario = dadosUsuario.idAgentePedir || '';
            const tipoAgente = dadosUsuario.dadosNumeroSincronizado?.tipoAgente || '';
            const identificadorNumero = dadosUsuario.identificadorNumero ?? '';

            // Busca idSolicitante: prioridade agente_pedir.solicitante (via idAgentePedir + idTelConectado), fallback sys_cliente
            let dadosSolicitante = await this.buscarIdSolicitantePorIdConfig(idConfig);
            dadosSolicitante = (dadosSolicitante && typeof dadosSolicitante === 'object') ? dadosSolicitante : { idCliente: '', dominio: '' };

            if (idUsuario && idTelConectado) {
                const controleBuscar = new ControleMDBusacarDadosUsuario(this.db);
                const solicitante = await controleBuscar.buscarSolicitantePorIdAgentePedirEIdTelConectado(idUsuario, idTelConectado);
                if (solicitante) {
                    dadosSolicitante = { ...dadosSolicitante, idCliente: solicitante };
                }
            }

            // Busca o prompt usando o controller
            const controleAssuntos = new ControleMD_agente_assuntos_nomes(this.db);
            const resultadoAssuntos = await controleAssuntos.buscarAssuntosPorConfig(
                dadosSolicitante.idCliente,
                idConfig,
                tipoAgente
            );


            // Monta o prompt concatenando todos os textos dos assuntos
            let prompt = '';
            if (resultadoAssuntos.assuntos && resultadoAssuntos.assuntos.length > 0) {
                prompt = resultadoAssuntos.assuntos
                    .map(assunto => assunto.texto || '')
                    .filter(texto => texto && texto.trim() !== '')
                    .join('\n\n');
            }

            // Busca data/hora usando fusoHorario
            const dataHoraSP = getDataHoraPorFuso('America/Sao_Paulo');
            const agora = new Date();

            // Formata data/hora no fuso de São Paulo
            const formatter = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });

            const partes = formatter.formatToParts(agora);
            const get = (tipo) => partes.find((p) => p.type === tipo)?.value;

            const dia = get('day');
            const mes = get('month');
            const ano = get('year');
            const hora = get('hour');
            const minuto = get('minute');
            const segundo = get('second');

            // Formata dia da semana
            const diaSemanaFormatter = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                weekday: 'long'
            });
            const diaSemana = diaSemanaFormatter.format(agora);

            // Monta os valores formatados
            const dataAtual = `${ano}-${mes}-${dia}`;
            const horaAtual = `${hora}:${minuto}:${segundo}`;
            const dataHora = `${dataAtual} ${horaAtual}`;
            const timeAtual = Math.floor(agora.getTime() / 1000);
            const isoSaoPaulo = `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}-03:00`;

            // Prepara o JSON para enviar
            const payload = {
                mensagem: mensagemConcatenada,
                idConfig: String(idConfig),
                idTelConectado: String(idTelConectado),
                idUsuario: String(idUsuario),
                tipoAgente: String(tipoAgente),
                timeAtual: String(timeAtual),
                dataAtual: dataAtual,
                horaAtual: horaAtual,
                dataHora: dataHora,
                dominio: dadosSolicitante.dominio,
                diaSemana: diaSemana,
                idSolicitante: String(dadosSolicitante.idCliente),
                isoSaoPaulo: isoSaoPaulo,
                nomeTreinamento: "Treinamento_base",
                prompt: prompt
            };

            // Notifica que o agente está processando (antes da requisição à IA) apenas quando opcoes.notificarProcessando === true (default é false)
            if (idUsuario && webhookBody && Object.keys(webhookBody).length > 0 && opcoes.notificarProcessando === true) {
                try {
                    SocketController.notificarAgenteProcessando(idUsuario, webhookBody);
                } catch (error) {
                    displayError('[ControleEnviarMensagem] Erro ao notificar agente processando:', error.message);
                }
            }

            try {
                displayLog('[ControleEnviarMensagem] payload:', payload.prompt);
                displayLog('[ControleEnviarMensagem] payload:', JSON.stringify(payload));

                // Busca URL do agente N8n no banco por idTelConectado
                const controleNumeroSincronizado = new ControleMD_agente_pedir_numero_sincronizado(this.db);
                const urlAgenteN8n = await controleNumeroSincronizado.buscaUrlAgenteN8n(idTelConectado);

                let urlParaRequisicao = (urlAgenteN8n && String(urlAgenteN8n).trim()) || '';
                if (urlParaRequisicao === '') {
                    urlParaRequisicao = (process.env.URL_AGENTE_N8N && String(process.env.URL_AGENTE_N8N).trim()) || '';
                    if (urlParaRequisicao) {
                        displayWarn('[ControleEnviarMensagem] urlAgenteN8n não encontrada para idTelConectado, usando URL_AGENTE_N8N do .env:', idTelConectado);
                    }
                }
                if (!urlParaRequisicao) {
                    displayWarn('[ControleEnviarMensagem] urlAgenteN8n não encontrada para idTelConectado e URL_AGENTE_N8N não definida:', idTelConectado);
                    return null;
                }

                displayLog('[ControleEnviarMensagem] urlAgenteN8n:', urlParaRequisicao);
                // Faz a requisição HTTP POST
                const response = await fetch(urlParaRequisicao, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer MciN9NIcKAg'
                    },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errBody = await response.text();
                    const errorMsg = `Erro n8n: HTTP ${response.status} ${response.statusText}`;
                    displayError('[ControleEnviarMensagem]', errorMsg);
                    displayError('[ControleEnviarMensagem] Corpo da resposta:', (errBody && String(errBody).trim()) ? String(errBody).substring(0, 800) : '(vazio)');
                    displayError('[ControleEnviarMensagem] idUsuario:', idUsuario, '| idConfig:', idConfig);

                    DiscordNotifier.enviarErro('Chat WhatsApp - Erro na requisição ao webhook do agente (n8n)', new Error(errorMsg), {
                        status: response.status,
                        statusText: response.statusText,
                        bodySnippet: (errBody && String(errBody).trim()) ? String(errBody).substring(0, 500) : null,
                        idUsuario,
                        idConfig
                    }, 'Retorno Webhook Agente').catch(err => displayError('[ControleEnviarMensagem] Erro ao enviar notificação Discord:', err));

                    throw new Error(errorMsg);
                }

                // Verifica se a resposta tem conteúdo antes de fazer parse
                const responseText = await response.text();

                if (!responseText || responseText.trim() === '') {
                    displayWarn('[ControleEnviarMensagem] Resposta vazia do webhook n8n');
                    return null;
                }

            let resultado;
            try {
                resultado = JSON.parse(responseText);
                displayLog('[ControleEnviarMensagem] Resposta da requisição:', resultado);

                // Os dados estão aninhados em resultado.resposta
                const respostaAgente = resultado?.resposta || {};
                const status = respostaAgente?.status;
                const similaridade = respostaAgente?.similaridade;
                const mensagemPartes = respostaAgente?.resposta?.partes || [];

                // Valida se status é true e similaridade é maior ou igual a 0.8
                // const statusValido = status === true || status === 'true';
                const statusValido = true;
                const similaridadeValida = similaridade != null && parseFloat(similaridade) >= 0.8;

                displayLog('[ControleEnviarMensagem] Status válido:', statusValido);
                displayLog('[ControleEnviarMensagem] Similaridade válida:', similaridadeValida);

                // Calcula e debita os custos do uso da IA
                const controleCustos = new ControleMD_agente_pedir_custos_opnai(this.db);
                const resultadoCustos = await controleCustos.calcularCustos(
                    mensagemConcatenada,
                    responseText, // respostaAgente (pode ser string JSON ou string simples)
                    idTelConectado,
                    idConfig,
                    idUsuario,
                    0 // custoAudio (opcional, padrão 0)
                );
                displayLog('[ControleEnviarMensagem] Custos calculados:', resultadoCustos);

                if (statusValido) {
                    // Salva a mensagem do agente na tabela agente_conversas_mensagens (sempre, mesmo com similaridade < 0.8)
                    const controleMensagens = new ControleMD_agente_conversas_mensagens(this.db);
                    const identificador = String(identificadorNumero).trim() === '921213204414131' ? 'Lina' : 'Iam';

                    // Função auxiliar para aguardar 3 segundos
                    const aguardar = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                    // Verifica se mensagemPartes é um array com múltiplas mensagens
                    if (Array.isArray(mensagemPartes) && mensagemPartes.length > 0) {
                        // Envia cada mensagem separadamente com intervalo de 3 segundos
                        for (let i = 0; i < mensagemPartes.length; i++) {
                            const mensagemIndividual = mensagemPartes[i];

                            // Aguarda 3 segundos antes de enviar (exceto na primeira mensagem)
                            if (i > 0) {
                                await aguardar(3000);
                            }

                            const dadosMensagem = {
                                dadosConteudo: {
                                    idAgentePedir: idUsuario,
                                    origem: 'A', // 'A' = Agente (resposta do agente)
                                    mensagem: mensagemIndividual,
                                    identificador: identificador,
                                    similaridade: similaridade || null,
                                    tipo: 'texto',
                                    timeData: timeAtual, // Timestamp Unix em segundos (como strtotime do PHP)
                                    dataHora: dataHora,
                                    idTelConectado,
                                    idConfig,
                                    tipoAgente: tipoAgente,
                                }
                            };

                            await controleMensagens.salvarMensagem(dadosMensagem);
                            displayLog(`[ControleEnviarMensagem] Mensagem ${i + 1}/${mensagemPartes.length} salva com sucesso`);
                        }
                    } else {
                        // Se não for array ou estiver vazio, usa fallback
                        const mensagemAgente = resultado?.mensagem || resultado?.texto || responseText || '';

                        const dadosMensagem = {
                            dadosConteudo: {
                                idAgentePedir: idUsuario,
                                origem: 'A', // 'A' = Agente (resposta do agente)
                                mensagem: mensagemAgente,
                                identificador: identificador,
                                similaridade: similaridade || null,
                                tipo: 'texto',
                                timeData: timeAtual, // Timestamp Unix em segundos (como strtotime do PHP)
                                dataHora: dataHora,
                                idTelConectado,
                                idConfig,
                                tipoAgente: tipoAgente,
                            }
                        };

                        await controleMensagens.salvarMensagem(dadosMensagem);
                        displayLog('[ControleEnviarMensagem] Mensagem salva com sucesso');
                    }

                    // Envia mensagem via Socket.IO se SocketController estiver disponível e webhookBody fornecido
                    if (SocketController && webhookBody && Object.keys(webhookBody).length > 0) {
                        try {
                            displayWarn('[ControleEnviarMensagem] enviar mensagem via Socket.IO:');
                            SocketController.sendMessage(webhookBody);
                        } catch (error) {
                            displayError('[ControleEnviarMensagem] Erro ao enviar mensagem via Socket.IO:', error.message);
                        }
                    }
                }

                // Quando similaridade < 0.8: move o card para a coluna "agente não responde" no Kanban
                if (!similaridadeValida) {
                    displayLog('[ControleEnviarMensagem] Similaridade abaixo de 0.8 - atualizando coluna Kanban:', {
                        status,
                        similaridade,
                        statusValido,
                        similaridadeValida
                    });
                    try {
                        const sqlColuna = `SELECT id FROM agente_kanban_coluna WHERE tipo = ? AND agenteResponde = 'N' ORDER BY ordem ASC LIMIT 1`;
                        const [rowsColuna] = await this.entidade.connection.query(sqlColuna, [tipoAgente]);
                        const idColuna = rowsColuna && rowsColuna[0] ? parseInt(rowsColuna[0].id, 10) : 0;
                        if (idColuna > 0) {
                            const condicao = 'idConfig = :idConfig AND idTelConectado = :idTelConectado AND idAgentePedir = :idAgentePedir';
                            const dadosCondicao = {
                                idConfig: idConfig,
                                idTelConectado: idTelConectado,
                                idAgentePedir: idUsuario
                            };
                            const atualizado = await this.entidade.update(
                                { id_coluna: idColuna },
                                'agente_kanban_monitoramento',
                                condicao,
                                dadosCondicao
                            );
                            if (atualizado) {
                                displayLog('[ControleEnviarMensagem] Similaridade < 0.8: id_coluna atualizado para', idColuna, 'em agente_kanban_monitoramento');
                            }
                        }
                    } catch (errKanban) {
                        displayError('[ControleEnviarMensagem] Erro ao atualizar coluna Kanban (similaridade < 0.8):', errKanban.message);
                    }
                }

            } catch (parseError) {
                const snippet = (responseText && String(responseText).trim()) ? String(responseText).substring(0, 500) : '(vazio)';
                displayError('[ControleEnviarMensagem] Erro n8n - parse JSON:', parseError.message);
                displayError('[ControleEnviarMensagem] Corpo da resposta (trecho):', snippet);
                displayError('[ControleEnviarMensagem] idUsuario:', idUsuario, '| idConfig:', idConfig);

                DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao fazer parse da resposta JSON do webhook do agente (n8n)', parseError, {
                    responseTextSnippet: snippet,
                    idUsuario,
                    idConfig
                }, 'Retorno Webhook Agente').catch(err => displayError('[ControleEnviarMensagem] Erro ao enviar notificação Discord:', err));

                throw new Error(`Resposta inválida do servidor: ${parseError.message}`);
            }

            } finally {
                if (idUsuario && webhookBody && Object.keys(webhookBody).length > 0) {
                    try {
                        SocketController.notificarAgenteDisponivel(idUsuario, webhookBody);
                    } catch (notifError) {
                        displayError('[ControleEnviarMensagem] Erro ao notificar agente disponível:', notifError.message);
                    }
                }
            }

        } catch (error) {
            displayError('[ControleEnviarMensagem] Erro ao processar mensagem:', error.message);
            displayError('[ControleEnviarMensagem] Stack:', error.stack);

            DiscordNotifier.enviarErro('Chat WhatsApp - Erro crítico ao processar mensagem do agente', error, {
                idUsuario: dadosUsuario?.idAgentePedir || 'não informado',
                idConfig: dadosUsuario?.dadosNumeroSincronizado?.idConfig || 'não informado'
            }, 'Node.js - ControleEnviarMensagem').catch(err => displayError('[ControleEnviarMensagem] Erro ao enviar notificação Discord:', err));

            throw error;
        }
    }

    /**
     * Elabora a mensagem do usuário para envio ao cliente via agente n8n.
     * Usado quando tipo_mensagem === 'prompt' nas automações Kanban.
     * Envia ao n8n a instrução para elaborar a versão mais clara da mensagem e retorna o texto.
     *
     * @param {string} mensagemUsuario - Texto configurado pelo usuário na automação
     * @param {Object} item - Item da automação (idAgentePedir, idTelConectado, idConfig)
     * @param {string} tipoAgente - Tipo do agente (ex.: 'SUPORTE')
     * @returns {Promise<string|null>} Texto elaborado pelo n8n ou null em caso de erro/resposta vazia
     */
    async elaborarMensagemParaCliente(mensagemUsuario, item, tipoAgente) {
        if (mensagemUsuario == null || String(mensagemUsuario).trim() === '') {
            return null;
        }
        const idConfig = item?.idConfig || '';
        const idTelConectado = item?.idTelConectado || '';
        const idUsuario = item?.idAgentePedir || '';
        if (!idConfig || !idTelConectado || !idUsuario || !tipoAgente) {
            displayWarn('[ControleEnviarMensagem] elaborarMensagemParaCliente: idConfig, idTelConectado, idAgentePedir ou tipoAgente ausente');
            return null;
        }
        try {
            let dadosSolicitante = await this.buscarIdSolicitantePorIdConfig(idConfig);
            dadosSolicitante = (dadosSolicitante && typeof dadosSolicitante === 'object') ? dadosSolicitante : { idCliente: '', dominio: '' };
            if (idUsuario && idTelConectado) {
                const controleBuscar = new ControleMDBusacarDadosUsuario(this.db);
                const solicitante = await controleBuscar.buscarSolicitantePorIdAgentePedirEIdTelConectado(idUsuario, idTelConectado);
                if (solicitante) {
                    dadosSolicitante = { ...dadosSolicitante, idCliente: solicitante };
                }
            }
             /*
            const controleAssuntos = new ControleMD_agente_assuntos_nomes(this.db);
            const resultadoAssuntos = await controleAssuntos.buscarAssuntosPorConfig(
                dadosSolicitante.idCliente,
                idConfig,
                tipoAgente
            );*/
            let prompt = '';
            /*
            if (resultadoAssuntos.assuntos && resultadoAssuntos.assuntos.length > 0) {
                prompt = resultadoAssuntos.assuntos
                    .map(assunto => assunto.texto || '')
                    .filter(texto => texto && texto.trim() !== '')
                    .join('\n\n');
            }*/
            const agora = new Date();
            const formatter = new Intl.DateTimeFormat('pt-BR', {
                timeZone: 'America/Sao_Paulo',
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: false
            });
            const partes = formatter.formatToParts(agora);
            const get = (tipo) => partes.find((p) => p.type === tipo)?.value;
            const dia = get('day');
            const mes = get('month');
            const ano = get('year');
            const hora = get('hour');
            const minuto = get('minute');
            const segundo = get('second');
            const diaSemanaFormatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });
            const diaSemana = diaSemanaFormatter.format(agora);
            const dataAtual = `${ano}-${mes}-${dia}`;
            const horaAtual = `${hora}:${minuto}:${segundo}`;
            const dataHora = `${dataAtual} ${horaAtual}`;
            const timeAtual = Math.floor(agora.getTime() / 1000);
            const isoSaoPaulo = `${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}-03:00`;

            let parteComentario = "";
            let parteReuniao = "";
            if (item?.id_monitoramento && (String(item.usar_comentario || "").toUpperCase() === "S" || String(item.usar_reuniao || "").toUpperCase() === "S")) {
              const controleComentario = new ControleMD_agente_kanban_comentario(this.db);
              const { comentarios, resumoReuniao } = await controleComentario.buscarComentariosEResumoReuniao(
                item.id_monitoramento,
                item.usar_comentario,
                item.usar_reuniao
              );
              if (String(item.usar_comentario || "").toUpperCase() === "S") {
                const txt = comentarios.length > 0 ? comentarios.join("\n").trim() : "";
                if (txt.length > 0) {
                  parteComentario = `Comentário referente à conversa realizada com o cliente:\n${txt}.`;
                }
              }
              if (String(item.usar_reuniao || "").toUpperCase() === "S") {
                const txt = resumoReuniao.length > 0 ? resumoReuniao.join("\n").trim() : "";
                if (txt.length > 0) {
                  parteReuniao = `Resumo da reunião realizada com o cliente e nossa equipe:\n${txt}`;
                }
              }
            }

            const separador = parteComentario && parteReuniao ? "\n\n" : "";
            const separadorMensagem = parteComentario || parteReuniao ? "\n\n" : "";
            const mensagemParaN8n = `O usuário encaminhou a seguinte mensagem ao cliente:\n\n${String(mensagemUsuario).trim()}\n\nCom base nessa mensagem, elabore a versão mais clara e adequada para o envio ao cliente.${separadorMensagem}${parteComentario}${separador}${parteReuniao}${separadorMensagem}Retorne apenas o texto final, sem explicações.`;
            displayLog('[ControleEnviarMensagem] elaborarMensagemParaCliente: mensagemParaN8n:', mensagemParaN8n);
            const payload = {
                mensagem: mensagemParaN8n,
                idConfig: String(idConfig),
                idTelConectado: String(idTelConectado),
                idUsuario: String(idUsuario),
                tipoAgente: String(tipoAgente),
                timeAtual: String(timeAtual),
                dataAtual,
                horaAtual,
                dataHora,
                dominio: dadosSolicitante.dominio || '',
                diaSemana,
                idSolicitante: String(dadosSolicitante.idCliente || ''),
                isoSaoPaulo,
                nomeTreinamento: 'Treinamento_base',
                prompt
            };

            const controleNumeroSincronizado = new ControleMD_agente_pedir_numero_sincronizado(this.db);
            let urlParaRequisicao = await controleNumeroSincronizado.buscaUrlAgenteN8n(idTelConectado);
            urlParaRequisicao = (urlParaRequisicao && String(urlParaRequisicao).trim()) || '';
            if (!urlParaRequisicao) {
                urlParaRequisicao = (process.env.URL_AGENTE_N8N && String(process.env.URL_AGENTE_N8N).trim()) || '';
            }
            if (!urlParaRequisicao) {
                displayWarn('[ControleEnviarMensagem] elaborarMensagemParaCliente: urlAgenteN8n não encontrada para idTelConectado:', idTelConectado);
                return null;
            }

            const response = await fetch(urlParaRequisicao, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer MciN9NIcKAg'
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errBody = await response.text();
                displayError('[ControleEnviarMensagem] elaborarMensagemParaCliente: HTTP', response.status, (errBody && String(errBody).trim()) ? String(errBody).substring(0, 300) : '');
                return null;
            }

            const responseText = await response.text();
            if (!responseText || responseText.trim() === '') {
                return null;
            }

            let resultado;
            try {
                resultado = JSON.parse(responseText);
            } catch (parseErr) {
                displayError('[ControleEnviarMensagem] elaborarMensagemParaCliente: parse JSON:', parseErr?.message);
                return null;
            }

            const respostaAgente = resultado?.resposta || {};
            const mensagemPartes = respostaAgente?.resposta?.partes || [];
            let textoElaborado = null;
            if (Array.isArray(mensagemPartes) && mensagemPartes.length > 0 && mensagemPartes[0] != null) {
                textoElaborado = String(mensagemPartes[0]).trim();
            }
            if (!textoElaborado) {
                textoElaborado = (resultado?.mensagem != null ? String(resultado.mensagem) : null) || (resultado?.texto != null ? String(resultado.texto) : null) || null;
                if (textoElaborado) textoElaborado = textoElaborado.trim();
            }
            return textoElaborado || null;
        } catch (error) {
            displayError('[ControleEnviarMensagem] elaborarMensagemParaCliente:', error?.message ?? String(error));
            return null;
        }
    }

}

