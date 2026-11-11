// Utilitários compartilhados: normalização de texto, HTTP com timeout e formatação.

/** Remove acentos, deixa maiúsculo e colapsa espaços. Usado para comparar nomes. */
export function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function soDigitos(texto) {
  return String(texto ?? '').replace(/\D/g, '');
}

/** CPF válido no formato que as bases usam (11 dígitos). Não valida dígito verificador. */
export function cpfValido(cpf) {
  return /^\d{11}$/.test(cpf ?? '');
}

/** Esconde o miolo do CPF para exibição: ***.456.789-** */
export function mascararCpf(cpf) {
  if (!cpfValido(cpf)) return null;
  return `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`;
}

const TIMEOUT_PADRAO = 20_000;

/** fetch com timeout. Lança erro com mensagem legível em caso de falha HTTP. */
export async function http(url, { timeout = TIMEOUT_PADRAO, ...opcoes } = {}) {
  const res = await fetch(url, { ...opcoes, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) {
    const erro = new Error(`HTTP ${res.status} em ${new URL(url).host}`);
    erro.status = res.status;
    throw erro;
  }
  return res;
}

export async function httpJson(url, opcoes = {}) {
  const res = await http(url, {
    ...opcoes,
    headers: { Accept: 'application/json', ...(opcoes.headers ?? {}) },
  });
  return { dados: await res.json(), headers: res.headers };
}

/** "1234,56" ou "1234.56" -> 1234.56 */
export function numeroBr(valor) {
  if (valor == null || valor === '') return 0;
  const s = String(valor).trim();
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** Valor ausente nas bases do TSE ("#NULO", "#NE", "-1", "NÃO DIVULGÁVEL"...). */
export function vazioTse(valor) {
  const v = String(valor ?? '').trim();
  return v === '' || v.startsWith('#') || v === '-1' || v === '-3' || v === '-4' || /N[ÃA]O DIVULG/i.test(v);
}

export function limpoTse(valor) {
  return vazioTse(valor) ? null : String(valor).trim();
}
