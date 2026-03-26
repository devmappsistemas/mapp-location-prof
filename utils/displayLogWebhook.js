/**
 * Utilitário de log condicionado a DISPLAY_LOG_WEBHOOK.
 * Só exibe log/warn/error quando process.env.DISPLAY_LOG_WEBHOOK === 'true'.
 * Em NODE_ENV=production, chamadas log('info', ...) não são exibidas (reduz ruído).
 */

const enabled = process.env.DISPLAY_LOG_WEBHOOK === "true";
const isProduction = process.env.NODE_ENV === "production";

function log(...args) {
  if (!enabled) return;
  if (isProduction && args[0] === "info") return;
  console.log(...args);
}

function warn(...args) {
  if (enabled) {
    console.warn(...args);
  }
}

function error(...args) {
  if (enabled) {
    console.error(...args);
  }
}

export { log, warn, error };
