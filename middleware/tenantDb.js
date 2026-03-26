import { getPoolForDomain, getPoolForMDCLMAPP } from "../db/dbFactory.js";
import { log as displayLog } from "../utils/displayLogWebhook.js";

/**
 * Mapeia códigos de erro para status HTTP apropriados
 */
function getHttpStatusFromError(error) {
  const errorCode = error.code || '';

  // Erros de configuração/cliente
  if (errorCode === 'INVALID_DOMAIN' ||
    errorCode === 'CONFIG_FILE_NOT_FOUND' ||
    errorCode === 'CONFIG_SECTION_NOT_FOUND' ||
    errorCode === 'CONFIG_MISSING_FIELDS' ||
    errorCode === 'CONFIG_EMPTY_FIELD' ||
    errorCode === 'CONFIG_FILE_READ_ERROR') {
    return 400; // Bad Request
  }

  // Erros de autenticação
  if (errorCode === 'ER_ACCESS_DENIED_ERROR') {
    return 401; // Unauthorized
  }

  // Banco não encontrado
  if (errorCode === 'ER_BAD_DB_ERROR') {
    return 404; // Not Found
  }

  // Erros de conexão/timeout
  if (errorCode === 'ECONNREFUSED' ||
    errorCode === 'ETIMEDOUT' ||
    errorCode === 'ENOTFOUND') {
    return 503; // Service Unavailable
  }

  // Outros erros
  return 500; // Internal Server Error
}

export async function tenantDb(req, res, next) {
  try {
    const fullUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
    displayLog(fullUrl);
    displayLog("Método:", req.method);
    const domain = req.header("X-Domain") || req.header("x-domain");

    let db = null;
    let dbMD = null;
    if (domain) {
      db = await getPoolForDomain(domain);
    }
    dbMD = await getPoolForMDCLMAPP();

    req.db = {
      dbClient: db,
      dbMD: dbMD
    }
    req.tenantDomain = domain;
    next();
  } catch (err) {
    const status = getHttpStatusFromError(err);
    const response = {
      error: err.message,
      code: err.code || 'UNKNOWN_ERROR'
    };

    // Adiciona detalhes adicionais em desenvolvimento
    if (process.env.NODE_ENV === 'development') {
      response.stack = err.stack;
    }

    res.status(status).json(response);
  }
}
