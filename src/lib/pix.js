// Pix "Copia e Cola" estático (BR Code, padrão EMV do Banco Central) + QR Code em SVG.
// Gerado localmente a partir da chave: sem intermediário e sem taxa.

import QRCode from 'qrcode';
import { normalizar } from './util.js';

const campo = (id, valor) => `${id}${String(valor.length).padStart(2, '0')}${valor}`;

/** CRC16-CCITT (polinômio 0x1021, valor inicial 0xFFFF), exigido no campo 63 do BR Code. */
export function crc16(texto) {
  let crc = 0xffff;
  for (const byte of Buffer.from(texto, 'utf8')) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** Código Pix estático sem valor definido (quem paga escolhe o valor no app do banco). */
export function codigoPix({ chave, nome, cidade, identificador = '***' }) {
  const limpar = (s, max) => normalizar(s).slice(0, max).trim(); // sem acentos, maiúsculas, como o padrão pede
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', chave.trim());
  const semCrc = campo('00', '01')
    + campo('26', conta)
    + campo('52', '0000')
    + campo('53', '986')
    + campo('58', 'BR')
    + campo('59', limpar(nome, 25))
    + campo('60', limpar(cidade, 15))
    + campo('62', campo('05', identificador))
    + '6304';
  return semCrc + crc16(semCrc);
}

let pronto = null;
/** Configuração vinda do .env do servidor. Retorna null se o Pix não estiver configurado. */
export async function pixDoSite() {
  if (pronto !== null) return pronto;
  const chave = process.env.PIX_CHAVE || process.env.APOIO_PIX;
  const nome = process.env.PIX_NOME;
  const cidade = process.env.PIX_CIDADE;
  if (!chave || !nome || !cidade) { pronto = false; return pronto; }
  const codigo = codigoPix({ chave, nome, cidade });
  const svg = await QRCode.toString(codigo, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
  pronto = { codigo, svg };
  return pronto;
}
