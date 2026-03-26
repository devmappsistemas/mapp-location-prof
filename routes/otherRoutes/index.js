import { Router } from "express";
import { getSaoPauloISOString } from "../../utils/dateHelper.js";
import { authProfissionaisLocalizacoes } from "../../middleware/authProfissionaisLocalizacoes.js";
import { processarSeDisponivel } from "../../services/profissionaisLocalizacoesService.js";

const router = Router();

router.get("/status", (_req, res) => {
  res.json({ status: true, message: "API Localizações ativa" });
});

router.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "mapp-location-prof",
    timestamp: getSaoPauloISOString(),
    uptime: process.uptime(),
  });
});

router.post("/profissionais-localizacoes", authProfissionaisLocalizacoes, (req, res) => {
  const body = req.body || {};
  const domains = Array.isArray(body.domains) ? body.domains : [];

  if (domains.length === 0) {
    return res.status(400).json({
      error: "Payload inválido",
      message:
        "O corpo deve conter 'domains' (array não vazio). Cada item deve ter 'domain' ou 'fullDomain' e 'profs' (array).",
    });
  }

  const { disponivel } = processarSeDisponivel(body);

  if (disponivel) {
    return res.status(202).json({
      accepted: true,
      domainsCount: domains.length,
      status: "processando",
    });
  }

  return res.status(200).json({
    accepted: false,
    domainsCount: domains.length,
    message: "Servidor ocupado. Requisição não processada para evitar sobrecarga.",
  });
});

export default router;

