// Baixa os dados abertos do TSE e as listas do TCU e monta o índice local (data/indice.db).
//
// Uso:  npm run indexar
//       ANOS=2022,2024 npm run indexar     (só alguns anos; padrão: 2018 a 2026)
//
// Os arquivos baixados ficam em data/brutos/ e são reaproveitados nas próximas execuções.
// Para forçar o download de novo, apague essa pasta.

import fs from 'node:fs';
import dns from 'node:dns';

// Prefere IPv4 nas conexões de saída. O IPv6 da Hostinger é registrado na Europa e serviços
// brasileiros com bloqueio por país (ex.: DJEN do CNJ) recusam esse endereço; o IPv4 é do Brasil.
dns.setDefaultResultOrder('ipv4first');
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { abrirBanco, ESQUEMA, PASTA_DADOS, CAMINHO_DB } from '../src/lib/db.js';
import { linhasDoZip, linhasDoCsv, dividirLinha } from '../src/lib/csvzip.js';
import { normalizar, soDigitos, numeroBr, limpoTse, http } from '../src/lib/util.js';

const ANOS = (process.env.ANOS || '2018,2020,2022,2024,2026').split(',').map((a) => a.trim()).filter(Boolean);
const PASTA_BRUTOS = path.join(PASTA_DADOS, 'brutos');
const CDN_TSE = 'https://cdn.tse.jus.br/estatistica/sead/odsele';
const API_TCU = 'https://certidoes.apps.tcu.gov.br/api/publico';

const log = (...a) => console.log(new Date().toLocaleTimeString('pt-BR'), ...a);

/** Arquivos de eleições recentes ainda mudam (julgamentos, prestação de contas final): baixa de novo. */
function renovarSeRecente(destino, ano) {
  if (Number(ano) >= new Date().getFullYear() - 1) fs.rmSync(destino, { force: true });
}

async function baixar(url, destino, tentativas = 4) {
  if (fs.existsSync(destino)) return true;
  log('baixando', url);
  for (let t = 1; ; t++) {
    try {
      const res = await http(url, { timeout: 30 * 60_000 });
      const temp = `${destino}.parcial`;
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temp));
      fs.renameSync(temp, destino);
      return true;
    } catch (e) {
      if (e.status === 404 || e.status === 403) { log(`  (não disponível: ${e.message})`); return false; }
      if (t >= tentativas) throw e;
      log(`  falhou (${e.message}); tentando de novo em ${5 * t}s`);
      await new Promise((r) => setTimeout(r, 5000 * t));
    }
  }
}

// ---------------------------------------------------------------- TSE

