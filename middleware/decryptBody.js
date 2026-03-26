import { decryptBodyJson } from "../utils/crypto-body.js";
import { log as displayLog } from "../utils/displayLogWebhook.js";

/**
 * Middleware para descriptografar o body da requisição automaticamente
 * OBRIGATÓRIO: Todas as requisições (incluindo GET) que tiverem body
 * devem ter a estrutura criptografada (iv, tag, data)
 * Se não tiver, retorna erro 400
 */
export function decryptBody(req, res, next) {
  try {
    // Verifica se há body na requisição
    const hasBody = req.body && Object.keys(req.body).length > 0;
    
    if (!hasBody) {
      // Se não houver body, continua normalmente
      //return next();
      throw new Error("Body obrigatório");
    }

    // Se houver body, DEVE estar criptografado (incluindo GET requests)
    const { iv, tag, data } = req.body;
    
    // Valida se tem TODOS os campos obrigatórios de criptografia
    // Verifica se são strings não vazias
    const hasIv = iv && typeof iv === 'string' && iv.trim().length > 0;
    const hasTag = tag && typeof tag === 'string' && tag.trim().length > 0;
    const hasData = data && typeof data === 'string' && data.trim().length > 0;
    const hasEncryptionFields = hasIv && hasTag && hasData;
    
    // Se não tiver os campos de criptografia, retorna erro
    if (!hasEncryptionFields) {
      // Log para debug (apenas em desenvolvimento)
      if (process.env.NODE_ENV === 'development') {
        displayLog('[decryptBody] Body recebido sem criptografia válida:', {
          method: req.method,
          url: req.url,
          hasBody: true,
          bodyKeys: Object.keys(req.body),
          bodyContent: JSON.stringify(req.body).substring(0, 200),
          hasIv,
          hasTag,
          hasData
        });
      }
      
      return res.status(400).json({
        error: "Body da requisição deve estar criptografado",
        message: "O body deve conter os campos: iv, tag, data. Formato esperado: { alg: 'A256GCM', iv: '...', tag: '...', data: '...' }",
        code: "BODY_NOT_ENCRYPTED"
      });
    }

    // Descriptografa o body
    const decryptedBody = decryptBodyJson(req.body);
    
    // Substitui req.body pelo conteúdo descriptografado
    req.body = decryptedBody;
    
    // Continua para o próximo middleware/rota
    next();
  } catch (error) {
    // Retorna erro de descriptografia
    return res.status(400).json({
      error: "Erro ao descriptografar dados da requisição",
      message: error.message,
      code: error.code || "DECRYPTION_ERROR"
    });
  }
}

