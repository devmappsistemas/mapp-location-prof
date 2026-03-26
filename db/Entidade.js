import { getPoolForDomain, getPoolForMDCLMAPP } from "./dbFactory.js";
import { error as displayError } from "../utils/displayLogWebhook.js";

/**
 * Classe Entidade
 * Gerencia operações de banco de dados de forma genérica
 * Similar ao EntidadePDO do PHP
 */
export class Entidade {
  /**
   * Construtor da classe Entidade
   * @param {Object} db - Objeto contendo as conexões de banco de dados
   * @param {Object} db.dbClient - Pool de conexão do banco cliente (tenant)
   * @param {Object} db.dbMD - Pool de conexão do banco MD_CLMAPP
   */
  constructor(db) {
    if (!db) {
      throw new Error('Objeto db é obrigatório. Use Entidade.create(domain) para criar com domain.');
    }
    this.db = db;
    this.connection = db.dbClient; // Usa dbClient por padrão
  }

  /**
   * Método estático para criar instância com domain
   * Busca automaticamente as conexões usando getPoolForDomain
   * @param {string} domain - Domínio para buscar a conexão
   * @returns {Promise<Entidade>} Instância da classe Entidade
   */
  static async create(domain) {
    if (!domain || typeof domain !== 'string' || domain.trim() === '') {
      throw new Error('Domain é obrigatório e deve ser uma string não vazia');
    }

    let db = null;
    let dbMD = null;

    // Busca pool do domínio
    db = await getPoolForDomain(domain);

    // Sempre busca pool MD
    dbMD = await getPoolForMDCLMAPP();

    const dbObject = {
      dbClient: db,
      dbMD: dbMD
    };

    return new Entidade(dbObject);
  }

  /**
   * Define qual conexão usar (dbClient ou dbMD)
   * @param {string} tipo - 'client' ou 'md'
   */
  setConnection(tipo = 'client') {
    if (!this.db) {
      throw new Error('Conexão não inicializada. Use Entidade.create(domain) para criar com domain.');
    }

    switch (tipo) {
      case 'md':
        this.connection = this.db.dbMD;
        break;

      case 'client':
      default:
        this.connection = this.db.dbClient;
        break;
    }

    return this;
  }

  /**
   * Executa query com retry em ECONNRESET / PROTOCOL_CONNECTION_LOST.
   * Usa getConnection, destroy da conexão com erro e retry com nova conexão.
   * @param {string} sql - SQL da query
   * @param {Array} [valores] - Valores para bind (opcional)
   * @returns {Promise<Array>} [rows, fields] como retorno do mysql2
   */
  async _queryWithRetry(sql, valores = []) {
    const pool = this.connection;
    const hasGetConnection = typeof pool?.getConnection === "function";

    if (!hasGetConnection) {
      return await pool.query(sql, valores);
    }

    let conn = await pool.getConnection();
    try {
      return await conn.query(sql, valores);
    } catch (error) {
      if (error.code === "ECONNRESET" || error.code === "PROTOCOL_CONNECTION_LOST") {
        conn.destroy?.();
        conn = await pool.getConnection();
        return await conn.query(sql, valores);
      }
      throw error;
    } finally {
      conn.release?.();
    }
  }

  /**
   * Prepara condição quando tem o IN na query
   * @param {string} lista - Lista separada por vírgula
   * @param {string} coluna - Nome da coluna do banco
   * @returns {Object} { condIn: string, arrayCond: Object }
   */
  condicaoIN(lista, coluna) {
    const listaIds = lista.split(',').map(item => item.trim()).filter(item => item);
    const arrayCond = {};
    const placeholders = [];

    listaIds.forEach((value, index) => {
      const chave = `:v${index + 1}`;
      placeholders.push(chave);
      arrayCond[chave] = value;
    });

    const condIn = `${coluna} IN (${placeholders.join(',')})`;

    return {
      condIn: condIn,
      arrayCond: arrayCond
    };
  }

