// Câmara dos Deputados e Senado Federal: atuação parlamentar (proposições, gastos).
//
// Quem foi deputado(a) ou senador(a) é descoberto pelas listas oficiais das Casas (desde 1983),
// e não pelas candidaturas do TSE (que no índice só começam em 2018). O cruzamento é pelo
// nome civil completo + data de nascimento, porque nenhuma das duas Casas publica CPF.

import { httpJson, normalizar } from '../lib/util.js';

const CAMARA = 'https://dadosabertos.camara.leg.br/api/v2';
const SENADO = 'https://legis.senado.leg.br/dadosabertos';
const LEGISLATURA_ATUAL = 57; // 2023–2027

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const anoInicio = (leg) => 1795 + 4 * leg; // 57 -> 2023
const PERIODO_LEGISLATURA = (n) => `${anoInicio(n)}–${anoInicio(n) + 4}`;

/** TSE usa dd/mm/aaaa; as Casas, aaaa-mm-dd. */
const dataBr = (iso) => {
  const [a, m, d] = String(iso ?? '').split('-');
  return a && m && d ? `${d}/${m}/${a}` : null;
};

const naoEncontrado = (casa) => ({
  naoAplicavel: true,
  motivo: `Não há registro de mandato ${casa} desde 1983 com o mesmo nome completo e data de nascimento.`,
});

// ---------------------------------------------------------------- Câmara

// Obs.: o filtro "ano" da API de despesas devolve lista vazia (testado em nov/2026);
// o filtro por legislatura funciona, então somamos a legislatura inteira e separamos por ano aqui.
async function somarDespesas(id, legislatura) {
  const url = (pagina) => `${CAMARA}/deputados/${id}/despesas?idLegislatura=${legislatura}&itens=100&pagina=${pagina}`;
  const { dados: primeira, headers } = await httpJson(url(1));
  const paginas = Math.min(Math.ceil(Number(headers.get('x-total-count') ?? 0) / 100), 60);
  const itens = [...primeira.dados];
  for (let p = 2; p <= paginas; p += 6) {
    const lote = await Promise.all(Array.from({ length: Math.min(6, paginas - p + 1) }, (_, i) => httpJson(url(p + i))));
    for (const { dados } of lote) itens.push(...dados.dados);
  }
  const porAno = {};
  let total = 0;
  for (const d of itens) {
    const v = Number(d.valorLiquido) || 0;
    total += v;
    porAno[d.ano] = (porAno[d.ano] ?? 0) + v;
  }
  return { total, qtd: itens.length, porAno };
}

const VOTO_LEGIVEL = { Sim: 'Sim', Não: 'Não', Abstenção: 'Abstenção', Obstrução: 'Obstrução', 'Artigo 17': 'Art. 17 (presidente)' };

