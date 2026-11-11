// Baixa os dados abertos do TSE e as listas do TCU e monta o índice local (data/indice.db).
//
// Uso:  npm run indexar
//       ANOS=2022,2024 npm run indexar     (só alguns anos; padrão: 2018 a 2026)
//
// Os arquivos baixados ficam em data/brutos/ e são reaproveitados nas próximas execuções.
// Para forçar o download de novo, apague essa pasta.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { abrirBanco, ESQUEMA, PASTA_DADOS, CAMINHO_DB } from '../src/lib/db.js';
import { linhasDoZip } from '../src/lib/csvzip.js';
import { normalizar, soDigitos, numeroBr, limpoTse, http } from '../src/lib/util.js';

const ANOS = (process.env.ANOS || '2018,2020,2022,2024,2026').split(',').map((a) => a.trim()).filter(Boolean);
const PASTA_BRUTOS = path.join(PASTA_DADOS, 'brutos');
const CDN_TSE = 'https://cdn.tse.jus.br/estatistica/sead/odsele';
const API_TCU = 'https://certidoes.apps.tcu.gov.br/api/publico';

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);

async function baixar(url, destino) {
  if (fs.existsSync(destino)) return true;
  log('baixando', url);
  let res;
  try {
    res = await http(url, { timeout: 15 * 60_000 });
  } catch (e) {
    if (e.status === 404 || e.status === 403) { log(`  (não disponível: ${e.message})`); return false; }
    throw e;
  }
  const temp = `${destino}.parcial`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));
  fs.renameSync(temp, destino);
  return true;
}

// ---------------------------------------------------------------- TSE

async function indexarCandidatos(db, ano) {
  const zip = path.join(PASTA_BRUTOS, `consulta_cand_${ano}.zip`);
  if (!(await baixar(`${CDN_TSE}/consulta_cand/consulta_cand_${ano}.zip`, zip))) return;

  // Uma pessoa que foi ao 2º turno aparece duas vezes: fica a linha do turno mais alto.
  const inserir = db.prepare(`
    INSERT INTO candidaturas (ano, sq, turno, eleicao, uf, unidade, cargo, numero, nome, nome_norm, urna, urna_norm,
      cpf, nascimento, partido, situacao, resultado, ocupacao)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ano, sq) DO UPDATE SET turno = excluded.turno, resultado = excluded.resultado
    WHERE excluded.turno >= candidaturas.turno`);

  let n = 0;
  db.exec('BEGIN');
  for await (const l of linhasDoZip(zip)) {
    const cpf = soDigitos(l.NR_CPF_CANDIDATO);
    inserir.run(
      Number(l.ANO_ELEICAO) || Number(ano), l.SQ_CANDIDATO, Number(l.NR_TURNO) || 1, limpoTse(l.DS_ELEICAO),
      limpoTse(l.SG_UF), limpoTse(l.NM_UE), limpoTse(l.DS_CARGO), limpoTse(l.NR_CANDIDATO),
      limpoTse(l.NM_CANDIDATO), normalizar(l.NM_CANDIDATO), limpoTse(l.NM_URNA_CANDIDATO), normalizar(l.NM_URNA_CANDIDATO),
      cpf.length === 11 ? cpf : null, limpoTse(l.DT_NASCIMENTO), limpoTse(l.SG_PARTIDO),
      limpoTse(l.DS_SITUACAO_CANDIDATURA), limpoTse(l.DS_SIT_TOT_TURNO), limpoTse(l.DS_OCUPACAO),
    );
    if (++n % 100_000 === 0) { db.exec('COMMIT; BEGIN'); log(`  ${ano}: ${n.toLocaleString('pt-BR')} linhas`); }
  }
  db.exec('COMMIT');
  log(`  ${ano}: ${n.toLocaleString('pt-BR')} linhas de candidatos`);
}

async function indexarComplementar(db, ano) {
  const zip = path.join(PASTA_BRUTOS, `consulta_cand_complementar_${ano}.zip`);
  if (!(await baixar(`${CDN_TSE}/consulta_cand_complementar/consulta_cand_complementar_${ano}.zip`, zip))) return;
  const atualizar = db.prepare(`UPDATE candidaturas SET detalhe_situacao = ?, situacao_julgamento = ?,
    situacao_cassacao = ?, situacao_diploma = ? WHERE ano = ? AND sq = ?`);
  db.exec('BEGIN');
  for await (const l of linhasDoZip(zip)) {
    atualizar.run(limpoTse(l.DS_DETALHE_SITUACAO_CAND), limpoTse(l.DS_SITUACAO_JULGAMENTO),
      limpoTse(l.DS_SITUACAO_CASSACAO), limpoTse(l.DS_SITUACAO_DIPLOMA), Number(l.ANO_ELEICAO) || Number(ano), l.SQ_CANDIDATO);
  }
  db.exec('COMMIT');
}

