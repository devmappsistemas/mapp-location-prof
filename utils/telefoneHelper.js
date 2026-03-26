/**
 * Utilitários para normalização e comparação de telefones.
 * Usado na busca de agente_pedir para evitar duplicatas por formato ou 9º dígito (celular BR).
 */

/**
 * Retorna variantes do telefone para busca (celular BR: com/sem 9º dígito).
 * Ex: 553180240212 (sem 9) → [5531980240212]
 *     5531980240212 (com 9) → [553180240212]
 *
 * @param {string} telefone - Telefone em qualquer formato
 * @returns {string[]} Array de variantes (vazio se não houver)
 */
export function obterVariantesTelefone9(telefone) {
  const digitos = String(telefone || "").replace(/\D/g, "");
  if (!digitos || digitos.length < 10) return [];

  const variantes = [];
  if (digitos.startsWith("55") && digitos.length >= 12) {
    const apos55 = digitos.slice(2);
    if (apos55.length === 10) {
      variantes.push("55" + apos55.slice(0, 2) + "9" + apos55.slice(2));
    } else if (apos55.length === 11 && apos55[2] === "9") {
      variantes.push("55" + apos55.slice(0, 2) + apos55.slice(3));
    }
  }
  return variantes;
}
