import fs from "fs";
import path from "path";
import { Storage } from "@google-cloud/storage";
import { log as displayLog, warn as displayWarn } from "./displayLogWebhook.js";

const CDN_DIRECT_UPLOAD_ENABLED = String(process.env.CDN_DIRECT_UPLOAD_ENABLED || "false").toLowerCase() === "true";
const CDN_DIRECT_UPLOAD_FALLBACK_PHP = String(process.env.CDN_DIRECT_UPLOAD_FALLBACK_PHP || "true").toLowerCase() === "true";
const CDN_GCS_BUCKET = process.env.CDN_GCS_BUCKET || "";
const CDN_GCS_PROJECT_ID = process.env.CDN_GCS_PROJECT_ID || "";
const CDN_GCS_KEYFILE = process.env.CDN_GCS_KEYFILE || "";
const CDN_GCS_PREFIX = (process.env.CDN_GCS_PREFIX || "").trim().replace(/^\/+|\/+$/g, "");
const CDN_GCS_PUBLIC_BASE_URL = (process.env.CDN_GCS_PUBLIC_BASE_URL || "").trim().replace(/\/+$/g, "");

let storageInstance = null;

function getStorageClient() {
  if (storageInstance) return storageInstance;

  const storageConfig = {};
  if (CDN_GCS_PROJECT_ID) storageConfig.projectId = CDN_GCS_PROJECT_ID;

  if (CDN_GCS_KEYFILE) {
    const keyfileResolved = path.resolve(CDN_GCS_KEYFILE);
    if (!fs.existsSync(keyfileResolved)) {
      throw new Error(`CDN_GCS_KEYFILE não encontrado: ${keyfileResolved}`);
    }
    storageConfig.keyFilename = keyfileResolved;
  }

  storageInstance = Object.keys(storageConfig).length > 0
    ? new Storage(storageConfig)
    : new Storage();
  return storageInstance;
}

function sanitizeFileName(fileName) {
  const safeName = String(fileName || "").trim() || `arquivo_${Date.now()}`;
  return safeName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_");
}

function buildObjectName(fileName) {
  const safeName = sanitizeFileName(fileName);
  if (!CDN_GCS_PREFIX) return safeName;
  return `${CDN_GCS_PREFIX}/${safeName}`.replace(/\/{2,}/g, "/");
}

function buildPublicUrl(bucket, objectName) {
  if (CDN_GCS_PUBLIC_BASE_URL) return `${CDN_GCS_PUBLIC_BASE_URL}/${objectName}`;
  return `https://storage.googleapis.com/${bucket}/${objectName}`;
}

export function isDirectUploadEnabled() {
  return CDN_DIRECT_UPLOAD_ENABLED;
}

export function canFallbackToPhp() {
  return CDN_DIRECT_UPLOAD_FALLBACK_PHP;
}

export async function uploadBufferDiretoCDN({ buffer, mimeType, fileName }) {
  if (!CDN_DIRECT_UPLOAD_ENABLED) {
    throw new Error("CDN direto desabilitado (CDN_DIRECT_UPLOAD_ENABLED=false)");
  }
  if (!CDN_GCS_BUCKET) {
    throw new Error("CDN_GCS_BUCKET não configurado");
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Buffer inválido para upload direto no CDN");
  }

  const storage = getStorageClient();
  const objectName = buildObjectName(fileName);
  const bucket = storage.bucket(CDN_GCS_BUCKET);
  const file = bucket.file(objectName);

  await file.save(buffer, {
    resumable: false,
    predefinedAcl: "publicRead",
    contentType: mimeType || "application/octet-stream",
    metadata: { cacheControl: "public, max-age=31536000" }
  });

  const publicUrl = buildPublicUrl(CDN_GCS_BUCKET, objectName);
  displayLog(`[cdnUploader] Upload direto concluído: ${publicUrl}`);
  return publicUrl;
}

export async function uploadFileDiretoCDN({ filePath, mimeType, fileName }) {
  if (!CDN_DIRECT_UPLOAD_ENABLED) {
    throw new Error("CDN direto desabilitado (CDN_DIRECT_UPLOAD_ENABLED=false)");
  }
  if (!CDN_GCS_BUCKET) {
    throw new Error("CDN_GCS_BUCKET não configurado");
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`Arquivo para upload não encontrado: ${filePath}`);
  }

  const storage = getStorageClient();
  const objectName = buildObjectName(fileName);
  const bucket = storage.bucket(CDN_GCS_BUCKET);
  const file = bucket.file(objectName);

  await new Promise((resolve, reject) => {
    const readStream = fs.createReadStream(filePath);
    const writeStream = file.createWriteStream({
      resumable: true,
      contentType: mimeType || "application/octet-stream",
      predefinedAcl: "publicRead",
      metadata: { cacheControl: "public, max-age=31536000" }
    });

    readStream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    readStream.pipe(writeStream);
  });

  const publicUrl = buildPublicUrl(CDN_GCS_BUCKET, objectName);
  displayLog(`[cdnUploader] Upload direto via stream concluído: ${publicUrl}`);
  return publicUrl;
}

export async function uploadBase64ViaPhp({ base64, tipoMime, nomeArquivo, tipoArquivo, phpUrl }) {
  if (!phpUrl) {
    throw new Error("CDN_PHP_URL não configurada para fallback");
  }

  const payload = { base64, tipoMime, nomeArquivo, tipoArquivo };
  const response = await fetch(phpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const responseContentType = response.headers.get("content-type") || "";
  if (!responseContentType.includes("application/json")) {
    const responseText = await response.text();
    throw new Error(`CDN PHP retornou conteúdo inválido (${response.status}): ${responseText.slice(0, 200)}`);
  }

  const json = await response.json();
  if (!response.ok || !json?.sucesso || !json?.link) {
    const mensagem = json?.mensagem || json?.message || `Erro HTTP ${response.status}`;
    throw new Error(`Falha no fallback PHP CDN: ${mensagem}`);
  }

  displayWarn(`[cdnUploader] Fallback PHP utilizado com sucesso: ${json.link}`);
  return json.link;
}
