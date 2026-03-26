import mysql from "mysql2/promise";
import { loadDbConfigFromIni, loadDbConfigFromMDIni } from "./iniLoader.js";

import { getSaoPauloISOString } from "../utils/dateHelper.js";
import { log as displayLog } from "../utils/displayLogWebhook.js";

/**
 * Configurações (podem ser sobrescritas por variáveis de ambiente)
 */
const TTL_MS = parseInt(process.env.POOL_TTL_MS) || 30 * 60 * 1000;          // 30 minutos
const CLEANUP_INTERVAL_MS = parseInt(process.env.CLEANUP_INTERVAL_MS) || 5 * 60 * 1000;
const CONNECTION_LIMIT = parseInt(process.env.CONNECTION_LIMIT) || 10;
// Nota: ACQUIRE_TIMEOUT e QUERY_TIMEOUT não são mais usados diretamente no pool
// O mysql2 não suporta essas opções. Timeouts são gerenciados pelo próprio mysql2
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS) || 1000;

/**
 * Logging simples
 */
function log(level, message, data = {}) {
  const timestamp = getSaoPauloISOString();
  const logData = data && Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : '';
  displayLog(`[${timestamp}] [${level}] ${message}${logData}`);
}

/**
 * Cache:
 * key -> { pool, lastUsedAt }
 */
const poolCache = new Map();

/**
 * Evita criação duplicada de pool
 * key -> Promise<Pool>
 */
const creating = new Map();

/**
 * Normaliza e valida domínio
 */
function normalizeDomain(domain) {
  if (!domain || typeof domain !== "string") return "";
  const normalized = domain.trim().toLowerCase().split(":")[0];
  
  // Validação mais rigorosa de domínio
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(normalized)) {
    return "";
  }
  
  return normalized;
}

/**
 * Retry com backoff exponencial
 */
async function retryWithBackoff(fn, maxRetries = MAX_RETRIES, delay = RETRY_DELAY_MS) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // Não retry em erros de autenticação ou configuração
      if (error.code === 'ER_ACCESS_DENIED_ERROR' || 
          error.code === 'ER_BAD_DB_ERROR' ||
          error.code === 'ENOTFOUND' ||
          error.message?.includes('não encontrado') ||
          error.message?.includes('não existe')) {
        throw error;
      }
      
      if (attempt < maxRetries) {
        const waitTime = delay * Math.pow(2, attempt - 1);
        log('warn', `Tentativa ${attempt}/${maxRetries} falhou, tentando novamente em ${waitTime}ms`, {
          error: error.message,
          code: error.code
        });
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }
  }
  
  throw lastError;
}

/**
 * Valida configuração do banco
 */
async function validateDatabaseConfig(pool, database) {
  try {
    // Verifica se a conexão funciona
    await pool.query("SELECT 1");
    
    // Verifica se o banco existe e está acessível
    const [dbCheck] = await pool.query("SELECT SCHEMA_NAME FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = ?", [database]);
    if (dbCheck.length === 0) {
      throw new Error(`Banco de dados '${database}' não existe ou não está acessível.`);
    }
    
    // Verifica permissões básicas
    await pool.query("SELECT 1 FROM INFORMATION_SCHEMA.TABLES LIMIT 1");
    
    //log('info', 'Configuração do banco validada com sucesso', { database });
  } catch (error) {
    log('error', 'Falha na validação do banco', { database, error: error.message, code: error.code });
    throw error;
  }
}


/**
 * Cria pool MySQL com retry
 */
async function createPool(domain) {
  return retryWithBackoff(async () => {
    const cfg = await loadDbConfigFromIni(domain);
    
    //log('info', 'Criando pool de conexões', { domain, host: cfg.host, database: cfg.database });

    const pool = mysql.createPool({
      ...cfg,
      charset: "utf8mb4",
      waitForConnections: true,
      connectionLimit: CONNECTION_LIMIT,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
      dateStrings: true,
      timezone: process.env.DB_TIMEZONE || "-03:00"
      // Nota: acquireTimeout e timeout não são opções válidas do mysql2
      // O mysql2 gerencia timeouts internamente através de suas próprias configurações
    });

    // Valida configuração do banco
    await validateDatabaseConfig(pool, cfg.database);
    
    //log('info', 'Pool criado com sucesso', { domain });
    return pool;
  });
}

/**
 * Cria pool MD_CLMAPP MySQL com retry
 */
async function createPoolMD() {
    return retryWithBackoff(async () => {
      const cfg = await loadDbConfigFromMDIni();
      
      //log('info', 'Criando pool de conexões MD_CLMAPP', {  host: cfg.host, database: cfg.database });
  
      const pool = mysql.createPool({
        ...cfg,
        charset: "utf8mb4",
        waitForConnections: true,
        connectionLimit: CONNECTION_LIMIT,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        dateStrings: true,
        timezone: process.env.DB_TIMEZONE || "-03:00"
        // Nota: acquireTimeout e timeout não são opções válidas do mysql2
        // O mysql2 gerencia timeouts internamente através de suas próprias configurações
      });
  
      // Valida configuração do banco
      await validateDatabaseConfig(pool, cfg.database);
      
      //log('info', 'Pool criado com sucesso', {database: cfg.database});
      return pool;
    });
  }

/**
 * Obtém pool por domínio
 */
