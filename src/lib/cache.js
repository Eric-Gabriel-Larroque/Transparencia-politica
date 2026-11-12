// Cache permanente das fichas (sobrevive a reinícios do servidor) e registro de reportes de erro.
// Fica num banco separado (data/cache.db), gravável, para não tocar no índice principal (somente leitura).

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { PASTA_DADOS } from './db.js';

fs.mkdirSync(PASTA_DADOS, { recursive: true });
const db = new DatabaseSync(path.join(PASTA_DADOS, 'cache.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS ficha (id TEXT PRIMARY KEY, em INTEGER, dados TEXT);
  CREATE TABLE IF NOT EXISTS reporte (
    criado_em TEXT, ficha TEXT, nome TEXT, secao TEXT, mensagem TEXT, contato TEXT, ip_hash TEXT, resolvido INTEGER DEFAULT 0
  );
`);

const ler = db.prepare('SELECT em, dados FROM ficha WHERE id = ?');
const gravar = db.prepare('INSERT OR REPLACE INTO ficha (id, em, dados) VALUES (?, ?, ?)');

export function lerFicha(id, validadeMs) {
  const r = ler.get(id);
  if (!r || Date.now() - r.em > validadeMs) return null;
  return JSON.parse(r.dados);
}

export function gravarFicha(id, dados) {
  gravar.run(id, Date.now(), JSON.stringify(dados));
}

// Limpa fichas com mais de 7 dias (uma vez por hora).
setInterval(() => db.prepare('DELETE FROM ficha WHERE em < ?').run(Date.now() - 7 * 86_400_000), 3_600_000).unref();

const inserirReporte = db.prepare(`INSERT INTO reporte (criado_em, ficha, nome, secao, mensagem, contato, ip_hash)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
export function registrarReporte(r) {
  inserirReporte.run(new Date().toISOString(), r.ficha, r.nome, r.secao, r.mensagem, r.contato, r.ipHash);
}

export function listarReportes({ todos = false } = {}) {
  return db.prepare(`SELECT rowid AS id, * FROM reporte ${todos ? '' : 'WHERE resolvido = 0'} ORDER BY criado_em DESC`).all();
}

export function marcarResolvido(id) {
  db.prepare('UPDATE reporte SET resolvido = 1 WHERE rowid = ?').run(Number(id));
}
