// Banco SQLite local (módulo nativo node:sqlite) com o índice de candidaturas do TSE e as listas do TCU.

import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const PASTA_DADOS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');
export const CAMINHO_DB = path.join(PASTA_DADOS, 'indice.db');

export const ESQUEMA = `
CREATE TABLE IF NOT EXISTS candidaturas (
  ano INTEGER NOT NULL,
  sq TEXT NOT NULL,
  turno INTEGER,
  eleicao TEXT,
  uf TEXT,
  unidade TEXT,          -- município ou estado da disputa
  cargo TEXT,
  numero TEXT,
  nome TEXT,
  nome_norm TEXT,
  urna TEXT,
  urna_norm TEXT,
  cpf TEXT,
  cpf_inferido INTEGER DEFAULT 0, -- 1 = CPF copiado de outra candidatura (mesmo nome e nascimento)
  nascimento TEXT,
  partido TEXT,
  situacao TEXT,         -- APTO / INAPTO
  detalhe_situacao TEXT, -- DEFERIDO / INDEFERIDO / CASSADO...
  situacao_julgamento TEXT,
  situacao_cassacao TEXT,
  situacao_diploma TEXT,
  resultado TEXT,        -- ELEITO / NÃO ELEITO / SUPLENTE...
  ocupacao TEXT,
  bens_total REAL,
  bens_qtd INTEGER,
  pessoa TEXT,           -- chave que agrupa as candidaturas da mesma pessoa
  PRIMARY KEY (ano, sq)
);
CREATE TABLE IF NOT EXISTS cassacoes (
  ano INTEGER, sq TEXT, processo TEXT, tipo TEXT, motivo TEXT
);
CREATE TABLE IF NOT EXISTS tcu (
  lista TEXT, cpf TEXT, nome TEXT, nome_norm TEXT, processo TEXT, acordao TEXT, data_acordao TEXT,
  transito TEXT, data_final TEXT, municipio TEXT, uf TEXT, link_deliberacao TEXT, link_processo TEXT
);
CREATE TABLE IF NOT EXISTS pessoas (
  pessoa TEXT PRIMARY KEY,
  id TEXT,               -- "ano-sq" da candidatura mais recente (usado na URL)
  nome TEXT, urnas TEXT, partidos TEXT, cargos TEXT, ufs TEXT,
  primeiro_ano INTEGER, ultimo_ano INTEGER, candidaturas INTEGER, eleito INTEGER,
  busca TEXT
);
CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT);
`;

export function abrirBanco({ escrita = false } = {}) {
  if (!escrita && !fs.existsSync(CAMINHO_DB)) {
    throw new Error('Índice não encontrado. Rode "npm run indexar" antes de iniciar o servidor.');
  }
  fs.mkdirSync(PASTA_DADOS, { recursive: true });
  const db = new DatabaseSync(CAMINHO_DB, { readOnly: !escrita });
  if (escrita) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
  return db;
}