export async function getPoolForDomain(domain) {
  const key = normalizeDomain(domain);
  if (!key) {
    const error = new Error("Domínio inválido. Formato esperado: exemplo.com ou subdominio.exemplo.com");
    error.code = 'INVALID_DOMAIN';
    throw error;
  }

  // pool já existente
  const cached = poolCache.get(key);
  //log('info', `poolCache ao cached: ${key} `, cached ? 'true' : 'false');

  if (cached) {
    cached.lastUsedAt = Date.now();
    //log('info', 'Pool reutilizado do cache', { domain: key });
    return cached.pool;
  }

  // pool em criação
  if (creating.has(key)) {
    //log('info', 'Aguardando pool em criação', { domain: key });
    const pool = await creating.get(key);
    const item = poolCache.get(key);
    if (item) item.lastUsedAt = Date.now();
    return pool;
  }

  // cria novo pool
  const creationPromise = (async () => {
    try {
      const pool = await createPool(key);
      poolCache.set(key, { pool, lastUsedAt: Date.now() });
      //log('info', 'Novo pool adicionado ao cache', { domain: key, cacheSize: poolCache.size });
      return pool;
    } catch (error) {
      log('error', 'Erro ao criar pool', { domain: key, error: error.message, code: error.code });
      
      // Melhora mensagens de erro
      if (error.code === 'ER_ACCESS_DENIED_ERROR') {
        error.message = `Credenciais inválidas para o domínio '${key}'. Verifique usuário e senha.`;
      } else if (error.code === 'ER_BAD_DB_ERROR') {
        error.message = `Banco de dados não encontrado para o domínio '${key}'.`;
      } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        error.message = `Não foi possível conectar ao servidor de banco de dados para '${key}'. Verifique o host e a porta.`;
      } else if (error.message?.includes('não encontrado')) {
        // Mantém mensagem do iniLoader
      } else {
        error.message = `Erro ao conectar ao banco de dados para '${key}': ${error.message}`;
      }
      
      throw error;
    } finally {
      creating.delete(key);
    }
  })();

  creating.set(key, creationPromise);
  return creationPromise;
}

/**
 * Obtém pool MD_CLMAPP 
 */
export async function getPoolForMDCLMAPP() {
    
    const key = 'mdClmapp';
    // pool já existente
    const cached = poolCache.get(key);
    if (cached) {
      cached.lastUsedAt = Date.now();
      //log('debug', 'Pool reutilizado do cache', { database: key });
      return cached.pool;
    }
  
    // pool em criação
    if (creating.has(key)) {
      //log('debug', 'Aguardando pool em criação', { database: key });
      const pool = await creating.get(key);
      const item = poolCache.get(key);
      if (item) item.lastUsedAt = Date.now();
      return pool;
    }
  
    // cria novo pool
    const creationPromise = (async () => {
      try {
        const pool = await createPoolMD();
        poolCache.set(key, { pool, lastUsedAt: Date.now() });
        //log('info', 'Novo pool adicionado ao cache', { database: key, cacheSize: poolCache.size });
        return pool;
      } catch (error) {
        log('error', 'Erro ao criar pool', { database: key, error: error.message, code: error.code });
        
        // Melhora mensagens de erro
        if (error.code === 'ER_ACCESS_DENIED_ERROR') {
          error.message = `Credenciais inválidas para o database '${key}'. Verifique usuário e senha.`;
        } else if (error.code === 'ER_BAD_DB_ERROR') {
          error.message = `Banco de dados não encontrado para o database '${key}'.`;
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          error.message = `Não foi possível conectar ao servidor de banco de dados para '${key}'. Verifique o host e a porta.`;
        } else if (error.message?.includes('não encontrado')) {
          // Mantém mensagem do iniLoader
        } else {
          error.message = `Erro ao conectar ao banco de dados para '${key}': ${error.message}`;
        }
        
        throw error;
      } finally {
        creating.delete(key);
      }
    })();
  
    creating.set(key, creationPromise);
    return creationPromise;
  }

/**
 * Limpa pools expirados
 */
async function cleanupExpiredPools() {
  const now = Date.now();
  let closedCount = 0;

  for (const [key, item] of poolCache.entries()) {
    if (now - item.lastUsedAt > TTL_MS) {
      poolCache.delete(key);
      try {
        await item.pool.end();
        closedCount++;
        log('info', 'Pool expirado fechado', { domain: key });
      } catch (error) {
        log('warn', 'Erro ao fechar pool expirado', { domain: key, error: error.message });
      }
    }
  }
  
  if (closedCount > 0) {
    log('info', 'Limpeza de pools concluída', { closedCount, remainingPools: poolCache.size });
  }
}

/**
 * Fecha todos os pools
 */
export async function closeAllPools() {
  const pools = [...poolCache.values()].map(v => v.pool);
  const poolCount = pools.length;
  poolCache.clear();

  log('info', 'Fechando todos os pools', { poolCount });
  
  for (const pool of pools) {
    try {
      await pool.end();
    } catch (error) {
      log('warn', 'Erro ao fechar pool', { error: error.message });
    }
  }
  
  log('info', 'Todos os pools foram fechados');
}

/**
 * Limpeza periódica
 */
const cleanupTimer = setInterval(() => {
  cleanupExpiredPools().catch(() => {});
}, CLEANUP_INTERVAL_MS);

// permite encerrar processo normalmente
cleanupTimer.unref?.();

/**
 * Shutdown elegante
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log('info', `Recebido sinal ${signal}, iniciando shutdown elegante...`);
  clearInterval(cleanupTimer);
  await closeAllPools();
  log('info', 'Shutdown concluído');
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);