  /**
   * SELECT COUNT
   * @param {string} campo - Campo para contar
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE
   * @param {Object} dadosCondicao - Dados para bind
   * @returns {Promise<number>} Número de registros
   */
  async selectCount(campo, tabela, condicao, dadosCondicao = {}) {
    try {
      const sql = `SELECT COUNT(${campo}) as total FROM ${tabela} WHERE ${condicao}`;

      // Substitui placeholders nomeados (:nome) por ? e prepara valores
      let sqlFinal = sql;
      const valores = [];

      if (condicao && condicao.includes(':')) {
        for (const [key, value] of Object.entries(dadosCondicao)) {
          const placeholder = `:${key}`;
          if (sqlFinal.includes(placeholder)) {
            sqlFinal = sqlFinal.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '?');
            valores.push(value);
          }
        }
      } else {
        valores.push(...Object.values(dadosCondicao));
      }

      const [rows] = await this._queryWithRetry(sqlFinal, valores);

      return rows.length > 0 ? parseInt(rows[0].total) : 0;
    } catch (error) {
      displayError('Erro em selectCount:', error.message);
      return 0;
    }
  }

  /**
   * SELECT com múltiplos registros
   * @param {Object|Array} dados - Campos a selecionar ou array de campos
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE
   * @param {Object} dadosCondicao - Dados para bind
   * @returns {Promise<Array>} Array de registros
   */
  async select(dados, tabela, condicao, dadosCondicao = {}) {
    try {
      let colunas = '';

      if (Array.isArray(dados)) {
        colunas = dados.join(', ');
      } else {
        const colunasArray = [];
        for (const [key, value] of Object.entries(dados)) {
          if (key.match(/select/i) || key.match(/DISTINCT/i)) {
            colunasArray.push(key);
          } else {
            colunasArray.push(`${key} AS "${key}"`);
          }
        }
        colunas = colunasArray.join(', ');
      }

      let sql = `SELECT ${colunas} FROM ${tabela}`;
      if (condicao) {
        sql += ` WHERE ${condicao}`;
      }

      // Substitui placeholders nomeados (:nome) por ? e prepara valores
      let sqlFinal = sql;
      const valores = [];

      // Se a condição usa placeholders nomeados (ex: :idExpresso)
      if (condicao && condicao.includes(':')) {
        for (const [key, value] of Object.entries(dadosCondicao)) {
          const placeholder = `:${key}`;
          if (sqlFinal.includes(placeholder)) {
            sqlFinal = sqlFinal.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '?');
            valores.push(value);
          }
        }
      } else {
        // Se usa ? diretamente, apenas pega os valores na ordem
        valores.push(...Object.values(dadosCondicao));
      }

      const [rows] = await this._queryWithRetry(sqlFinal, valores);

      return rows || [];
    } catch (error) {
      displayError('Erro em select:', error.message);
      return [];
    }
  }

  /**
   * SELECT retornando um único registro como array
   * @param {Object|Array} dados - Campos a selecionar
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE
   * @param {Object} dadosCondicao - Dados para bind
   * @returns {Promise<Object>} Registro único
   */
  async selectRetornaArrayUnico(dados, tabela, condicao, dadosCondicao = {}) {
    try {
      let colunas = '';

      if (Array.isArray(dados)) {
        colunas = dados.join(', ');
      } else {
        const colunasArray = [];
        for (const [key, value] of Object.entries(dados)) {
          if (key.match(/select/i) || key.match(/DISTINCT/i)) {
            colunasArray.push(key);
          } else {
            colunasArray.push(`${key} AS "${key}"`);
          }
        }
        colunas = colunasArray.join(', ');
      }

      let sql = `SELECT ${colunas} FROM ${tabela}`;
      if (condicao) {
        sql += ` WHERE ${condicao}`;
      }
      sql += ' LIMIT 1';

      // Substitui placeholders nomeados (:nome) por ? e prepara valores
      // IMPORTANTE: Extrai valores na ordem em que os placeholders aparecem no SQL
      let sqlFinal = sql;
      const valores = [];

      if (condicao && condicao.includes(':')) {
        // Encontra todos os placeholders na ordem em que aparecem no SQL
        const placeholders = condicao.match(/:\w+/g) || [];
        
        for (const placeholder of placeholders) {
          const key = placeholder.substring(1); // Remove o :
          if (dadosCondicao.hasOwnProperty(key)) {
            valores.push(dadosCondicao[key]);
            sqlFinal = sqlFinal.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '?');
          }
        }
      } else {
        valores.push(...Object.values(dadosCondicao));
      }

      const [rows] = await this._queryWithRetry(sqlFinal, valores);

      return rows.length > 0 ? rows[0] : dados;
    } catch (error) {
      displayError('Erro em selectRetornaArrayUnico:', error.message);
      return dados;
    }
  }

  /**
   * SELECT retornando um único valor
   * @param {string} campo - Campo a retornar
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE
   * @param {Object} dadosCondicao - Dados para bind
   * @returns {Promise<any>} Valor único
   */
  async selectRetornaRegistroUnico(campo, tabela, condicao, dadosCondicao = {}) {
    try {
      let sql = `SELECT ${campo} FROM ${tabela}`;
      if (condicao) {
        sql += ` WHERE ${condicao}`;
      }
      sql += ' LIMIT 1';

      // Substitui placeholders nomeados (:nome) por ? e prepara valores
      let sqlFinal = sql;
      const valores = [];

      if (condicao && condicao.includes(':')) {
        for (const [key, value] of Object.entries(dadosCondicao)) {
          const placeholder = `:${key}`;
          if (sqlFinal.includes(placeholder)) {
            sqlFinal = sqlFinal.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '?');
            valores.push(value);
          }
        }
      } else {
        valores.push(...Object.values(dadosCondicao));
      }

      const [rows] = await this._queryWithRetry(sqlFinal, valores);

      return rows.length > 0 ? rows[0][campo] : '';
    } catch (error) {
      displayError('Erro em selectRetornaRegistroUnico:', error.message);
      return '';
    }
  }

  /**
   * SELECT direto sem prepared statements (query direta)
   * @param {string} colunas - Colunas a selecionar
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE
   * @returns {Promise<Array>} Array de registros
   */
  async selectFetchExpresso(colunas, tabela, condicao) {
    try {
      const sql = `SELECT ${colunas} FROM ${tabela} WHERE ${condicao}`;
      const [rows] = await this._queryWithRetry(sql);
      return rows || [];
    } catch (error) {
      displayError('Erro em selectFetchExpresso:', error.message);
      return [];
    }
  }

  /**
   * Executar query/procedure
   * @param {string} sql - SQL a executar
   * @returns {Promise<Array>} Array de resultados
   */
  async executarQueryProcedurePDO(sql) {
    try {
      const [rows] = await this._queryWithRetry(sql);

      // Filtra linhas com msg_error ou totalMsg
      const arrayRetorno = rows.filter(row =>
        !row.hasOwnProperty('msg_error') && !row.hasOwnProperty('totalMsg')
      );

      return arrayRetorno;
    } catch (error) {
      displayError('Erro em executarQueryProcedurePDO:', error.message);
      return [];
    }
  }

  /**
   * INSERT retornando lastInsertId
   * @param {Object} dados - Dados a inserir
   * @param {string} tabela - Nome da tabela
   * @returns {Promise<number>} ID do registro inserido
   */
  async inserir(dados, tabela) {
    try {
      const colunas = Object.keys(dados).join(', ');
      const placeholders = Object.keys(dados).map(() => '?').join(', ');
      const valores = Object.values(dados);

      const sql = `INSERT INTO ${tabela} (${colunas}) VALUES (${placeholders})`;
      const [result] = await this._queryWithRetry(sql, valores);

      return result.insertId || 0;
    } catch (error) {
      displayError('Erro em inserir:', error.message);
      return 0;
    }
  }

  /**
   * INSERT sem retornar ID
   * @param {Object} dados - Dados a inserir
   * @param {string} tabela - Nome da tabela
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async inserirTabelaSemId(dados, tabela) {
    try {
      const colunas = Object.keys(dados).join(', ');
      const placeholders = Object.keys(dados).map(() => '?').join(', ');
      const valores = Object.values(dados);

      const sql = `INSERT INTO ${tabela} (${colunas}) VALUES (${placeholders})`;
      const [result] = await this._queryWithRetry(sql, valores);

      return result.affectedRows > 0;
    } catch (error) {
      displayError('Erro em inserirTabelaSemId:', error.message);
      return false;
    }
  }

  /**
   * UPDATE
   * @param {Object} dados - Dados a atualizar
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE (pode usar ? ou :nome)
   * @param {Object} dadosCondicao - Dados para bind da condição
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async update(dados, tabela, condicao, dadosCondicao = {}) {
    try {
      const sets = Object.keys(dados).map(key => `${key} = ?`).join(', ');
      const valoresDados = Object.values(dados);

      // Substitui placeholders nomeados (:nome) por ? na condição WHERE
      let condicaoFinal = condicao;
      const valoresCondicao = [];

      if (condicao && condicao.includes(':')) {
        for (const [key, value] of Object.entries(dadosCondicao)) {
          const placeholder = `:${key}`;
          if (condicaoFinal.includes(placeholder)) {
            condicaoFinal = condicaoFinal.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '?');
            valoresCondicao.push(value);
          }
        }
      } else {
        // Se usa ? diretamente, apenas pega os valores na ordem
        valoresCondicao.push(...Object.values(dadosCondicao));
      }

      const valores = [...valoresDados, ...valoresCondicao];
      const sql = `UPDATE ${tabela} SET ${sets} WHERE ${condicaoFinal}`;
      const [result] = await this._queryWithRetry(sql, valores);

      return result.affectedRows > 0;
    } catch (error) {
      displayError('Erro em update:', error.message);
      return false;
    }
  }

  /**
   * UPDATE com NULL
   * @param {Object} dados - Dados a atualizar
   * @param {string} tabela - Nome da tabela
   * @param {string} condicao - Condição WHERE (pode usar ? ou :nome)
   * @param {Object} dadosCondicao - Dados para bind da condição (opcional)
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async updateNull(dados, tabela, condicao, dadosCondicao = {}) {
    try {
      const sets = [];

      for (const [key, value] of Object.entries(dados)) {
        if (value === null || value === '' || value === undefined) {
          sets.push(`${key} = NULL`);
        } else {
          sets.push(`${key} = '${value.replace(/'/g, "''")}'`);
        }
      }

      // Substitui placeholders nomeados (:nome) por ? na condição WHERE
      let condicaoFinal = condicao;
      const valoresCondicao = [];

      /**
       * Detecta placeholders nomeados: verifica se a condição contém : (ex: :id, :idExpresso)
       * Se encontrar, substitui por ? e adiciona o valor na lista de valores para bind
       * Prepara valores na ordem: adiciona os valores no array na mesma ordem da substituição
       */
      if (condicao && condicao.includes(':')) {
        for (const [key, value] of Object.entries(dadosCondicao)) {
          const placeholder = `:${key}`;
          if (condicaoFinal.includes(placeholder)) {
            condicaoFinal = condicaoFinal.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '?');
            valoresCondicao.push(value);
          }
        }
      } else {
        // Se usa ? diretamente, apenas pega os valores na ordem
        valoresCondicao.push(...Object.values(dadosCondicao));
      }

      /**
       * Executa com prepared statements: usa ? com os valores no array
       */
      const sql = `UPDATE ${tabela} SET ${sets.join(', ')} WHERE ${condicaoFinal}`;
      const [result] = await this._queryWithRetry(sql, valoresCondicao);

      return result.affectedRows > 0;
    } catch (error) {
      displayError('Erro em updateNull:', error.message);
      return false;
    }
  }

  /**
   * INSERT múltiplos
   * @param {Array<Object>|Object} arrayDados - Array de objetos com dados ou objeto com chaves numéricas
   * @param {string} tabela - Nome da tabela
   * @returns {Promise<boolean>} Sucesso da operação
   */
  async multiplosInsert(arrayDados, tabela) {
    try {
      if (!arrayDados) {
        return false;
      }

      // Converte objeto com chaves numéricas para array se necessário
      let dadosArray = [];
      if (Array.isArray(arrayDados)) {
        dadosArray = arrayDados;
      } else if (typeof arrayDados === 'object') {
        // Converte objeto com chaves numéricas para array
        dadosArray = Object.keys(arrayDados)
          .sort((a, b) => parseInt(a) - parseInt(b))
          .map(key => arrayDados[key]);
      } else {
        return false;
      }

      if (dadosArray.length === 0) {
        return false;
      }

      // Pega as colunas do primeiro objeto
      const colunas = Object.keys(dadosArray[0]).join(', ');

      // Prepara valores usando prepared statements
      const placeholdersArray = [];
      const valoresArray = [];

      dadosArray.forEach(dados => {
        const placeholders = Object.keys(dados).map(() => '?').join(', ');
        placeholdersArray.push(`(${placeholders})`);
        valoresArray.push(...Object.values(dados));
      });

      const sql = `INSERT INTO ${tabela} (${colunas}) VALUES ${placeholdersArray.join(', ')}`;
      const [result] = await this._queryWithRetry(sql, valoresArray);

      return result.affectedRows > 0;
    } catch (error) {
      displayError('Erro em multiplosInsert:', error.message);
      return false;
    }
  }
}