async function indexarBens(db, ano) {
  const zip = path.join(PASTA_BRUTOS, `bem_candidato_${ano}.zip`);
  if (!(await baixar(`${CDN_TSE}/bem_candidato/bem_candidato_${ano}.zip`, zip))) return;
  const somas = new Map();
  for await (const l of linhasDoZip(zip)) {
    const chave = `${Number(l.ANO_ELEICAO) || ano}|${l.SQ_CANDIDATO}`;
    const s = somas.get(chave) ?? [0, 0];
    s[0] += numeroBr(l.VR_BEM_CANDIDATO);
    s[1] += 1;
    somas.set(chave, s);
  }
  const atualizar = db.prepare('UPDATE candidaturas SET bens_total = ?, bens_qtd = ? WHERE ano = ? AND sq = ?');
  db.exec('BEGIN');
  for (const [chave, [total, qtd]] of somas) {
    const [a, sq] = chave.split('|');
    atualizar.run(Math.round(total * 100) / 100, qtd, Number(a), sq);
  }
  db.exec('COMMIT');
  log(`  ${ano}: bens de ${somas.size.toLocaleString('pt-BR')} candidaturas`);
}

async function indexarCassacoes(db, ano) {
  const zip = path.join(PASTA_BRUTOS, `motivo_cassacao_${ano}.zip`);
  if (!(await baixar(`${CDN_TSE}/motivo_cassacao/motivo_cassacao_${ano}.zip`, zip))) return;
  const inserir = db.prepare('INSERT INTO cassacoes (ano, sq, processo, tipo, motivo) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for await (const l of linhasDoZip(zip)) {
    inserir.run(Number(l.ANO_ELEICAO) || Number(ano), l.SQ_CANDIDATO, limpoTse(l.NR_PROCESSO),
      limpoTse(l.DS_TP_MOTIVO), limpoTse(l.DS_MOTIVO));
  }
  db.exec('COMMIT');
}

// ---------------------------------------------------------------- TCU

