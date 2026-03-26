/**
 * Utilitário de fuso horário
 * Começa usando São Paulo, mas é fácil trocar para outros fusos no futuro.
 */

/**
 * Retorna um objeto Date representando a data/hora atual em um fuso horário específico.
 * OBS: O objeto Date internamente é sempre UTC; aqui ajustamos os campos
 *       (ano, mês, dia, hora...) para refletirem o horário do fuso desejado.
 *
 * @param {string} timezone Ex: 'America/Sao_Paulo'
 * @returns {Date}
 */
export function getDataHoraPorFuso(timezone = 'America/Sao_Paulo') {
  const agora = new Date();

  const formatter = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const partes = formatter.formatToParts(agora);
  const get = (tipo) => partes.find((p) => p.type === tipo)?.value;

  const dia = get('day');
  const mes = get('month');
  const ano = get('year');
  const hora = get('hour');
  const minuto = get('minute');
  const segundo = get('second');

  // Cria um Date usando os valores já ajustados para o fuso desejado
  return new Date(`${ano}-${mes}-${dia}T${hora}:${minuto}:${segundo}`);
}

/**
 * Retorna a data/hora atual em um fuso horário específico no formato MySQL (YYYY-MM-DD HH:mm:ss).
 * Espelha a lógica do PHP: date_default_timezone_set($fusoHorario); date('Y-m-d H:i:s').
 * Usado no UPDATE de chegada para gravar no fuso do cliente.
 *
 * @param {string} timezone Ex: 'America/Sao_Paulo', 'America/Fortaleza', 'America/Cuiaba'
 * @returns {string} Ex: '2026-03-16 14:30:00'
 */
/**
 * Formata um instante UTC (`Date`) como YYYY-MM-DD HH:mm:ss no fuso informado
 * (mesma convenção de `getDateTimeMySQLPorFuso` para o "agora").
 *
 * @param {Date} dateUtc
 * @param {string} timezone
 * @returns {string}
 */
export function formatDateTimeMysqlNoFuso(dateUtc, timezone = "America/Sao_Paulo") {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(dateUtc);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function getDateTimeMySQLPorFuso(timezone = "America/Sao_Paulo") {
  return formatDateTimeMysqlNoFuso(new Date(), timezone);
}

/**
 * "Agora menos N segundos" no fuso do cliente, formato MySQL.
 * Útil para comparar com colunas `data` gravadas com `getDateTimeMySQLPorFuso`.
 *
 * @param {string} timezone
 * @param {number} segundos
 * @returns {string}
 */
export function getDateTimeMySQLMenosSegundosPorFuso(timezone = "America/Sao_Paulo", segundos = 60) {
  const sec = Math.max(0, Number(segundos) || 0);
  return formatDateTimeMysqlNoFuso(new Date(Date.now() - sec * 1000), timezone);
}