async function indexarCandidatos(db, ano) {
  const zip = path.join(PASTA_BRUTOS, `consulta_cand_${ano}.zip`);
  renovarSeRecente(zip, ano);
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
  renovarSeRecente(zip, ano);
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
  renovarSeRecente(zip, ano);
  if (!(await baixar(`${CDN_TSE}/bem_candidato/bem_candidato_${ano}.zip`, zip))) return;
  const somas = new Map();
  const inserirBem = db.prepare('INSERT INTO bens (ano, sq, ordem, tipo, descricao, valor) VALUES (?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  let n = 0;
  for await (const l of linhasDoZip(zip)) {
    const a = Number(l.ANO_ELEICAO) || Number(ano);
    const valor = numeroBr(l.VR_BEM_CANDIDATO);
    inserirBem.run(a, l.SQ_CANDIDATO, Number(l.NR_ORDEM_BEM_CANDIDATO) || null, limpoTse(l.DS_TIPO_BEM_CANDIDATO),
      limpoTse(l.DS_BEM_CANDIDATO), valor);
    if (++n % 200_000 === 0) db.exec('COMMIT; BEGIN');
    const chave = `${a}|${l.SQ_CANDIDATO}`;
    const s = somas.get(chave) ?? [0, 0];
    s[0] += valor;
    s[1] += 1;
    somas.set(chave, s);
  }
  db.exec('COMMIT');
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
  renovarSeRecente(zip, ano);
  if (!(await baixar(`${CDN_TSE}/motivo_cassacao/motivo_cassacao_${ano}.zip`, zip))) return;
  const inserir = db.prepare('INSERT INTO cassacoes (ano, sq, processo, tipo, motivo) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for await (const l of linhasDoZip(zip)) {
    inserir.run(Number(l.ANO_ELEICAO) || Number(ano), l.SQ_CANDIDATO, limpoTse(l.NR_PROCESSO),
      limpoTse(l.DS_TP_MOTIVO), limpoTse(l.DS_MOTIVO));
  }
  db.exec('COMMIT');
}

// ---------------------------------------------------------------- Financiamento de campanha

const docMascarado = (doc) => {
  const d = soDigitos(doc);
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`; // CPF de doador pessoa física: mascarado
  if (d.length === 14) return d; // CNPJ: público
  return null;
};

async function indexarContas(db, ano) {
  const zip = path.join(PASTA_BRUTOS, `prestacao_contas_${ano}.zip`);
  renovarSeRecente(zip, ano);
  if (!(await baixar(`${CDN_TSE}/prestacao_contas/prestacao_de_contas_eleitorais_candidatos_${ano}.zip`, zip))) return;

  const upsert = (tabela, chaves, extras = []) => db.prepare(`
    INSERT INTO ${tabela} (ano, sq, ${chaves.join(', ')}${extras.map((e) => `, ${e}`).join('')}, total, qtd)
    VALUES (?, ?, ${chaves.map(() => '?').join(', ')}${extras.map(() => ', ?').join('')}, ?, 1)
    ON CONFLICT DO UPDATE SET total = total + excluded.total, qtd = qtd + 1`);
  const fonte = upsert('fin_fonte', ['fonte']);
  const origem = upsert('fin_origem', ['origem']);
  const doador = upsert('fin_doador', ['doc'], ['nome', 'origem']);
  const despesa = upsert('fin_despesa', ['categoria']);
  const fornecedor = upsert('fin_fornecedor', ['doc'], ['nome']);

  let n = 0;
  db.exec('BEGIN');
  for await (const l of linhasDoZip(zip, { arquivo: /^receitas_candidatos_\d{4}_BRASIL\.csv$/i })) {
    const a = Number(l.AA_ELEICAO) || Number(ano);
    const v = numeroBr(l.VR_RECEITA);
    const sq = l.SQ_CANDIDATO;
    fonte.run(a, sq, limpoTse(l.DS_FONTE_RECEITA) ?? 'NÃO INFORMADA', v);
    origem.run(a, sq, limpoTse(l.DS_ORIGEM_RECEITA) ?? 'Não informada', v);
    const doc = docMascarado(l.NR_CPF_CNPJ_DOADOR);
    const nome = limpoTse(l.NM_DOADOR_RFB) ?? limpoTse(l.NM_DOADOR);
    if (doc || nome) doador.run(a, sq, doc ?? nome, nome, limpoTse(l.DS_ORIGEM_RECEITA), v);
    if (++n % 200_000 === 0) { db.exec('COMMIT; BEGIN'); log(`  ${ano}: ${n.toLocaleString('pt-BR')} receitas`); }
  }
  db.exec('COMMIT');
  log(`  ${ano}: ${n.toLocaleString('pt-BR')} receitas`);

  n = 0;
  db.exec('BEGIN');
  for await (const l of linhasDoZip(zip, { arquivo: /^despesas_contratadas_candidatos_\d{4}_BRASIL\.csv$/i })) {
    const a = Number(l.AA_ELEICAO) || Number(ano);
    const v = numeroBr(l.VR_DESPESA_CONTRATADA);
    const sq = l.SQ_CANDIDATO;
    despesa.run(a, sq, limpoTse(l.DS_ORIGEM_DESPESA) ?? 'Não informada', v);
    const doc = docMascarado(l.NR_CPF_CNPJ_FORNECEDOR);
    const nome = limpoTse(l.NM_FORNECEDOR_RFB) ?? limpoTse(l.NM_FORNECEDOR);
    if (doc || nome) fornecedor.run(a, sq, doc ?? nome, nome, v);
    if (++n % 500_000 === 0) { db.exec('COMMIT; BEGIN'); log(`  ${ano}: ${n.toLocaleString('pt-BR')} despesas`); }
  }
  db.exec('COMMIT');
  log(`  ${ano}: ${n.toLocaleString('pt-BR')} despesas`);

  // Guarda só os 10 maiores doadores e fornecedores de cada candidatura (os totais ficam completos).
  for (const t of ['fin_doador', 'fin_fornecedor']) {
    db.exec(`DELETE FROM ${t} WHERE ano = ${Number(ano)} AND rowid IN (
      SELECT rowid FROM (SELECT rowid, ROW_NUMBER() OVER (PARTITION BY ano, sq ORDER BY total DESC) AS pos FROM ${t} WHERE ano = ${Number(ano)})
      WHERE pos > 10)`);
  }
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

// ---------------------------------------------------------------- Câmara

// Arquivo com todos os deputados desde 1826. Não traz CPF, mas traz nome civil e data de nascimento,
// que cruzamos com o TSE (mesmo nome completo + mesma data de nascimento).
async function indexarDeputados(db) {
  const destino = path.join(PASTA_BRUTOS, 'camara_deputados.csv');
  fs.rmSync(destino, { force: true }); // sempre a versão mais recente
  await baixar('https://dadosabertos.camara.leg.br/arquivos/deputados/csv/deputados.csv', destino);
  const linhas = fs.readFileSync(destino, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean);
  const cab = dividirLinha(linhas.shift());
  const inserir = db.prepare(`INSERT OR REPLACE INTO camara_deputados (id, nome, nome_civil, nome_norm, nascimento, leg_ini, leg_fim)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  let n = 0;
  for (const linha of linhas) {
    const campos = dividirLinha(linha);
    const c = Object.fromEntries(cab.map((k, i) => [k, campos[i]]));
    const leg = Number(c.idLegislaturaFinal);
    if (!(leg >= 47)) continue; // de 1983 em diante
    const [a, m, d] = (c.dataNascimento ?? '').split('-');
    inserir.run(Number(c.uri.split('/').pop()), c.nome, c.nomeCivil, normalizar(c.nomeCivil),
      a ? `${d}/${m}/${a}` : null, Number(c.idLegislaturaInicial), leg);
    n++;
  }
  db.exec('COMMIT; CREATE INDEX IF NOT EXISTS ix_dep_nome ON camara_deputados (nome_norm);');
  log(`Câmara: ${n.toLocaleString('pt-BR')} deputados desde 1983`);
}

// ---------------------------------------------------------------- Votações da Câmara

const ARQ_CAMARA = 'https://dadosabertos.camara.leg.br/arquivos';

async function indexarVotacoesCamara(db) {
  const anoAtual = new Date().getFullYear();
  const insVotacao = db.prepare(`INSERT OR REPLACE INTO cam_votacao (id, data, descricao, aprovacao, prop_id, proposicao, sigla_tipo, ementa, orient_gov)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insVoto = db.prepare('INSERT INTO cam_voto (id_votacao, dep_id, voto, partido) VALUES (?, ?, ?, ?)');

  for (let ano = 2019; ano <= anoAtual; ano++) {
    const arq = (tipo) => path.join(PASTA_BRUTOS, `camara_${tipo}_${ano}.csv`);
    for (const tipo of ['votacoes', 'votacoesVotos', 'votacoesOrientacoes', 'votacoesProposicoes']) {
      if (ano >= anoAtual - 1) fs.rmSync(arq(tipo), { force: true }); // anos recentes mudam: baixa de novo
      await baixar(`${ARQ_CAMARA}/${tipo}/csv/${tipo}-${ano}.csv`, arq(tipo));
    }
    if (!fs.existsSync(arq('votacoes'))) continue;

    // Proposições afetadas por votação (título e ementa).
    const props = new Map();
    for await (const l of linhasDoCsv(arq('votacoesProposicoes'))) {
      const lista = props.get(l.idVotacao) ?? [];
      lista.push(l);
      props.set(l.idVotacao, lista);
    }
    // Orientação do governo.
    const orient = new Map();
    for await (const l of linhasDoCsv(arq('votacoesOrientacoes'))) {
      if (/^governo$/i.test(l.siglaBancada ?? '')) orient.set(l.idVotacao, l.orientacao);
    }
    // Só votações do Plenário.
    const plenario = new Map();
    for await (const l of linhasDoCsv(arq('votacoes'))) {
      if (l.siglaOrgao === 'PLEN') plenario.set(l.id, l);
    }
    // Votos: só entram votações do Plenário que tiveram voto nominal.
    db.exec('BEGIN');
    const comVoto = new Set();
    let n = 0;
    for await (const l of linhasDoCsv(arq('votacoesVotos'))) {
      if (!plenario.has(l.idVotacao)) continue;
      comVoto.add(l.idVotacao);
      insVoto.run(l.idVotacao, Number(l.deputado_id), l.voto, l.deputado_siglaPartido);
      n++;
    }
    for (const id of comVoto) {
      const v = plenario.get(id);
      const lista = props.get(id) ?? [];
      const p = lista.find((x) => x.proposicao_id === v.ultimaApresentacaoProposicao_idProposicao) ?? lista[0];
      insVotacao.run(id, v.data, v.descricao, Number(v.aprovacao) || 0, p?.proposicao_id ?? v.ultimaApresentacaoProposicao_idProposicao ?? null,
        p?.proposicao_titulo ?? null, p?.proposicao_siglaTipo ?? null, p?.proposicao_ementa ?? null, orient.get(id) ?? null);
    }
    db.exec('COMMIT');
    log(`Câmara ${ano}: ${comVoto.size.toLocaleString('pt-BR')} votações nominais no Plenário, ${n.toLocaleString('pt-BR')} votos`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_voto_dep ON cam_voto (dep_id, id_votacao); CREATE INDEX IF NOT EXISTS ix_votacao_data ON cam_votacao (data);');
}

// ---------------------------------------------------------------- Cota parlamentar do Senado (CEAPS)

async function indexarCeaps(db) {
  const anoAtual = new Date().getFullYear();
  const ins = db.prepare(`INSERT INTO sen_ceaps (ano, senador, tipo, total, qtd) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT DO UPDATE SET total = total + excluded.total, qtd = qtd + 1`);
  for (let ano = 2019; ano <= anoAtual; ano++) {
    const destino = path.join(PASTA_BRUTOS, `senado_ceaps_${ano}.csv`);
    if (ano >= anoAtual - 1) fs.rmSync(destino, { force: true });
    if (!(await baixar(`https://www.senado.leg.br/transparencia/LAI/verba/despesa_ceaps_${ano}.csv`, destino))) continue;
    db.exec('BEGIN');
    let n = 0;
    for await (const l of linhasDoCsv(destino, { encoding: 'latin1', pular: 1 })) {
      if (!l.SENADOR) continue;
      ins.run(Number(l.ANO) || ano, normalizar(l.SENADOR), l.TIPO_DESPESA?.split(',')[0].trim() || 'Não informado', numeroBr(l.VALOR_REEMBOLSADO));
      n++;
    }
    db.exec('COMMIT');
    log(`Senado CEAPS ${ano}: ${n.toLocaleString('pt-BR')} despesas`);
  }
}

// ---------------------------------------------------------------- Empresas (Receita Federal)

// Compartilhamento público da Receita (Nextcloud). Lista as pastas pelo WebDAV público do próprio compartilhamento.
const RF_TOKEN = 'gn672Ad4CF8N6TK';
const RF_WEBDAV = 'https://arquivos.receitafederal.gov.br/public.php/webdav/Dados/Cadastros/CNPJ';
const RF_AUTH = { Authorization: `Basic ${Buffer.from(`${RF_TOKEN}:`).toString('base64')}` };
const PORTE = { '00': 'não informado', '01': 'micro empresa', '03': 'empresa de pequeno porte', '05': 'demais' };

async function baixarRf(arquivo, destino) {
  if (fs.existsSync(destino)) return;
  log('baixando Receita', arquivo);
  for (let t = 1; ; t++) {
    try {
      const res = await http(`${RF_WEBDAV}/${arquivo}`, { headers: RF_AUTH, timeout: 60 * 60_000 });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(`${destino}.parcial`));
      fs.renameSync(`${destino}.parcial`, destino);
      return;
    } catch (e) {
      if (t >= 4) throw e;
      log(`  falhou (${e.message}); tentando de novo`);
      await new Promise((r) => setTimeout(r, 5000 * t));
    }
  }
}

