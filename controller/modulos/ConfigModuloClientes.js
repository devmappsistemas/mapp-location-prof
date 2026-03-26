import { Entidade } from "../../db/Entidade.js";
import { getPoolForDomain } from "../../db/dbFactory.js";
import { error as displayError } from "../../utils/displayLogWebhook.js";

/**
 * Classe ConfigModuloClientes
 * Gerencia operações relacionadas a configuração de módulos de clientes
 */
export class ConfigModuloClientes {
    /**
     * Construtor da classe ConfigModuloClientes
     * Busca automaticamente os domínios ativos do endpoint externo
     */
    constructor() {
        this.domains = [];
        this.bearerToken = 'RMshsfdebgtFTtJYVC8465465J6Cjpq6E789323uwN2JzxVynKdgiPu464ca83cda2a19';
        this.endpointUrl = 'https://mappsistemas.com/caixa/pClientes/ajaxBuscarListaDominioAtivoCliente.php';
    }

    /**
     * Busca lista de domínios ativos do endpoint externo
     * @returns {Promise<Array>} Array de domínios ativos
     */
    async buscarDominiosAtivos() {
        try {
            const response = await fetch(this.endpointUrl, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${this.bearerToken}`,
                    'Content-Type': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Erro ao buscar domínios: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();
            
            // O retorno é um array direto de strings (domínios)
            // Exemplo: ["logmapp.com.br", "heldtransportes.com", ...]
            if (Array.isArray(data)) {
                // Filtra apenas strings válidas (domínios)
                this.domains = data.filter(domain => 
                    typeof domain === 'string' && domain.trim().length > 0
                );
            } else {
                // Fallback caso o formato seja diferente
                this.domains = data.domains || data.dominios || [];
            }
            
            return this.domains;
        } catch (error) {
            displayError('Erro ao buscar domínios ativos:', error.message);
            this.domains = [];
            return [];
        }
    }

    /**
     * Busca configuração de módulos de clientes para múltiplos domínios
     * Utiliza os domínios obtidos automaticamente do endpoint externo
     * @returns {Promise<Map>} Map com as configurações encontradas por domínio
     */
    async buscarConfigModuloMsgConfigApp() {
        // Busca os domínios se ainda não foram carregados
        if (!this.domains || this.domains.length === 0) {
            await this.buscarDominiosAtivos();
        }

        // Se não houver domínios, retorna Map vazio
        if (!this.domains || this.domains.length === 0) {
            const resultados = new Map();
            return resultados;
        }

        const resultados = new Map();

        const dados = {
            id: '',
            texto: ''
        };

        const condicao = ' identificacao = :identificacao';

        const dadosCondicao = {
            identificacao: "msgConfigApp",
        };

        // Usa for...of ao invés de forEach para suportar async/await
        for (const domain of this.domains) {
            try {
                const pool = await getPoolForDomain(domain);
                
                // Cria objeto db no formato esperado pelo Entidade
                const db = {
                    dbClient: pool,
                    dbMD: null
                };
                
                let entidade = new Entidade(db);

                let resultado = await entidade.selectRetornaArrayUnico(dados, 'mensagem', condicao, dadosCondicao);

                if (resultado?.id > 0 && resultado?.texto !== '') {
                    let configModulo = JSON.parse(resultado.texto);

                    if (configModulo?.ativo === 'S') {
                        resultados.set(domain, {
                            ativo: true,
                            config: configModulo
                        });
                    }
                }

            } catch (error) {
                displayError(`Erro ao buscar configuração para domínio ${domain}:`, error.message);
                // Continua com os próximos domínios mesmo se um falhar
            }
        }

        return resultados;
    }

    /**
     * Busca msgConfigApp + moduloAppConfig para um único domínio.
     * Uso: na rota do cheguei e em outros consumidores por domínio.
     *
     * @param {string} domain - Domínio do tenant (ex.: "logmapp.com.br")
     * @returns {Promise<{ msgConfigApp: Object|null, moduloAppConfig: Object|null }>}
     */
    static async buscarConfigPorDomain(domain) {
        const result = { msgConfigApp: null, moduloAppConfig: null };

        try {
            const pool = await getPoolForDomain(domain);
            const db = { dbClient: pool, dbMD: null };
            const entidade = new Entidade(db);

            const [msgRow, moduloRow] = await Promise.all([
                entidade.selectRetornaArrayUnico(
                    { id: '', texto: '' },
                    'mensagem',
                    'identificacao = :identificacao',
                    { identificacao: 'msgConfigApp' }
                ),
                entidade.selectRetornaArrayUnico(
                    { id: '', ativo: '', arrayConfiguracoes: '' },
                    'modulos',
                    'sigla = :sigla',
                    { sigla: 'appConfig' }
                ),
            ]);

            if (msgRow?.id > 0 && msgRow?.texto) {
                try {
                    result.msgConfigApp = JSON.parse(msgRow.texto);
                } catch { /* JSON inválido — mantém null */ }
            }

            if (moduloRow?.id > 0) {
                let arrayConf = null;
                if (moduloRow.arrayConfiguracoes) {
                    try { arrayConf = JSON.parse(moduloRow.arrayConfiguracoes); } catch { /* ignora */ }
                }
                result.moduloAppConfig = {
                    id: moduloRow.id,
                    ativo: moduloRow.ativo,
                    arrayConfiguracoes: arrayConf,
                };
            }
        } catch (error) {
            displayError(`[buscarConfigPorDomain] Erro para domínio ${domain}:`, error.message);
        }

        return result;
    }

    /**
     * Recupera o fuso horário do cliente pelo domínio (espelha recuperaFusoHorarioAPILumen / buscarFusoHorario do PHP).
     * Consulta a tabela modulos, sigla = 'FUSOHCLIENTE'; se arrayConfiguracoes estiver preenchido, usa como timezone; senão, default America/Sao_Paulo.
     *
     * @param {string} domain - Domínio do tenant (ex.: "logmapp.com.br")
     * @returns {Promise<string>} Timezone IANA (ex.: 'America/Sao_Paulo', 'America/Fortaleza')
     */
    static async buscarFusoHorarioPorDomain(domain) {
        const defaultFuso = "America/Sao_Paulo";
        try {
            const pool = await getPoolForDomain(domain);
            const db = { dbClient: pool, dbMD: null };
            const entidade = new Entidade(db);
            const row = await entidade.selectRetornaArrayUnico(
                { id: "", arrayConfiguracoes: "" },
                "modulos",
                "sigla = :sigla",
                { sigla: "FUSOHCLIENTE" }
            );
            if (row?.arrayConfiguracoes && String(row.arrayConfiguracoes).trim() !== "") {
                return String(row.arrayConfiguracoes).trim();
            }
        } catch (error) {
            displayError("[buscarFusoHorarioPorDomain] Erro para domínio " + domain + ":", error.message);
        }
        return defaultFuso;
    }

}