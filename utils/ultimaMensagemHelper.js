/**
 * Avalia a data/hora da última mensagem e retorna intervalo e decisão de template.
 * Regra: intervalo >= 24 horas → isTemplate = true; caso contrário, false.
 * Pode ser reaproveitado em runners, controllers ou outros fluxos.
 *
 * @param {Date|string|null|undefined} dataHora - Data/hora da última mensagem
 * @returns {{ intervalo: number|null, isTemplate: boolean }}
 */
export function avaliarUltimaMensagem(dataHora) {
  if (!dataHora) return { intervalo: null, isTemplate: false };
  const dataUltima = new Date(dataHora);
  if (Number.isNaN(dataUltima.getTime())) return { intervalo: null, isTemplate: false };
  const intervalo = (Date.now() - dataUltima.getTime()) / (1000 * 60 * 60);
  const isTemplate = intervalo >= 24;
  return { intervalo, isTemplate };
}

/**
 * Avalia a data/hora da última mensagem com regra configurável.
 * Converte valorRegra para minutos conforme unidadeRegra (H=hora, D=dia).
 * Retorna intervalo em minutos e se atingiu o limite da regra.
 *
 * @param {Date|string|null|undefined} dataHora - Data/hora da última mensagem
 * @param {number} valorRegra - Valor numérico da regra (ex: 24, 2, 30)
 * @param {string} unidadeRegra - "H" (hora) ou "D" (dia)
 * @returns {{ intervalo: number|null, intervaloRegra: number, isIntervaloRegra: boolean }}
 */
export function avaliarUltimaMensagemComRegra(dataHora, valorRegra, unidadeRegra) {
  if (!dataHora) return { intervalo: null, intervaloRegra: 0, isIntervaloRegra: false };
  const dataUltima = new Date(dataHora);
  if (Number.isNaN(dataUltima.getTime())) return { intervalo: null, intervaloRegra: 0, isIntervaloRegra: false };

  const valor = Number(valorRegra) || 0;
  const unidade = String(unidadeRegra || "").toUpperCase().trim();
  let intervaloRegra = valor;
  if (unidade === "H") {
    intervaloRegra = valor * 60; // horas → minutos
  } else if (unidade === "D") {
    intervaloRegra = valor * 24 * 60; // dias → minutos
  }

  const intervalo = (Date.now() - dataUltima.getTime()) / (1000 * 60); // minutos
  const isIntervaloRegra = intervalo >= intervaloRegra;

  return { intervalo, intervaloRegra, isIntervaloRegra };
}