/** Votações nominais do Plenário (índice local, desde 2019) na última legislatura do deputado. */
function votacoesCamara(db, dep) {
  const leg = dep.leg_fim;
  const inicio = `${anoInicio(leg)}-02-01`;
  const fim = `${anoInicio(leg) + 4}-01-31`;
  if (anoInicio(leg) + 4 < 2019) return { indicadores: [], listas: [] };

  const total = db.prepare('SELECT COUNT(*) AS n FROM cam_votacao WHERE data BETWEEN ? AND ?').get(inicio, fim).n;
  const base = `FROM cam_voto v JOIN cam_votacao t ON t.id = v.id_votacao WHERE v.dep_id = ? AND t.data BETWEEN ? AND ?`;
  const votou = db.prepare(`SELECT COUNT(*) AS n ${base}`).get(dep.id, inicio, fim).n;
  if (!total) return { indicadores: [], listas: [] };
  const alin = db.prepare(`SELECT SUM(v.voto = t.orient_gov) AS iguais, COUNT(*) AS n ${base}
    AND t.orient_gov IN ('Sim', 'Não') AND v.voto IN ('Sim', 'Não')`).get(dep.id, inicio, fim);
  const linha = (x) => ({
    titulo: `${x.proposicao ?? 'Votação'} – votou ${VOTO_LEGIVEL[x.voto] ?? x.voto}`,
    situacao: [x.descricao?.slice(0, 160), x.orient_gov && `orientação do governo: ${x.orient_gov}`].filter(Boolean).join(' · '),
    detalhe: x.ementa,
    data: x.data?.split('-').reverse().join('/'),
    link: x.prop_id ? `https://www.camara.leg.br/propostas-legislativas/${x.prop_id}` : null,
  });
  const peCs = db.prepare(`SELECT t.*, v.voto ${base} AND t.sigla_tipo = 'PEC' ORDER BY t.data DESC LIMIT 20`).all(dep.id, inicio, fim);
  const recentes = db.prepare(`SELECT t.*, v.voto ${base} ORDER BY t.data DESC LIMIT 15`).all(dep.id, inicio, fim);
  const periodo = PERIODO_LEGISLATURA(leg);

  return {
    indicadores: [
      { rotulo: `Votações nominais do Plenário (${periodo})`, valor: `${votou.toLocaleString('pt-BR')} de ${total.toLocaleString('pt-BR')}`,
        detalhe: `votou em ${Math.round((votou / total) * 100)}% · ausências incluem licenças, missões e períodos fora do mandato` },
      alin.n ? { rotulo: 'Votou igual à orientação do governo da época', valor: `${Math.round((alin.iguais / alin.n) * 100)}%`,
        detalhe: `em ${alin.n.toLocaleString('pt-BR')} votações com orientação Sim/Não do governo` } : null,
    ].filter(Boolean),
    listas: [
      peCs.length && { titulo: `Votos em PECs (emendas à Constituição), ${periodo}`, registros: peCs.map(linha) },
      recentes.length && { titulo: 'Votações nominais mais recentes', registros: recentes.map(linha), recolhido: true },
    ].filter(Boolean),
  };
}

export const camara = {
  id: 'camara',
  nome: 'Atuação na Câmara dos Deputados',
  orgao: 'Câmara dos Deputados – Dados Abertos',
  descricao: 'Mandatos, proposições apresentadas e gastos da cota parlamentar (CEAP).',
  aplicavel: () => true,
  async consultar(p, { db }) {
    const dep = p.nascimento
      ? db.prepare('SELECT * FROM camara_deputados WHERE nome_norm = ? AND nascimento = ?').get(p.nome_norm, p.nascimento)
      : null;
    if (!dep) return naoEncontrado('na Câmara');

    const qs = `idDeputadoAutor=${dep.id}&dataApresentacaoInicio=${anoInicio(dep.leg_ini)}-01-01&ordem=DESC&ordenarPor=id`;
    const [{ dados: props, headers }, { dados: det }] = await Promise.all([
      httpJson(`${CAMARA}/proposicoes?${qs}&itens=5`),
      httpJson(`${CAMARA}/deputados/${dep.id}`),
    ]);
    const totalProps = Number(headers.get('x-total-count') ?? props.dados.length);
    const s = det.dados.ultimoStatus ?? {};

    // A soma das despesas pode levar dezenas de páginas: se demorar, mostra só esse item como indisponível.
    const despesas = await Promise.race([
      somarDespesas(dep.id, dep.leg_fim).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 25_000)),
    ]);
    const anos = Object.entries(despesas?.porAno ?? {}).sort(([a], [b]) => a - b);
    const legislaturas = dep.leg_fim - dep.leg_ini + 1;

    const votacoes = votacoesCamara(db, dep);

    return {
      correspondencia: 'nome_nascimento',
      link: `https://www.camara.leg.br/deputados/${dep.id}`,
      listasExtras: votacoes.listas,
      indicadores: [
        {
          rotulo: 'Na Câmara',
          valor: legislaturas === 1
            ? PERIODO_LEGISLATURA(dep.leg_ini)
            : `${anoInicio(dep.leg_ini)}–${dep.leg_fim >= LEGISLATURA_ATUAL ? 'hoje' : anoInicio(dep.leg_fim) + 4}`,
          detalhe: [
            legislaturas > 1 && 'da primeira à última legislatura (pode haver intervalos sem mandato)',
            s.situacao && `situação atual: ${s.situacao.toLowerCase()}`,
          ].filter(Boolean).join(' · '),
        },
        { rotulo: 'Proposições de autoria', valor: totalProps.toLocaleString('pt-BR'), detalhe: 'inclui requerimentos e emendas' },
        {
          rotulo: `Cota parlamentar (legislatura ${PERIODO_LEGISLATURA(dep.leg_fim)})`,
          valor: !despesas ? 'indisponível' : despesas.qtd ? brl(despesas.total) : 'sem dados',
          detalhe: !despesas
            ? 'A API da Câmara demorou a responder. Tente de novo mais tarde.'
            : despesas.qtd
              ? `${despesas.qtd.toLocaleString('pt-BR')} despesas · ${anos.map(([a, v]) => `${a}: ${brl(v)}`).join(' · ')}`
              : 'A Câmara não publica despesas desse período pela API.',
        },
        ...votacoes.indicadores,
      ],
      registros: props.dados.map((x) => ({
        titulo: `${x.siglaTipo} ${x.numero}/${x.ano}`,
        detalhe: x.ementa,
        data: x.dataApresentacao?.slice(0, 10),
        link: `https://www.camara.leg.br/propostas-legislativas/${x.id}`,
      })),
      tituloRegistros: 'Proposições mais recentes',
    };
  },
};

