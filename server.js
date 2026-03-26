import "dotenv/config";
import express from "express";
import cron from "node-cron";
import { getSaoPauloISOString } from "./utils/dateHelper.js";
import { parseJsonWithWorker } from "./utils/parseJsonWorker.js";
import v1 from "./routes/index.js";
import { processarSeDisponivel } from "./services/profissionaisLocalizacoesService.js";
const app = express();
const LOCATIONS_SOURCE_URL = process.env.LOCATIONS_SOURCE_URL || "http://localhost:5564/locations";
const LOCATIONS_FETCH_TIMEOUT_MS = Math.max(
  1000,
  parseInt(process.env.LOCATIONS_FETCH_TIMEOUT_MS, 10) || 5000
);
let pollInFlight = false;

async function executarPollLocalizacoes() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {

    const res = await fetch(LOCATIONS_SOURCE_URL, {
      method: "GET",
      signal: AbortSignal.timeout(LOCATIONS_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(
        `[${getSaoPauloISOString()}] [locations-poll] Falha HTTP ${res.status} em ${LOCATIONS_SOURCE_URL}`
      );
      return;
    }
    const raw = await res.text();
    const payload = await parseJsonWithWorker(raw);
    const domains = Array.isArray(payload?.domains) ? payload.domains : [];
    if (domains.length === 0) return;

    const { disponivel } = processarSeDisponivel(payload);
    if (!disponivel) {
      console.log(`[${getSaoPauloISOString()}] [locations-poll] Ocupado, ciclo ignorado.`);
    }
  } catch (err) {
    console.error(`[${getSaoPauloISOString()}] [locations-poll] Erro:`, err.message);
  } finally {
    pollInFlight = false;
  }
}

app.use(
  "/api/v1/profissionais-localizacoes",
  express.raw({ type: "application/json", limit: "50mb" }),
  async (req, res, next) => {
    if (req.method !== "POST") return next();
    try {
      if (Buffer.isBuffer(req.body)) {
        req.body = await parseJsonWithWorker(req.body.toString("utf8"));
      }
      next();
    } catch (err) {
      res.status(400).json({ error: "JSON inválido", message: err.message });
    }
  }
);

app.use((req, res, next) => {
  if (req.path === "/api/v1/profissionais-localizacoes" && req.method === "POST") {
    return next();
  }
  return express.json({ limit: "5mb" })(req, res, next);
});

app.use("/api/v1", v1);

app.use((req, res) => {
  res.status(404).json({
    error: "Rota não encontrada",
    message: "A página que você está solicitando não foi encontrada",
    path: req.path,
  });
});

const PORT = process.env.PORT || 4050;
app.listen(PORT, () => {
  console.log(`[${getSaoPauloISOString()}] API Localizações rodando na porta ${PORT}`);
  console.log(`[${getSaoPauloISOString()}] Poll source: ${LOCATIONS_SOURCE_URL}`);
  executarPollLocalizacoes();
  cron.schedule("*/10 * * * * *", executarPollLocalizacoes, { timezone: "America/Sao_Paulo" });
});

