// crypto-body.js
import crypto from "crypto";

// chave em base64 (32 bytes)
const KEY_B64 = process.env.BODY_ENC_KEY_B64;
if (!KEY_B64) throw new Error("Defina BODY_ENC_KEY_B64");

const KEY = Buffer.from(KEY_B64, "base64");
if (KEY.length !== 32) {
  throw new Error("A chave precisa ter 32 bytes (base64 de 32 bytes).");
}

export function encryptBodyJson(obj) {
  const iv = crypto.randomBytes(12); // recomendado p/ GCM
  const plaintext = Buffer.from(JSON.stringify(obj), "utf8");

  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  };
}

export function decryptBodyJson(payload) {
  try {
    const { iv, tag, data } = payload || {};
    if (!iv || !tag || !data) {
      throw new Error("Payload inválido: esperado {iv, tag, data}.");
    }

    const ivBuf = Buffer.from(iv, "base64");
    const tagBuf = Buffer.from(tag, "base64");
    const dataBuf = Buffer.from(data, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, ivBuf);
    decipher.setAuthTag(tagBuf);

    const plaintext = Buffer.concat([
      decipher.update(dataBuf),
      decipher.final()
    ]).toString("utf8");

    return JSON.parse(plaintext);
  } catch (error) {
    // Personaliza mensagens de erro comuns
    if (error.message.includes("Unsupported state or unable to authenticate data") || 
        error.message.includes("unable to authenticate data")) {
      throw new Error("Dados criptografados inválidos ou corrompidos. Não foi possível autenticar os dados.");
    }
    
    if (error.message.includes("Invalid IV length")) {
      throw new Error("IV (vetor de inicialização) inválido. Verifique o formato dos dados criptografados.");
    }
    
    if (error.message.includes("Invalid tag length")) {
      throw new Error("Tag de autenticação inválida. Os dados podem ter sido alterados.");
    }
    
    if (error.message.includes("Payload inválido")) {
      throw error; // Mantém a mensagem original
    }
    
    // Outros erros de parsing JSON
    if (error instanceof SyntaxError) {
      throw new Error("Erro ao processar dados descriptografados. Formato JSON inválido.");
    }
    
    // Erro genérico para outros casos
    throw new Error(`Erro ao descriptografar dados: ${error.message}`);
  }
}
