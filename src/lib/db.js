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
CREATE TABLE IF NOT EXISTS bens (
  ano INTEGER, sq TEXT, ordem INTEGER, tipo TEXT, descricao TEXT, valor REAL
);
CREATE TABLE IF NOT EXISTS camara_deputados (
  id INTEGER PRIMARY KEY, nome TEXT, nome_civil TEXT, nome_norm TEXT, nascimento TEXT, leg_ini INTEGER, leg_fim INTEGER
);
-- Financiamento de campanha (TSE, prestação de contas), já somado por candidatura.
CREATE TABLE IF NOT EXISTS fin_fonte (ano INTEGER, sq TEXT, fonte TEXT, total REAL, qtd INTEGER, PRIMARY KEY (ano, sq, fonte));
CREATE TABLE IF NOT EXISTS fin_origem (ano INTEGER, sq TEXT, origem TEXT, total REAL, qtd INTEGER, PRIMARY KEY (ano, sq, origem));
CREATE TABLE IF NOT EXISTS fin_doador (ano INTEGER, sq TEXT, doc TEXT, nome TEXT, origem TEXT, total REAL, qtd INTEGER, PRIMARY KEY (ano, sq, doc));
CREATE TABLE IF NOT EXISTS fin_despesa (ano INTEGER, sq TEXT, categoria TEXT, total REAL, qtd INTEGER, PRIMARY KEY (ano, sq, categoria));
CREATE TABLE IF NOT EXISTS fin_fornecedor (ano INTEGER, sq TEXT, doc TEXT, nome TEXT, total REAL, qtd INTEGER, PRIMARY KEY (ano, sq, doc));
-- Votações nominais do Plenário da Câmara (desde 2019).
CREATE TABLE IF NOT EXISTS cam_votacao (
  id TEXT PRIMARY KEY, data TEXT, descricao TEXT, aprovacao INTEGER, prop_id TEXT, proposicao TEXT, sigla_tipo TEXT,
  ementa TEXT, orient_gov TEXT
);
CREATE TABLE IF NOT EXISTS cam_voto (id_votacao TEXT, dep_id INTEGER, voto TEXT, partido TEXT);
-- Cota parlamentar do Senado (CEAPS), somada por senador (nome parlamentar), ano e tipo de despesa.
CREATE TABLE IF NOT EXISTS sen_ceaps (ano INTEGER, senador TEXT, tipo TEXT, total REAL, qtd INTEGER, PRIMARY KEY (ano, senador, tipo));
-- Empresas das quais o político é sócio (Receita Federal, quadro de sócios), cruzadas por nome + 6 dígitos do CPF.
CREATE TABLE IF NOT EXISTS empresa_socio (cpf TEXT, cnpj_basico TEXT, qualificacao TEXT, data_entrada TEXT);
CREATE TABLE IF NOT EXISTS empresa (cnpj_basico TEXT PRIMARY KEY, razao_social TEXT, natureza TEXT, capital REAL, porte TEXT);
-- Cota parlamentar da Câmara (CEAP), dos arquivos anuais oficiais, somada por deputado e ano.
CREATE TABLE IF NOT EXISTS cam_ceap (dep_id INTEGER, ano INTEGER, total REAL, qtd INTEGER, PRIMARY KEY (dep_id, ano));
CREATE TABLE IF NOT EXISTS meta (chave TEXT PRIMARY KEY, valor TEXT);
`;

export function abrirBanco({ escrita = false, caminho = CAMINHO_DB } = {}) {
  if (!escrita && !fs.existsSync(caminho)) {
    throw new Error('Índice não encontrado. Rode "npm run indexar" antes de iniciar o servidor.');
  }
  fs.mkdirSync(PASTA_DADOS, { recursive: true });
  const db = new DatabaseSync(caminho, { readOnly: !escrita });
  if (escrita) db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = OFF;');
  return db;
}

/** Página do conjunto de dados de candidatos do TSE de cada ano (fonte oficial dos bens). */
export function linkContasTse(ano) {
  return `https://dadosabertos.tse.jus.br/dataset/prestacao-de-contas-eleitorais-${ano}`;
}

export function linkDadosTse(ano) {
  const slug = Number(ano) === 2020 ? 'candidatos-2020-subtemas' : `candidatos-${ano}`;
  return `https://dadosabertos.tse.jus.br/dataset/${slug}`;
}