async function paginarTcu(endpoint, extra = '') {
  const itens = [];
  for (let pagina = 1; ; pagina++) {
    const res = await http(`${API_TCU}/${endpoint}?paginaAtual=${pagina}&tamanhoPagina=10000${extra}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', timeout: 120_000,
    });
    const dados = await res.json();
    itens.push(...dados.elementos);
    if (pagina >= dados.totalPaginas) break;
  }
  return itens;
}

async function indexarTcu(db) {
  const { ano } = await (await http(`${API_TCU}/eleicoes/ultimoAno`)).json();
  const listas = [
    ['contas_irregulares', 'responsaveis-contas-irregulares-com-paginacao', ''],
    ['implicacao_eleitoral', 'responsaveis-fins-eleitorais-com-paginacao', `&anoEleicao=${ano}`],
    ['inabilitados', 'responsaveis-inabilitados-com-paginacao', ''],
    ['inidoneos', 'responsaveis-inidoneos-com-paginacao', ''],
  ];
  const inserir = db.prepare(`INSERT INTO tcu (lista, cpf, nome, nome_norm, processo, acordao, data_acordao, transito, data_final,
    municipio, uf, link_deliberacao, link_processo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('DELETE FROM tcu');
  for (const [lista, endpoint, extra] of listas) {
    log('TCU:', lista);
    const itens = await paginarTcu(endpoint, extra);
    db.exec('BEGIN');
    let pf = 0;
    for (const i of itens) {
      const doc = soDigitos(i.numeroRegistro);
      if (doc.length !== 11) continue; // só pessoas físicas
      pf++;
      inserir.run(lista, doc, i.nome, normalizar(i.nome), i.numeroProcessoFormatado, i.numeroAcordaoFormatado ?? null, i.dataAcordao ?? null,
        i.dataTransitoEmJulgado ?? null, i.dataFinalSancao ?? i.dataFinalFinsEleitorais ?? null, i.municipio ?? null,
        i.uf ?? null, i.linkDeliberacoesProcesso ?? null, i.linkAcompanhamentoProcesso ?? null);
    }
    db.exec('COMMIT');
    log(`  ${pf.toLocaleString('pt-BR')} pessoas físicas de ${itens.length.toLocaleString('pt-BR')} registros`);
  }
}

// ---------------------------------------------------------------- Pessoas

function montarPessoas(db) {
  log('agrupando candidaturas por pessoa');
  // O TSE não publica CPF em alguns anos (ex.: 2024). Se o mesmo nome completo + data de nascimento
  // aparece em outra eleição com um único CPF possível, a candidatura passa a usar esse CPF.
  db.exec(`
    CREATE TEMP TABLE mapa_cpf AS
      SELECT nome_norm, nascimento, MIN(cpf) AS cpf FROM candidaturas
      WHERE cpf IS NOT NULL AND nascimento IS NOT NULL
      GROUP BY nome_norm, nascimento HAVING COUNT(DISTINCT cpf) = 1;
    CREATE INDEX temp.ix_mapa ON mapa_cpf (nome_norm, nascimento);
    UPDATE candidaturas SET cpf_inferido = 1, cpf = (
      SELECT m.cpf FROM mapa_cpf m WHERE m.nome_norm = candidaturas.nome_norm AND m.nascimento = candidaturas.nascimento)
    WHERE cpf IS NULL AND EXISTS (
      SELECT 1 FROM mapa_cpf m WHERE m.nome_norm = candidaturas.nome_norm AND m.nascimento = candidaturas.nascimento);
  `);
  const { n: inferidos } = db.prepare('SELECT COUNT(*) AS n FROM candidaturas WHERE cpf_inferido = 1').get();
  log(`  ${inferidos.toLocaleString('pt-BR')} candidaturas sem CPF ligadas a outra eleição pelo nome + nascimento`);

  // Mesma pessoa = mesmo CPF. Sem CPF, usa nome completo + data de nascimento.
  db.exec(`
    UPDATE candidaturas SET pessoa = CASE WHEN cpf IS NOT NULL THEN cpf
      ELSE 'n:' || nome_norm || '|' || COALESCE(nascimento, uf, '') END;
    CREATE INDEX IF NOT EXISTS ix_cand_pessoa ON candidaturas (pessoa);
    CREATE INDEX IF NOT EXISTS ix_tcu_cpf ON tcu (cpf);
    CREATE INDEX IF NOT EXISTS ix_tcu_nome ON tcu (nome_norm);
    CREATE INDEX IF NOT EXISTS ix_cass ON cassacoes (ano, sq);
    DELETE FROM pessoas;
    INSERT INTO pessoas (pessoa, id, nome, urnas, partidos, cargos, ufs, primeiro_ano, ultimo_ano, candidaturas, eleito, busca)
    SELECT c.pessoa,
      (SELECT x.ano || '-' || x.sq FROM candidaturas x WHERE x.pessoa = c.pessoa ORDER BY x.ano DESC, x.turno DESC LIMIT 1),
      (SELECT x.nome FROM candidaturas x WHERE x.pessoa = c.pessoa ORDER BY x.ano DESC LIMIT 1),
      GROUP_CONCAT(DISTINCT c.urna), GROUP_CONCAT(DISTINCT c.partido), GROUP_CONCAT(DISTINCT c.cargo),
      GROUP_CONCAT(DISTINCT c.uf), MIN(c.ano), MAX(c.ano), COUNT(*),
      SUM(CASE WHEN c.resultado LIKE 'ELEITO%' THEN 1 ELSE 0 END),
      MAX(c.nome_norm) || ' ' || GROUP_CONCAT(DISTINCT c.urna_norm)
    FROM candidaturas c GROUP BY c.pessoa;
    CREATE INDEX IF NOT EXISTS ix_pessoas_id ON pessoas (id);
  `);
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM pessoas').get();
  log(`  ${n.toLocaleString('pt-BR')} pessoas distintas`);
}

// ---------------------------------------------------------------- main

async function main() {
  fs.mkdirSync(PASTA_BRUTOS, { recursive: true });
  // Recria o índice do zero a cada execução (os brutos baixados são reaproveitados).
  for (const sufixo of ['', '-wal', '-shm']) fs.rmSync(CAMINHO_DB + sufixo, { force: true });
  const db = abrirBanco({ escrita: true });
  db.exec(ESQUEMA);

  for (const ano of ANOS) {
    log(`TSE ${ano}`);
    await indexarCandidatos(db, ano);
    await indexarComplementar(db, ano);
    await indexarBens(db, ano);
    await indexarCassacoes(db, ano);
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_cand_cpf ON candidaturas (cpf)');
  await indexarTcu(db);
  montarPessoas(db);

  const meta = db.prepare('INSERT OR REPLACE INTO meta (chave, valor) VALUES (?, ?)');
  meta.run('atualizado_em', new Date().toISOString());
  meta.run('anos', ANOS.join(','));
  db.close();
  log('pronto:', CAMINHO_DB);
}

main().catch((e) => { console.error(e); process.exit(1); });
