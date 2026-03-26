/**
 * Worker Thread para parse de JSON.
 * Evita bloqueio do Event Loop principal em payloads grandes.
 *
 * Recebe: { type: 'parse', payload: string }
 * Envia: { type: 'result', data: object } ou { type: 'error', message: string }
 */
import { parentPort } from "worker_threads";

parentPort.on("message", (msg) => {
  if (msg?.type !== "parse" || typeof msg.payload !== "string") {
    parentPort.postMessage({ type: "error", message: "Payload inválido. Esperado { type: 'parse', payload: string }." });
    return;
  }
  try {
    const data = JSON.parse(msg.payload);
    parentPort.postMessage({ type: "result", data });
  } catch (err) {
    parentPort.postMessage({ type: "error", message: err.message || "Erro ao parsear JSON." });
  }
});
