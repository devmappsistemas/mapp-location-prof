import { log as displayLog, error as displayError } from "./displayLogWebhook.js";

const API_VERSION = "v24.0";

/**
 * Normaliza quebras de linha para uso em parâmetros de template WhatsApp.
 * Substitui \r\n, \r e \n por espaço, evitando erro na API Meta.
 * @param {string} str - Texto que pode conter quebras de linha
 * @returns {string}
 */
function normalizarQuebrasDeLinhaParaTemplate(str) {
  if (str == null) return "";
  return String(str).replace(/\r\n|\r|\n/g, " ");
}

/**
 * Busca credenciais (tokenMeta, idWhatBusinessMeta) em agente_pedir_numero_sincronizado por idTelConectado.
 * @param {Object} db - { dbMD }
 * @param {string|number} idTelConectado
 * @returns {Promise<{ tokenMeta: string, idWhatBusinessMeta: string, validacaoNumeroMeta?: string }|null>}
 */
async function buscarCredenciaisTemplateApi(db, idTelConectado) {
  try {
    if (!db?.dbMD || !idTelConectado) return null;
    const sql = `SELECT tokenMeta, idWhatBusinessMeta, validacaoNumeroMeta FROM agente_pedir_numero_sincronizado WHERE id = ? AND status = 'A' LIMIT 1`;
    const [rows] = await db.dbMD.query(sql, [idTelConectado]);
    if (!rows?.length || !rows[0].tokenMeta || !rows[0].idWhatBusinessMeta) return null;
    return {
      tokenMeta: String(rows[0].tokenMeta).trim(),
      idWhatBusinessMeta: String(rows[0].idWhatBusinessMeta).trim(),
      validacaoNumeroMeta: rows[0].validacaoNumeroMeta ? String(rows[0].validacaoNumeroMeta).trim() : undefined,
    };
  } catch (err) {
    displayError("[whatsappTemplateApi] Erro ao buscar credenciais:", err?.message);
    return null;
  }
}

/**
 * Busca informações do template no WhatsApp Business API (Meta).
 * GET https://graph.facebook.com/v24.0/{WABA-ID}/message_templates?name={template_name}
 *
 * @param {Object} db - Objeto com dbMD (conexão MD)
 * @param {string|number} idTelConectado - ID do registro em agente_pedir_numero_sincronizado
 * @param {string} nomeTemplate - Nome do template (ex: c_nova_chamada, c_continuidade_atendimento)
 * @returns {Promise<Object|null>} Template encontrado ou null
 */
