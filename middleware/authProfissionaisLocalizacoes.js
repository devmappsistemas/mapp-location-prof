import crypto from "crypto";

const ENV_API_KEY = process.env.PROFISSIONAIS_LOCALIZACOES_API_KEY;
const EXPECTED_KEY = typeof ENV_API_KEY === "string" ? ENV_API_KEY.trim() : "";

/**
 * Comparação em tempo constante para reduzir risco de timing attack.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStrings(a, b) {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware de autenticação para POST /api/v1/profissionais-localizacoes.
 * Se PROFISSIONAIS_LOCALIZACOES_API_KEY estiver definida no env, exige que o request
 * traga a mesma chave em Authorization: Bearer <chave> ou X-API-Key: <chave>.
 * Se a chave no env estiver vazia/indefinida, o acesso é liberado.
 */
export function authProfissionaisLocalizacoes(req, res, next) {
  if (!EXPECTED_KEY) {
    return next();
  }

  const authHeader = req.header("Authorization") || req.header("authorization") || "";
  const bearerMatch = /^\s*Bearer\s+(.+)\s*$/i.exec(authHeader);
  const bearerKey = bearerMatch ? bearerMatch[1].trim() : null;

  const apiKeyHeader = req.header("X-API-Key") || req.header("x-api-key") || "";
  const xApiKey = apiKeyHeader ? String(apiKeyHeader).trim() : null;

  const receivedKey = bearerKey || xApiKey;
  if (!receivedKey || !timingSafeEqualStrings(receivedKey, EXPECTED_KEY)) {
    return res.status(401).json({
      error: "Não autorizado",
      message: "Credencial inválida ou ausente."
    });
  }

  next();
}