// ---------------------------------------------------------------- Senado

// Siglas usadas pelo Senado no registro de voto.
const SIGLAS_VOTO_SENADO = {
  Votou: 'votação secreta (voto não divulgado)', Abstenção: 'abstenção', 'P-NRV': 'presente sem registrar voto',
  AP: 'ausente por atividade parlamentar', MIS: 'ausente em missão', LS: 'licença saúde', LP: 'licença particular',
  NCom: 'não compareceu', 'P-OD': 'presente (obstrução)', 'Presidente (art. 51 RISF)': 'presidindo a sessão', REP: 'representação',
};

let cacheSenadores = null;
async function listaSenadores() {
  if (cacheSenadores) return cacheSenadores;
  const { dados } = await httpJson(`${SENADO}/senador/lista/legislatura/47/${LEGISLATURA_ATUAL}.json`, { timeout: 40_000 });
  cacheSenadores = dados.ListaParlamentarLegislatura.Parlamentares.Parlamentar.map((s) => s.IdentificacaoParlamentar);
  return cacheSenadores;
}

export const senado = {
  id: 'senado',
  nome: 'Atuação no Senado Federal',
  orgao: 'Senado Federal – Dados Abertos',
  descricao: 'Matérias legislativas de autoria do(a) senador(a).',
  aplicavel: () => true,
  async consultar(p, { db }) {
    const candidatos = (await listaSenadores()).filter((s) => normalizar(s.NomeCompletoParlamentar) === p.nome_norm);
    let sen = null;
    for (const c of candidatos) {
      const { dados } = await httpJson(`${SENADO}/senador/${c.CodigoParlamentar}.json`);
      const nasc = dataBr(dados.DetalheParlamentar?.Parlamentar?.DadosBasicosParlamentar?.DataNascimento);
      if (p.nascimento && nasc === p.nascimento) { sen = c; break; }
    }
    if (!sen) return naoEncontrado('no Senado');

    const { dados } = await httpJson(`${SENADO}/processo?codigoParlamentarAutor=${sen.CodigoParlamentar}`, { timeout: 40_000 });
    const materias = Array.isArray(dados) ? dados : [];
    materias.sort((a, b) => String(b.dataApresentacao).localeCompare(String(a.dataApresentacao)));

    // Votações nominais dos últimos 4 anos (API do Senado aceita intervalo por ano).
    const anoAtual = new Date().getFullYear();
    const porAno = await Promise.all([0, 1, 2, 3].map((k) => httpJson(
      `${SENADO}/votacao?codigoParlamentar=${sen.CodigoParlamentar}&dataInicio=${anoAtual - k}-01-01&dataFim=${anoAtual - k}-12-31`,
      { timeout: 40_000 }).then((r) => (Array.isArray(r.dados) ? r.dados : [])).catch(() => [])));
    const votacoes = porAno.flat().map((v) => ({
      ...v, meuVoto: (v.votos ?? []).find((x) => String(x.codigoParlamentar) === String(sen.CodigoParlamentar))?.siglaVotoParlamentar,
    })).filter((v) => v.meuVoto).sort((a, b) => String(b.dataSessao).localeCompare(String(a.dataSessao)));
    const contagem = {};
    for (const v of votacoes) contagem[v.meuVoto] = (contagem[v.meuVoto] ?? 0) + 1;
    const simNao = (contagem.Sim ?? 0) + (contagem['Não'] ?? 0);
    const linhaVoto = (v) => ({
      titulo: `${v.identificacao} – votou ${v.meuVoto}`,
      situacao: [v.descricaoVotacao?.slice(0, 160), v.resultadoVotacao === 'A' ? 'aprovada' : v.resultadoVotacao === 'R' ? 'rejeitada' : null].filter(Boolean).join(' · '),
      detalhe: v.ementa,
      data: v.dataSessao?.split('-').reverse().join('/'),
      link: v.codigoMateria ? `https://www25.senado.leg.br/web/atividade/materias/-/materia/${v.codigoMateria}` : null,
    });

    // Cota parlamentar (CEAPS) pelo nome parlamentar.
    const ceaps = db.prepare('SELECT ano, SUM(total) AS total, SUM(qtd) AS qtd FROM sen_ceaps WHERE senador = ? GROUP BY ano ORDER BY ano')
      .all(normalizar(sen.NomeParlamentar));
    const ceapsTotal = ceaps.reduce((s, x) => s + x.total, 0);

    return {
      correspondencia: 'nome_nascimento',
      link: `https://www25.senado.leg.br/web/senadores/senador/-/perfil/${sen.CodigoParlamentar}`,
      listasExtras: [
        votacoes.some((v) => v.sigla === 'PEC') && { titulo: 'Votos em PECs (últimos 4 anos)', registros: votacoes.filter((v) => v.sigla === 'PEC').slice(0, 20).map(linhaVoto) },
        votacoes.length && { titulo: 'Votações nominais mais recentes', registros: votacoes.slice(0, 15).map(linhaVoto), recolhido: true },
      ].filter(Boolean),
      indicadores: [
        { rotulo: 'Matérias de autoria', valor: materias.length.toLocaleString('pt-BR') },
        { rotulo: 'Em tramitação', valor: materias.filter((m) => m.tramitando === 'Sim').length.toLocaleString('pt-BR') },
        votacoes.length && { rotulo: `Votações nominais (${anoAtual - 3}–${anoAtual})`, valor: votacoes.length.toLocaleString('pt-BR'),
          detalhe: `${simNao} com voto Sim/Não · ${Object.entries(contagem).filter(([k]) => !['Sim', 'Não'].includes(k))
            .map(([k, n]) => `${SIGLAS_VOTO_SENADO[k] ?? k}: ${n}`).join(' · ') || 'sem outros registros'}` },
        ceaps.length && { rotulo: `Cota parlamentar – CEAPS (${ceaps[0].ano}–${ceaps.at(-1).ano})`, valor: brl(ceapsTotal),
          detalhe: ceaps.map((x) => `${x.ano}: ${brl(x.total)}`).join(' · ') },
      ].filter(Boolean),
      registros: materias.slice(0, 5).map((m) => ({
        titulo: m.identificacao,
        detalhe: m.ementa,
        situacao: m.siglaTipoDeliberacao?.replace(/_/g, ' ').toLowerCase(),
        data: m.dataApresentacao,
        link: `https://www25.senado.leg.br/web/atividade/materias/-/materia/${m.codigoMateria}`,
      })),
      tituloRegistros: 'Matérias mais recentes',
    };
  },
};
