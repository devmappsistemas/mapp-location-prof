/**
 * Retorna timestamp ISO no fuso horário de São Paulo (America/Sao_Paulo)
 * Formato: YYYY-MM-DDTHH:mm:ss-03:00
 * 
 * @returns {string} Data formatada no formato ISO com fuso horário de São Paulo
 */
export function getSaoPauloISOString() {
  const now = new Date();
  
  // Usa Intl.DateTimeFormat para obter partes da data no fuso horário de São Paulo
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  
  const parts = formatter.formatToParts(now);
  const dateParts = {};
  parts.forEach(part => {
    dateParts[part.type] = part.value;
  });
  
  // Formato: YYYY-MM-DDTHH:mm:ss-03:00
  return `${dateParts.year}-${dateParts.month}-${dateParts.day}T${dateParts.hour}:${dateParts.minute}:${dateParts.second}-03:00`;
}

/**
 * Retorna data/hora atual no fuso de São Paulo no formato MySQL (YYYY-MM-DD HH:mm:ss).
 * @returns {string}
 */
export function getSaoPauloDateTimeMySQL() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "0";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

