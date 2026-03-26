import { Worker } from "worker_threads";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parseia JSON em Worker Thread para não bloquear o Event Loop.
 * @param {string} jsonString - String JSON a ser parseada
 * @returns {Promise<object>} Objeto parseado
 */
export function parseJsonWithWorker(jsonString) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "..", "workers", "parse-json-worker.js");
    const worker = new Worker(workerPath, {
      workerData: null,
      eval: false,
    });
    worker.on("message", (msg) => {
      worker.terminate();
      if (msg.type === "result") {
        resolve(msg.data);
      } else {
        reject(new Error(msg.message || "Erro ao parsear JSON"));
      }
    });
    worker.on("error", (err) => {
      worker.terminate();
      reject(err);
    });
    worker.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Worker encerrou com código ${code}`));
      }
    });
    worker.postMessage({ type: "parse", payload: jsonString });
  });
}
