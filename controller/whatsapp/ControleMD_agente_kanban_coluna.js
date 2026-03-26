import { Entidade } from "../../db/Entidade.js";
import { DiscordNotifier } from "../../utils/discordNotifier.js";
import { log as displayLog, warn as displayWarn, error as displayError } from "../../utils/displayLogWebhook.js";

export class ControleMD_agente_kanban_coluna {
    /**
     * Construtor da classe ControleMD_agente_kanban_coluna
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
        this.entidade.setConnection('md');
        this.tabela = 'agente_kanban_coluna';
    }

    /**
     * Busca uma coluna por ID
     * @param {number|string} id - ID da coluna
     * @returns {Promise<Object>} { success: boolean, data?: Object, message?: string }
     */
    async buscarPorId(id) {
        try {
            if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
                return {
                    success: false,
                    message: 'ID é obrigatório e deve ser um número ou string'
                };
            }

            const idNumero = parseInt(id, 10);
            if (isNaN(idNumero) || idNumero <= 0) {
                return {
                    success: false,
                    message: 'ID deve ser um número maior que zero'
                };
            }

            const campos = {
                id: '',
                nome: '',
                ordem: '',
                tipo: '',
                agenteResponde: '',
                descricao: ''
            };

            const condicao = 'id = :id';
            const dadosCondicao = { id: idNumero };

            const resultado = await this.entidade.selectRetornaRegistroUnico(
                campos,
                this.tabela,
                condicao,
                dadosCondicao
            );

            if (!resultado || !resultado.id) {
                return {
                    success: false,
                    message: 'Coluna não encontrada'
                };
            }

            return {
                success: true,
                data: resultado,
                message: 'Coluna encontrada com sucesso'
            };
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao buscar por ID:', error.message);
            displayError('[ControleMD_agente_kanban_coluna] Stack:', error.stack);
            
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao buscar coluna por ID', error, {
                id: id
            }, 'Node.js - ControleMD_agente_kanban_coluna').catch(err => 
                displayError('[ControleMD_agente_kanban_coluna] Erro ao enviar notificação Discord:', err)
            );

            return {
                success: false,
                message: `Erro ao buscar coluna: ${error.message}`
            };
        }
    }

    /**
     * Busca colunas por filtros
     * @param {Object} filtros - Filtros de busca
     * @param {string} [filtros.tipo] - Tipo da coluna
     * @param {string} [filtros.agenteResponde] - Se o agente responde ('S' ou 'N')
     * @param {number} [filtros.limit] - Limite de resultados
     * @param {number} [filtros.offset] - Offset para paginação
     * @param {string} [filtros.orderBy] - Campo para ordenação (padrão: 'ordem ASC')
     * @returns {Promise<Object>} { success: boolean, data?: Array, message?: string, total?: number }
     */
    async buscarPorFiltros(filtros = {}) {
        try {
            const campos = {
                id: '',
                nome: '',
                ordem: '',
                tipo: '',
                agenteResponde: '',
                descricao: ''
            };

            const condicoes = [];
            const dadosCondicao = {};

            if (filtros.tipo !== undefined && filtros.tipo !== null && filtros.tipo !== '') {
                condicoes.push('tipo = :tipo');
                dadosCondicao.tipo = String(filtros.tipo).trim();
            }

            if (filtros.agenteResponde !== undefined && filtros.agenteResponde !== null && filtros.agenteResponde !== '') {
                condicoes.push('agenteResponde = :agenteResponde');
                dadosCondicao.agenteResponde = String(filtros.agenteResponde).trim();
            }

            const condicao = condicoes.length > 0 ? condicoes.join(' AND ') : '1=1';

            // Ordenação
            let orderBy = 'ordem ASC';
            if (filtros.orderBy && typeof filtros.orderBy === 'string') {
                orderBy = filtros.orderBy;
            }

            // Limite e offset
            let query = ` ORDER BY ${orderBy}`;
            if (filtros.limit !== undefined && filtros.limit > 0) {
                const limit = parseInt(filtros.limit, 10);
                const offset = filtros.offset !== undefined ? parseInt(filtros.offset, 10) : 0;
                query += ` LIMIT ${offset}, ${limit}`;
            }

            const resultados = await this.entidade.select(
                campos,
                this.tabela,
                condicao,
                dadosCondicao,
                query
            );

            const data = Array.isArray(resultados) ? resultados : (resultados ? [resultados] : []);

            return {
                success: true,
                data: data,
                total: data.length,
                message: `${data.length} coluna(s) encontrada(s)`
            };
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao buscar por filtros:', error.message);
            displayError('[ControleMD_agente_kanban_coluna] Stack:', error.stack);
            
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao buscar colunas por filtros', error, {
                filtros: filtros
            }, 'Node.js - ControleMD_agente_kanban_coluna').catch(err => 
                displayError('[ControleMD_agente_kanban_coluna] Erro ao enviar notificação Discord:', err)
            );

            return {
                success: false,
                data: [],
                total: 0,
                message: `Erro ao buscar colunas: ${error.message}`
            };
        }
    }

    /**
     * Busca a primeira coluna onde agenteResponde = 'N' para um tipo específico
     * @param {string} tipo - Tipo do agente
     * @returns {Promise<Object>} { success: boolean, data?: Object, message?: string }
     */
    async buscarPrimeiraColunaAgenteNaoResponde(tipo) {
        try {
            if (!tipo || typeof tipo !== 'string' || tipo.trim() === '') {
                return {
                    success: false,
                    message: 'Tipo é obrigatório e deve ser uma string não vazia'
                };
            }

            const resultado = await this.buscarPorFiltros({
                tipo: tipo.trim(),
                agenteResponde: 'N',
                limit: 1,
                orderBy: 'ordem ASC'
            });

            if (!resultado.success || !resultado.data || resultado.data.length === 0) {
                return {
                    success: false,
                    message: `Nenhuma coluna encontrada para tipo "${tipo}" com agenteResponde = 'N'`
                };
            }

            return {
                success: true,
                data: resultado.data[0],
                message: 'Coluna encontrada com sucesso'
            };
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao buscar primeira coluna agente não responde:', error.message);
            
            return {
                success: false,
                message: `Erro ao buscar coluna: ${error.message}`
            };
        }
    }

    /**
     * Busca todas as colunas de um tipo, ordenadas por ordem
     * @param {string} tipo - Tipo do agente
     * @returns {Promise<Object>} { success: boolean, data?: Array, message?: string }
     */
    async buscarPorTipo(tipo) {
        try {
            if (!tipo || typeof tipo !== 'string' || tipo.trim() === '') {
                return {
                    success: false,
                    data: [],
                    message: 'Tipo é obrigatório e deve ser uma string não vazia'
                };
            }

            return await this.buscarPorFiltros({
                tipo: tipo.trim(),
                orderBy: 'ordem ASC'
            });
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao buscar por tipo:', error.message);
            
            return {
                success: false,
                data: [],
                message: `Erro ao buscar colunas: ${error.message}`
            };
        }
    }

    /**
     * Insere uma nova coluna
     * @param {Object} dados - Dados da coluna
     * @param {string} dados.nome - Nome da coluna
     * @param {number|string} [dados.ordem] - Ordem de exibição
     * @param {string} [dados.tipo] - Tipo da coluna
     * @param {string} [dados.agenteResponde] - Se o agente responde ('S' ou 'N')
     * @param {string} [dados.descricao] - Descrição da coluna
     * @returns {Promise<Object>} { success: boolean, id?: number, message?: string }
     */
    async inserir(dados) {
        try {
            if (!dados.nome || typeof dados.nome !== 'string' || dados.nome.trim() === '') {
                return {
                    success: false,
                    message: 'Nome é obrigatório e deve ser uma string não vazia'
                };
            }

            const dadosInserir = {
                nome: dados.nome.trim()
            };

            // Campos opcionais
            if (dados.ordem !== undefined && dados.ordem !== null && dados.ordem !== '') {
                dadosInserir.ordem = parseInt(dados.ordem, 10);
            }

            if (dados.tipo !== undefined && dados.tipo !== null && dados.tipo !== '') {
                dadosInserir.tipo = String(dados.tipo).trim();
            }

            if (dados.agenteResponde !== undefined && dados.agenteResponde !== null && dados.agenteResponde !== '') {
                dadosInserir.agenteResponde = String(dados.agenteResponde).trim();
            }

            if (dados.descricao !== undefined && dados.descricao !== null && dados.descricao !== '') {
                dadosInserir.descricao = String(dados.descricao).trim();
            }

            const id = await this.entidade.inserir(dadosInserir, this.tabela);

            return {
                success: true,
                id: id,
                message: 'Coluna inserida com sucesso'
            };
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao inserir:', error.message);
            displayError('[ControleMD_agente_kanban_coluna] Stack:', error.stack);
            
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao inserir coluna', error, {
                dados: dados
            }, 'Node.js - ControleMD_agente_kanban_coluna').catch(err => 
                displayError('[ControleMD_agente_kanban_coluna] Erro ao enviar notificação Discord:', err)
            );

            return {
                success: false,
                message: `Erro ao inserir coluna: ${error.message}`
            };
        }
    }

    /**
     * Atualiza uma coluna
     * @param {Object} dadosAtualizar - Dados para atualizar
     * @param {number|string} id - ID da coluna
     * @returns {Promise<Object>} { success: boolean, message?: string }
     */
    async atualizar(dadosAtualizar, id) {
        try {
            if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
                return {
                    success: false,
                    message: 'ID é obrigatório e deve ser um número ou string'
                };
            }

            const idNumero = parseInt(id, 10);
            if (isNaN(idNumero) || idNumero <= 0) {
                return {
                    success: false,
                    message: 'ID deve ser um número maior que zero'
                };
            }

            if (!dadosAtualizar || typeof dadosAtualizar !== 'object' || Object.keys(dadosAtualizar).length === 0) {
                return {
                    success: false,
                    message: 'Dados para atualizar são obrigatórios'
                };
            }

            const condicao = 'id = :id';
            const dadosCondicao = { id: idNumero };

            // Prepara dados para atualizar (converte tipos quando necessário)
            const dadosUpdate = {};
            for (const [key, value] of Object.entries(dadosAtualizar)) {
                if (value !== undefined && value !== null) {
                    if (key === 'ordem') {
                        dadosUpdate[key] = parseInt(value, 10);
                    } else if (['nome', 'tipo', 'agenteResponde', 'descricao'].includes(key)) {
                        dadosUpdate[key] = String(value).trim();
                    } else {
                        dadosUpdate[key] = value;
                    }
                }
            }

            if (Object.keys(dadosUpdate).length === 0) {
                return {
                    success: false,
                    message: 'Nenhum dado válido para atualizar'
                };
            }

            const atualizado = await this.entidade.update(
                dadosUpdate,
                this.tabela,
                condicao,
                dadosCondicao
            );

            if (!atualizado) {
                return {
                    success: false,
                    message: 'Nenhum registro foi atualizado. Verifique se o ID existe.'
                };
            }

            return {
                success: true,
                message: 'Coluna atualizada com sucesso'
            };
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao atualizar:', error.message);
            displayError('[ControleMD_agente_kanban_coluna] Stack:', error.stack);
            
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao atualizar coluna', error, {
                id: id,
                dadosAtualizar: dadosAtualizar
            }, 'Node.js - ControleMD_agente_kanban_coluna').catch(err => 
                displayError('[ControleMD_agente_kanban_coluna] Erro ao enviar notificação Discord:', err)
            );

            return {
                success: false,
                message: `Erro ao atualizar coluna: ${error.message}`
            };
        }
    }

    /**
     * Remove uma coluna (verifica se há cards associados antes de remover)
     * @param {number|string} id - ID da coluna
     * @returns {Promise<Object>} { success: boolean, message?: string }
     */
    async remover(id) {
        try {
            if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
                return {
                    success: false,
                    message: 'ID é obrigatório e deve ser um número ou string'
                };
            }

            const idNumero = parseInt(id, 10);
            if (isNaN(idNumero) || idNumero <= 0) {
                return {
                    success: false,
                    message: 'ID deve ser um número maior que zero'
                };
            }

            // Verifica se há cards usando esta coluna
            const sql = `SELECT COUNT(*) as total FROM agente_kanban_monitoramento WHERE id_coluna = ?`;
            const [rows] = await this.entidade.connection.query(sql, [idNumero]);
            const total = rows && rows[0] ? parseInt(rows[0].total, 10) : 0;

            if (total > 0) {
                return {
                    success: false,
                    message: `Não é possível remover a coluna. Existem ${total} card(s) associado(s) a esta coluna.`
                };
            }

            const condicao = 'id = :id';
            const dadosCondicao = { id: idNumero };

            // Usa delete direto (não há soft delete nesta tabela)
            const sqlDelete = `DELETE FROM ${this.tabela} WHERE ${condicao.replace(':id', '?')}`;
            await this.entidade.connection.query(sqlDelete, [idNumero]);

            return {
                success: true,
                message: 'Coluna removida com sucesso'
            };
        } catch (error) {
            displayError('[ControleMD_agente_kanban_coluna] Erro ao remover:', error.message);
            displayError('[ControleMD_agente_kanban_coluna] Stack:', error.stack);
            
            DiscordNotifier.enviarErro('Chat WhatsApp - Erro ao remover coluna', error, {
                id: id
            }, 'Node.js - ControleMD_agente_kanban_coluna').catch(err => 
                displayError('[ControleMD_agente_kanban_coluna] Erro ao enviar notificação Discord:', err)
            );

            return {
                success: false,
                message: `Erro ao remover coluna: ${error.message}`
            };
        }
    }
}