export async function buscarTemplatePorNome(db, idTelConectado, nomeTemplate) {
  try {
    if (!nomeTemplate || String(nomeTemplate).trim() === "") return null;

    const credenciais = await buscarCredenciaisTemplateApi(db, idTelConectado);
    if (!credenciais) {
      displayError("[whatsappTemplateApi] Credenciais não encontradas para idTelConectado:", idTelConectado);
      return null;
    }

    const { tokenMeta, idWhatBusinessMeta } = credenciais;
    const url = `https://graph.facebook.com/${API_VERSION}/${idWhatBusinessMeta}/message_templates?name=${encodeURIComponent(nomeTemplate.trim())}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${tokenMeta}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text();
      displayError("[whatsappTemplateApi] Erro Meta API:", response.status, text?.substring(0, 300));
      return null;
    }

    const json = await response.json();
    const data = json?.data;

    if (!Array.isArray(data) || data.length === 0) {
      displayLog("[whatsappTemplateApi] Template não encontrado:", nomeTemplate);
      return null;
    }

    const template = data.find((t) => t?.name === nomeTemplate.trim()) ?? data[0];
    displayLog("[whatsappTemplateApi] Template encontrado:", template?.name, "language:", template?.language);
    return {
      ...template,
      templateCategory: template?.category ?? null,
      validacaoNumero: credenciais?.validacaoNumeroMeta ?? null,
    };
  } catch (err) {
    displayError("[whatsappTemplateApi] Erro ao buscar template:", err?.message);
    return null;
  }
}

/**
 * Constrói templateData e templateParameters a partir da resposta da API Meta.
 * Quando parametros não tem valor, usa mensagemDoBanco (coluna mensagem de agente_kanban_automacao) como parâmetro.
 *
 * @param {Object} templateMeta - Template retornado por buscarTemplatePorNome
 * @param {Object} [parametros] - Valores no formato { param_name: "valor" } ex: { interacao: "Atendimento" }
 * @param {string} [mensagemDoBanco] - Valor da coluna mensagem (banco) - usado como parâmetro quando parametros vazio
 * @returns {{ templateData: Object, templateParameters: Array }}
 */
export function montarTemplateDataParaEnvio(templateMeta, parametros = {}, mensagemDoBanco = "") {
  const parameterFormat = templateMeta?.parameter_format || "POSITIONAL";
  const language = templateMeta?.language || "pt_BR";
  const components = templateMeta?.components || [];

  const templateData = {
    id: templateMeta?.id ?? null,
    status: templateMeta?.status ?? null,
    category: templateMeta?.category ?? templateMeta?.templateCategory ?? null,
    language,
    parameter_format: parameterFormat,
    components,
  };

  const mensagemValor = normalizarQuebrasDeLinhaParaTemplate(
    mensagemDoBanco != null ? String(mensagemDoBanco).trim() : ""
  );

  let templateParameters = [];

  if (parameterFormat === "NAMED") {
    const paramNames = [];
    for (const comp of components) {
      if (comp.type === "BODY" && comp.example?.body_text_named_params) {
        for (const p of comp.example.body_text_named_params) {
          if (p?.param_name) paramNames.push(p.param_name);
        }
        break;
      }
    }

    if (paramNames.length > 0) {
      templateParameters = paramNames.map((paramName, idx) => {
        const valor = (parametros?.[paramName] ?? (idx === 0 && mensagemValor ? mensagemValor : "")) || "Atendimento";
        const textNormalizado = normalizarQuebrasDeLinhaParaTemplate(String(valor || "").trim() || paramName);
        return { type: "text", parameter_name: paramName, text: textNormalizado || paramName };
      });
    }
  } else {
    const bodyComp = components.find((c) => c.type === "BODY");
    const bodyText = bodyComp?.text || "";
    const matches = bodyText.match(/\{\{(\d+)\}\}/g);
    const numParams = matches ? Math.max(...matches.map((m) => parseInt(m.match(/\d+/)[0], 10))) : 0;

    for (let i = 1; i <= numParams; i++) {
      const valor =
        parametros?.[String(i)] ?? parametros?.[i] ?? (i === 1 && mensagemValor ? mensagemValor : "");
      const textNormalizado = normalizarQuebrasDeLinhaParaTemplate(String(valor || "").trim() || `Param${i}`);
      templateParameters.push(textNormalizado);
    }
  }

  return { templateData, templateParameters };
}

/**
 * Compõe a mensagem final do template substituindo placeholders NAMED pelos valores.
 * Usado para armazenar em dadosConteudo.mensagem o texto que o cliente verá.
 *
 * @param {Object} templateMeta - Template retornado por buscarTemplatePorNome
 * @param {Array} templateParameters - Array de { parameter_name, text } retornado por montarTemplateDataParaEnvio
 * @returns {string} Mensagem final com parâmetros substituídos
 */
export function comporMensagemTemplateFinal(templateMeta, templateParameters = []) {
  const components = templateMeta?.components || [];
  const bodyComp = components.find((c) => c.type === "BODY");
  const bodyText = bodyComp?.text || "";
  const matches = bodyText.match(/\{\{(\w+)\}\}/g);

  if (!matches || matches.length === 0) {
    return bodyText;
  }

  let resultado = bodyText;
  for (const m of matches) {
    const paramName = m.replace(/\{\{|\}\}/g, "");
    const param = templateParameters.find((p) => p?.parameter_name === paramName);
    const valor = param != null ? (param?.text ?? String(param)) : "";
    resultado = resultado.replace(m, valor);
  }
  return resultado;
}
