import fs from "fs";
import path from "path";
import ini from "ini";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import { getSaoPauloISOString } from "../utils/dateHelper.js";
import { log as displayLog } from "../utils/displayLogWebhook.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function domainToIniInfo(domain) {
    const clean = domain.trim().toLowerCase().split(":")[0];

    // Validação mais rigorosa de domínio
    if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(clean)) {
        const error = new Error(`Domínio inválido: '${domain}'. Formato esperado: exemplo.com ou subdominio.exemplo.com`);
        error.code = 'INVALID_DOMAIN';
        throw error;
    }

    let section = clean.split(".")[0];
    if(section === 'localhost') {
        section = 'ts';
    }
    const filename = `${section}bc.ini`;

    return { section, filename };
}

/**
 * Remove aspas se presentes (compatibilidade)
 */
function cleanValue(value) {
    if (typeof value === 'string') {
        return value.trim().replace(/^['"]|['"]$/g, '');
    }
    return value;
}

const JGK_TRANSPORTES_APP_HOST = "jgktransportes.app.br";

function isJgkTransportesAppDomain(domain) {
    const d = (domain || "").trim().toLowerCase().split(":")[0];
    return d === JGK_TRANSPORTES_APP_HOST || d.endsWith("." + JGK_TRANSPORTES_APP_HOST);
}

/** dados2 bruto (sem cleanValue) para jgktransportes.app.br; demais domínios usam cleanValue. */
function databaseFromDados2(rowDados2, domain) {
    if (!isJgkTransportesAppDomain(domain)) {
        return cleanValue(rowDados2);
    }
    if (rowDados2 == null) return rowDados2;
    if (Buffer.isBuffer(rowDados2)) return rowDados2.toString("utf8");
    return rowDados2;
}

/**
 * Carrega configuração do banco central servicodadosbcalguns
 */
async function loadConfigFromCentralDb(domain) {
    const centralIniPath = path.join(__dirname, "..", "configBanco", "servicodadosbcalgunsbc.ini");

    if (!fs.existsSync(centralIniPath)) {
        return null;
    }

    let centralConfig;
    try {
        const fileContent = fs.readFileSync(centralIniPath, "utf-8");
        const parsed = ini.parse(fileContent);

        if (!parsed['servicodadosbcalguns']) {
            return null;
        }

        const cfg = parsed['servicodadosbcalguns'];
        centralConfig = {
            host: cleanValue(cfg.local),
            user: cleanValue(cfg.usuario),
            password: cleanValue(cfg.senha),
            database: cleanValue(cfg.banco)
        };
    } catch (error) {
        return null;
    }

    // Valida configuração central
    for (const [key, value] of Object.entries(centralConfig)) {
        if (!value || value.trim() === '') {
            return null;
        }
    }

    // Conecta ao banco central e busca configuração do domínio
    // Extrai apenas a primeira parte do domínio (ex: logmapp.com.br -> logmapp)
    let domainKey = domain.trim().toLowerCase().split(".")[0];

    // Mapeamento para busca em dados: demonstrativo.logmapp.com.br -> dados1=logmapp1; logmapp.com.br -> dados1=demonstrativo
    if (domainKey === 'demonstrativo') {
        domainKey = 'logmapp1';
    } else if (domainKey === 'logmapp') {
        domainKey = 'demonstrativo';
    } 


    let connection;
    try {
        connection = await mysql.createConnection(centralConfig);
        
        const sql = "SELECT dados1, dados2, dados3, dados4, dados5 FROM dados WHERE dados1 = ?";
        const [rows] = await connection.query(sql, [domainKey]);

        await connection.end();

        if (rows && rows.length > 0) {
            const row = rows[0];
            let host = process.env.NODE_ENV === 'development'
                ? cleanValue('db-internal.appmapp.com.br')
                : cleanValue(row.dados5);
            if (domainKey === 'mototaxionline') {
                host = 'db-internal.appmapp.com.br';
            }
            const config = {
                host,
                user: cleanValue(row.dados3),
                password: cleanValue(row.dados4),
                database: databaseFromDados2(row.dados2, domain)
            };
            // Log quando encontrar no banco central (apenas em desenvolvimento)
            if (process.env.NODE_ENV === 'development') {
                displayLog(`[${getSaoPauloISOString()}] [info] Configuração encontrada no banco central para domínio '${domain}' (chave: '${domainKey}')`);
            }
 
            return config;
        }

        return null;
    } catch (error) {
        if (connection) {
            try {
                await connection.end();
            } catch { }
        }
        // Log erro apenas em desenvolvimento
        if (process.env.NODE_ENV === 'development') {
            displayLog(`[${getSaoPauloISOString()}] [warn] Erro ao buscar configuração no banco central para '${domain}': ${error.message}`);
        }
        return null;
    }
}

export async function loadDbConfigFromIni(domain) {
    // Em desenvolvimento, usa sempre tsbc.ini
    let section, filename, iniPath;
    
    if (process.env.NODE_ENV === 'development') {
        filename = 'tsbc.ini';
        section = 'ts';
        iniPath = path.join(__dirname, "..", "configBanco", filename);
    } else {
        const domainInfo = domainToIniInfo(domain);
        section = domainInfo.section;
        filename = domainInfo.filename;
        iniPath = path.join(__dirname, "..", "configBanco", filename);
    }

    if (!fs.existsSync(iniPath)) {
        // Em desenvolvimento, se tsbc.ini não existir, lança erro
        if (process.env.NODE_ENV === 'development') {
            const error = new Error(`Arquivo de configuração '${filename}' não encontrado para ambiente de desenvolvimento.`);
            error.code = 'CONFIG_FILE_NOT_FOUND';
            throw error;
        }
        
        // Tenta buscar no banco central
        const centralConfig = await loadConfigFromCentralDb(domain);
        if (centralConfig) {
            // Valida valores não vazios
            for (const [key, value] of Object.entries(centralConfig)) {
                if (!value || value.trim() === '') {
                    const error = new Error(`Configuração obtida do banco central está incompleta para o domínio '${domain}'. Campo '${key}' está vazio.`);
                    error.code = 'CONFIG_EMPTY_FIELD';
                    throw error;
                }
            }
            return centralConfig;
        }

        // Se não encontrou no banco central, lança erro
        const error = new Error(`Arquivo de configuração '${filename}' não encontrado para o domínio '${domain}' e também não foi encontrado no banco central.`);
        error.code = 'CONFIG_FILE_NOT_FOUND';
        throw error;
    }

    let parsed;
    try {
        const fileContent = fs.readFileSync(iniPath, "utf-8");
        parsed = ini.parse(fileContent);
    } catch (error) {
        const err = new Error(`Erro ao ler arquivo de configuração '${filename}': ${error.message}`);
        err.code = 'CONFIG_FILE_READ_ERROR';
        throw err;
    }

    if (!parsed[section]) {
        const error = new Error(`Seção '[${section}]' não existe no arquivo '${filename}' para o domínio '${domain}'.`);
        error.code = 'CONFIG_SECTION_NOT_FOUND';
        throw error;
    }

    const cfg = parsed[section];

    // Valida campos obrigatórios
    const requiredFields = ['local', 'usuario', 'senha', 'banco'];
    const missingFields = requiredFields.filter(field => !cfg[field] || cfg[field].trim() === '');

    if (missingFields.length > 0) {
        const error = new Error(`Campos obrigatórios ausentes na seção '[${section}]' do arquivo '${filename}': ${missingFields.join(', ')}`);
        error.code = 'CONFIG_MISSING_FIELDS';
        throw error;
    }

    const config = {
        host: cleanValue(cfg.local),
        user: cleanValue(cfg.usuario),
        password: cleanValue(cfg.senha),
        database: cleanValue(cfg.banco)
    };

    // Valida valores não vazios após limpeza
    for (const [key, value] of Object.entries(config)) {
        if (!value || value.trim() === '') {
            const error = new Error(`Campo '${key}' está vazio na seção '[${section}]' do arquivo '${filename}'.`);
            error.code = 'CONFIG_EMPTY_FIELD';
            throw error;
        }
    }

    if (process.env.NODE_ENV === 'development') {
        config.host = 'db-internal.appmapp.com.br';
    }

    return config;
}

export async function loadDbConfigFromMDIni() {

    const filename = "mdClmappbc.ini";
    const iniPath = path.join(__dirname, "..", "configBanco", filename);

    if (!fs.existsSync(iniPath)) {
        return null;
    }

    let parsed;
    try {
        const fileContent = fs.readFileSync(iniPath, "utf-8");
        parsed = ini.parse(fileContent);
    } catch (error) {
        const err = new Error(`Erro ao ler arquivo de configuração '${filename}': ${error.message}`);
        err.code = 'CONFIG_FILE_READ_ERROR';
        throw err;
    }

    if (!parsed['mdClmapp']) {
        const error = new Error(`Seção '[mdClmapp]' não existe no arquivo '${filename}'.`);
        error.code = 'CONFIG_SECTION_NOT_FOUND';
        throw error;
    }

    const cfg = parsed['mdClmapp'];

    // Valida campos obrigatórios
    const requiredFields = ['local', 'usuario', 'senha', 'banco'];
    const missingFields = requiredFields.filter(field => !cfg[field] || cfg[field].trim() === '');

    if (missingFields.length > 0) {
        const error = new Error(`Campos obrigatórios ausentes na seção '[${section}]' do arquivo '${filename}': ${missingFields.join(', ')}`);
        error.code = 'CONFIG_MISSING_FIELDS';
        throw error;
    }

    const config = {
        host: cleanValue(cfg.local),
        user: cleanValue(cfg.usuario),
        password: cleanValue(cfg.senha),
        database: cleanValue(cfg.banco)
    };

    // Valida valores não vazios após limpeza
    for (const [key, value] of Object.entries(config)) {
        if (!value || value.trim() === '') {
            const error = new Error(`Campo '${key}' está vazio na seção '[${section}]' do arquivo '${filename}'.`);
            error.code = 'CONFIG_EMPTY_FIELD';
            throw error;
        }
    }

    return config;
}
