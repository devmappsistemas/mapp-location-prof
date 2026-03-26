import { Entidade } from "../db/Entidade.js";
import { error as displayError } from "../utils/displayLogWebhook.js";

/**
 * Classe Solicitante
 * Gerencia operações relacionadas a solicitantes
 */
export class Solicitante {
    /**
     * Construtor da classe Solicitante
     * @param {Object} db - Objeto contendo as conexões de banco de dados
     * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
     * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
     */
    constructor(db) {
        this.db = db;
        this.entidade = new Entidade(db);
    }

    /**
     * Busca solicitantes no banco de dados
     * @returns {Promise<Array>} Array com os solicitantes encontrados
     */
    async buscarSolicitante() {
        const dados = {
            id: '',
            nome: '',
            nomeFantasia: '',
            empresa: '',
            email: ''
        };

        const condicao = 'idExpresso = :idExpresso AND (status IS NULL OR status <> :status) LIMIT 15';
        const dadosCondicao = {
            idExpresso: 9,
            status: 'E'
        };

        const resultados = await this.entidade.select(dados, 'solicitante', condicao, dadosCondicao);


        return resultados;
    }

    /**
    * Busca solicitantes no banco de dados
    * @returns {Promise<Array>} Array com os solicitantes encontrados
    */
    async buscarQtdSolicitante() {

        const condicao = 'idExpresso = :idExpresso AND (status IS NULL OR status <> :status) ';

        const dadosCondicao = {
            idExpresso: 9,
            status: 'E'
        };

        const resultados = await this.entidade.selectCount('id', 'solicitante', condicao, dadosCondicao);

        return resultados;
    }

    /**
    * Busca solicitantes no banco de dados
    * @returns {Promise<Array>} Array com os solicitantes encontrados
    */
    async buscarSolicitanteUnico(idSolicitante) {
        const dados = {
            id: '',
            nome: '',
            nomeFantasia: '',
            empresa: '',
            email: ''
        };

        const condicao = ' id = :id';
        const dadosCondicao = {
            id: idSolicitante,
        };

        const resultados = await this.entidade.selectRetornaArrayUnico(dados, 'solicitante', condicao, dadosCondicao);

        return resultados;

    }

    /**
   * Busca solicitantes no banco de dados
   * @returns {Promise<Array>} Array com os solicitantes encontrados
   */
    async buscarSolicitanteCampoUnico(campo, idSolicitante) {

        const condicao = ' id = :id';
        const dadosCondicao = {
            id: idSolicitante,
        };

        const resultados = await this.entidade.selectRetornaRegistroUnico(campo, 'solicitante', condicao, dadosCondicao);

        return resultados;
    }

    /**
 * Busca solicitantes no banco de dados
 * @returns {Promise<Array>} Array com os solicitantes encontrados
 */
    async buscarSolicitanteFetchExpresso(idSolicitante) {
        const colunas = 'id, nome, nomeFantasia, empresa, email';
        const condicao = ` id = ${idSolicitante}`;

        const resultados = await this.entidade.selectFetchExpresso(colunas, 'solicitante', condicao);

        return resultados;
    }

    async atualizarSolicitante(idSolicitante, dados) {

        const condicao = ' id = :id';
        const dadosCondicao = {
            id: idSolicitante,
        };

        const resultados = await this.entidade.update(dados, 'solicitante', condicao, dadosCondicao);

        return resultados;
    }

    async atualizarSolicitanteNull(idSolicitante, dados) {

        const condicao = ' id = :id';
        const dadosCondicao = {
            id: idSolicitante,
        };

        const resultados = await this.entidade.updateNull(dados, 'solicitante', condicao, dadosCondicao);

        return resultados;
    }

    async inserirSolicitante(dados) {   

        const resultados = await this.entidade.inserir(dados, 'solicitante');

        return resultados;
    }

    async inserirSolicitanteTabelaSemId(dados) {   

        const resultados = await this.entidade.inserirTabelaSemId(dados, 'solicitante');

        return resultados;
    }

    async inserirSolicitanteMultiplos(listaDados) {   

        const resultados = await this.entidade.multiplosInsert(listaDados, 'solicitante');

        return resultados;
    }

    /**
     * Busca endereços corrigidos usando busca full-text (MATCH...AGAINST)
     * Usa a conexão MD (banco MD_CLMAPP) através da classe Entidade
     * @param {string} termosBusca - Termos de busca (ex: "Rua dos tupis 123 Belo")
     * @returns {Promise<Array>} Array com os endereços encontrados
     */
    async buscarEnderecosCorrigidos(termosBusca) {
        try {
            // Prepara termos para busca BOOLEAN MODE
            // Adiciona + antes de cada palavra para busca obrigatória
            const termosFormatados = termosBusca
                .trim()
                .split(/\s+/)
                .filter(termo => termo.length > 0)
                .map(termo => `+${termo}`)
                .join(' ');

            // Configura Entidade para usar conexão MD
            const entidadeMD = new Entidade(this.db);
            entidadeMD.setConnection('md');


            // Usa selectFetchExpresso para query customizada com MATCH...AGAINST
            const condicao = `MATCH(endereco_corrigido) AGAINST ('${termosFormatados.replace(/'/g, "''")}' IN BOOLEAN MODE)`;
            const colunas = 'id, endereco_antigo, endereco_corrigido';

            const resultados = await entidadeMD.selectFetchExpresso(colunas, 'enderecos_corrigidos', condicao);

            return resultados;
        } catch (error) {
            displayError('Erro ao buscar endereços corrigidos:', error.message);
            throw error;
        }
    }

}