async function indexarEmpresas(db) {
  const lista = await (await http(`${RF_WEBDAV}/`, { method: 'PROPFIND', headers: { ...RF_AUTH, Depth: '1' } })).text();
  const mes = [...lista.matchAll(/CNPJ\/(\d{4}-\d{2})\//g)].map((m) => m[1]).sort().at(-1);
  if (!mes) { log('Receita: nenhuma pasta mensal encontrada'); return; }
  log(`Receita: dados de ${mes}`);
  for (const f of fs.readdirSync(PASTA_BRUTOS)) {
    if (f.startsWith('rf_') && !f.startsWith(`rf_${mes}_`)) fs.rmSync(path.join(PASTA_BRUTOS, f), { force: true });
  }
  const arq = (nome) => path.join(PASTA_BRUTOS, `rf_${mes}_${nome}`);

  // Qualificações (código -> descrição)
  await baixarRf(`${mes}/Qualificacoes.zip`, arq('Qualificacoes.zip'));
  const qualif = new Map();
  for await (const l of linhasDoZip(arq('Qualificacoes.zip'), { arquivo: /./, colunas: ['cod', 'desc'] })) qualif.set(l.cod, l.desc);

  // Chave de cruzamento: nome completo + 6 dígitos do meio do CPF (o que a Receita deixa visível).
  const chaves = new Map();
  for (const { cpf, nome_norm: nome } of db.prepare('SELECT DISTINCT cpf, nome_norm FROM candidaturas WHERE cpf IS NOT NULL').all()) {
    chaves.set(`${nome}|${cpf.slice(3, 9)}`, cpf);
  }

  const insSocio = db.prepare('INSERT INTO empresa_socio (cpf, cnpj_basico, qualificacao, data_entrada) VALUES (?, ?, ?, ?)');
  const cnpjs = new Set();
  const colSocios = ['cnpj_basico', 'tipo', 'nome', 'doc', 'qualificacao', 'data_entrada', 'pais', 'rep_doc', 'rep_nome', 'rep_qualif', 'faixa_etaria'];
  for (let i = 0; i <= 9; i++) {
    await baixarRf(`${mes}/Socios${i}.zip`, arq(`Socios${i}.zip`));
    db.exec('BEGIN');
    for await (const l of linhasDoZip(arq(`Socios${i}.zip`), { arquivo: /./, colunas: colSocios })) {
      if (l.tipo !== '2') continue; // só pessoa física
      const cpf = chaves.get(`${normalizar(l.nome)}|${soDigitos(l.doc)}`);
      if (!cpf) continue;
      const d = l.data_entrada ?? '';
      insSocio.run(cpf, l.cnpj_basico, qualif.get(l.qualificacao) ?? l.qualificacao,
        d.length === 8 ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : null);
      cnpjs.add(l.cnpj_basico);
    }
    db.exec('COMMIT');
    log(`  Socios${i}: ${cnpjs.size.toLocaleString('pt-BR')} empresas ligadas a políticos até agora`);
  }

  const insEmpresa = db.prepare('INSERT OR REPLACE INTO empresa (cnpj_basico, razao_social, natureza, capital, porte) VALUES (?, ?, ?, ?, ?)');
  const colEmpresas = ['cnpj_basico', 'razao_social', 'natureza', 'qualif_resp', 'capital', 'porte', 'ente'];
  for (let i = 0; i <= 9; i++) {
    await baixarRf(`${mes}/Empresas${i}.zip`, arq(`Empresas${i}.zip`));
    db.exec('BEGIN');
    for await (const l of linhasDoZip(arq(`Empresas${i}.zip`), { arquivo: /./, colunas: colEmpresas })) {
      if (!cnpjs.has(l.cnpj_basico)) continue;
      insEmpresa.run(l.cnpj_basico, l.razao_social, l.natureza, numeroBr(l.capital), PORTE[l.porte] ?? null);
    }
    db.exec('COMMIT');
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_socio_cpf ON empresa_socio (cpf)');
  db.prepare("INSERT OR REPLACE INTO meta (chave, valor) VALUES ('receita_mes', ?)").run(mes);
  log(`Receita: ${cnpjs.size.toLocaleString('pt-BR')} empresas com sócio político`);
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
    CREATE INDEX IF NOT EXISTS ix_bens ON bens (ano, sq);
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
  // Monta o índice num arquivo novo e só troca pelo atual no final,
  // para o site continuar no ar durante a atualização.
  const NOVO = `${CAMINHO_DB}.novo`;
  for (const sufixo of ['', '-wal', '-shm']) fs.rmSync(NOVO + sufixo, { force: true });
  const db = abrirBanco({ escrita: true, caminho: NOVO });
  db.exec(ESQUEMA);

  for (const ano of ANOS) {
    log(`TSE ${ano}`);
    await indexarCandidatos(db, ano);
    await indexarComplementar(db, ano);
    await indexarBens(db, ano);
    await indexarCassacoes(db, ano);
    await indexarContas(db, ano);
  }
  db.exec('CREATE INDEX IF NOT EXISTS ix_cand_cpf ON candidaturas (cpf)');
  await indexarTcu(db);
  await indexarDeputados(db);
  await indexarVotacoesCamara(db);
  await indexarCeaps(db);
  montarPessoas(db);
  await indexarEmpresas(db);

  const meta = db.prepare('INSERT OR REPLACE INTO meta (chave, valor) VALUES (?, ?)');
  meta.run('atualizado_em', new Date().toISOString());
  meta.run('anos', ANOS.join(','));
  db.exec('PRAGMA journal_mode = DELETE;'); // junta o WAL no arquivo principal
  db.close();
  fs.renameSync(NOVO, CAMINHO_DB);
  for (const sufixo of ['-wal', '-shm']) fs.rmSync(CAMINHO_DB + sufixo, { force: true });
  log('pronto:', CAMINHO_DB);
}

main().catch((e) => { console.error(e); process.exit(1); });
