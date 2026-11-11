// DJEN – Diário de Justiça Eletrônico Nacional (CNJ).
// Reúne as publicações e intimações de todos os tribunais do país (desde 2024).
// API pública: https://comunicaapi.pje.jus.br/api/v1/comunicacao
//
// Atenção:
// - A API bloqueia acessos de fora do Brasil (CloudFront geo-block). No VPS, só o IPv4 é
//   reconhecido como brasileiro (por isso o servidor prefere IPv4; ver server.js).
// - A busca é pelo NOME da parte: não há CPF. Para reduzir homônimos, separamos os processos
//   em tribunais do(s) estado(s) onde a pessoa concorreu e tribunais superiores ("relevantes")
//   dos demais ("outros estados", provavelmente outras pessoas).
// - Processos sob sigilo não são publicados no DJEN.
// - Aparecer num processo não significa culpa: pode ser réu, autor, testemunha, vítima...

import { http, normalizar } from '../lib/util.js';

const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const CONSULTA = 'https://comunica.pje.jus.br/consulta';
const POR_PAGINA = 100;
const LIMITE_NOME_COMUM = 500; // acima disso, busca direto nos tribunais relevantes

// ---------------------------------------------------------------- classificação

// Classes processuais de natureza criminal (pelo nome da classe, sem interpretar o texto).
const CRIMINAL = /PENAL|CRIM|INQU[EÉ]RITO|TERMO CIRCUNSTANCIADO|HABEAS CORPUS|PRIS[AÃ]O|DEN[UÚ]NCIA|QUEIXA|MEDIDAS? PROTETIVAS?|EXECU[CÇ][AÃ]O DA PENA/i;
// Ações de improbidade e afins (cíveis, mas relacionadas à administração pública).
const IMPROBIDADE = /IMPROBIDADE|A[CÇ][AÃ]O POPULAR|A[CÇ][AÃ]O CIVIL P[UÚ]BLICA/i;

function natureza(classe) {
  if (CRIMINAL.test(classe ?? '')) return 'criminal';
  if (IMPROBIDADE.test(classe ?? '')) return 'improbidade';
  return 'outros';
}

// ---------------------------------------------------------------- tribunais e estados

const SUPERIORES = ['STF', 'STJ', 'TSE', 'TST', 'STM'];
const TRF = { 1: 'AC AM AP BA DF GO MA MT PA PI RO RR TO', 2: 'RJ ES', 3: 'SP MS', 4: 'RS SC PR', 5: 'PE AL CE PB RN SE', 6: 'MG' };
const TRT = {
  1: 'RJ', 2: 'SP', 3: 'MG', 4: 'RS', 5: 'BA', 6: 'PE', 7: 'CE', 8: 'PA AP', 9: 'PR', 10: 'DF TO', 11: 'AM RR', 12: 'SC',
  13: 'PB', 14: 'RO AC', 15: 'SP', 16: 'MA', 17: 'ES', 18: 'GO', 19: 'AL', 20: 'SE', 21: 'RN', 22: 'PI', 23: 'MT', 24: 'MS',
};
const ufsDe = (mapa, n) => (mapa[n] ?? '').split(' ').filter(Boolean);

/** Estados cobertos por um tribunal, ou 'superior'. null = não identificado (ex.: SEEU). */
function abrangencia(sigla) {
  const s = String(sigla ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (SUPERIORES.includes(s)) return 'superior';
  if (s === 'TJDFT') return ['DF'];
  let m = s.match(/^TJ([A-Z]{2})$/); if (m) return [m[1]];
  m = s.match(/^TRE([A-Z]{2})$/); if (m) return [m[1]];
  m = s.match(/^TJM([A-Z]{2})$/); if (m) return [m[1]];
  m = s.match(/^TRF(\d)$/); if (m) return ufsDe(TRF, m[1]);
  m = s.match(/^TRT(\d{1,2})$/); if (m) return ufsDe(TRT, Number(m[1]));
  return null;
}

// Numeração única do CNJ (Res. 65/2008): NNNNNNN-DD.AAAA.J.TR.OOOO
// J = ramo da Justiça; TR = tribunal; OOOO = unidade de origem.
const ESTADOS_TR = ['', 'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE',
  'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SE', 'SP', 'TO'];
// Seções judiciárias do TRF1 pelos dois primeiros dígitos da origem (conferido com publicações reais: 33 BA, 34 DF, 35 GO, 36 MT, 37 MA, 40 PI, 41 RO).
const SECOES_TRF1 = { 30: 'AC', 31: 'AP', 32: 'AM', 33: 'BA', 34: 'DF', 35: 'GO', 36: 'MT', 37: 'MA', 38: 'MG', 39: 'PA', 40: 'PI', 41: 'RO', 42: 'RR', 43: 'TO' };

/** Estado(s) de origem pelo número do processo; 'superior' para ações originárias dos tribunais superiores; null se não der. */
function origemPeloNumero(numero) {
  const d = String(numero ?? '').replace(/\D/g, '');
  if (d.length !== 20) return null;
  const j = Number(d[13]);
  const tr = Number(d.slice(14, 16));
  const origem = d.slice(16, 20);
  if ([1, 2, 3, 7].includes(j)) return 'superior'; // STF, CNJ, STJ, Justiça Militar da União
  if ([6, 8, 9].includes(j)) return ESTADOS_TR[tr] ? [ESTADOS_TR[tr]] : null; // eleitoral, estadual, militar estadual
  if (j === 5) return ufsDe(TRT, tr).length ? ufsDe(TRT, tr) : null; // trabalho
  if (j === 4) {
    if (tr === 1) { const uf = SECOES_TRF1[Number(origem.slice(0, 2))]; return uf ? [uf] : ufsDe(TRF, 1); }
    return ufsDe(TRF, tr).length ? ufsDe(TRF, tr) : null;
  }
  return null;
}

/** Siglas dos tribunais onde vale procurar uma pessoa que concorreu nessas UFs. */
function tribunaisRelevantes(ufs) {
  const siglas = new Set(SUPERIORES);
  for (const uf of ufs) {
    siglas.add(uf === 'DF' ? 'TJDFT' : `TJ${uf}`);
    siglas.add(`TRE-${uf}`);
    for (const [n, lista] of Object.entries(TRF)) if (lista.includes(uf)) siglas.add(`TRF${n}`);
    for (const [n, lista] of Object.entries(TRT)) if (lista.split(' ').includes(uf)) siglas.add(`TRT${n}`);
  }
  return [...siglas];
}

// ---------------------------------------------------------------- utilidades de texto

const ENTIDADES = { nbsp: ' ', amp: '&', quot: '"', lt: '<', gt: '>', ordf: 'ª', ordm: 'º', deg: '°' };
function decodificar(s) {
  return String(s ?? '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (orig, nome) => {
      if (ENTIDADES[nome]) return ENTIDADES[nome];
      const m = nome.match(/^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil)$/);
      if (!m) return orig;
      const marca = { acute: '́', grave: '̀', circ: '̂', tilde: '̃', uml: '̈', cedil: '̧' }[m[2]];
      return (m[1] + marca).normalize('NFC');
    });
}
const semHtml = (s) => decodificar(String(s ?? '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const campo = (obj, ...nomes) => nomes.map((n) => obj?.[n]).find((v) => v != null && v !== '');

function dataBr(valor) {
  const s = String(valor ?? '');
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s.slice(0, 10) || null;
}
const ordenavel = (br) => (br ? br.split('/').reverse().join('') : '');
const POLOS = { A: 'polo ativo (autor)', P: 'polo passivo (réu/requerido)' };

// ---------------------------------------------------------------- consulta à API

async function pagina(params) {
  const qs = new URLSearchParams({ itensPorPagina: String(POR_PAGINA), ...params });
  let res;
  try {
    res = await http(`${API}?${qs}`, { headers: { Accept: 'application/json' }, timeout: 30_000 });
  } catch (e) {
    if (e.status === 403) {
      const erro = new Error('DJEN respondeu 403 (bloqueio por geolocalização do IP do servidor)');
      erro.mensagemPublica = 'Temporariamente indisponível: o serviço do CNJ não está aceitando consultas do nosso servidor. Você pode consultar diretamente no site do DJEN pelo link "fonte oficial".';
      throw erro;
    }
    throw e;
  }
  const dados = await res.json();
  const itens = dados.items ?? dados.itens ?? dados.content ?? [];
  return { itens, total: Number(dados.count ?? dados.total ?? dados.totalElements ?? itens.length) };
}

async function todasPaginas(params, maxPaginas) {
  const primeira = await pagina({ ...params, pagina: '1' });
  const itens = [...primeira.itens];
  const paginas = Math.min(Math.ceil(primeira.total / POR_PAGINA), maxPaginas);
  for (let p = 2; p <= paginas; p++) {
    const r = await pagina({ ...params, pagina: String(p) });
    itens.push(...r.itens);
    if (r.itens.length < POR_PAGINA) break;
  }
  return { itens, total: primeira.total };
}

/** Executa tarefas assíncronas com no máximo `n` ao mesmo tempo. */
async function emLotes(tarefas, n) {
  const resultados = [];
  for (let i = 0; i < tarefas.length; i += n) {
    resultados.push(...await Promise.all(tarefas.slice(i, i + n).map((t) => t().catch(() => null))));
  }
  return resultados.filter(Boolean);
}

// ---------------------------------------------------------------- fonte

export const djen = {
  id: 'djen',
  nome: 'Processos com publicação no Diário de Justiça',
  orgao: 'CNJ – Diário de Justiça Eletrônico Nacional (DJEN)',
  descricao: 'Processos de qualquer tribunal do país que tiveram publicação no DJEN desde 2024 com uma parte de nome idêntico. Mostramos primeiro os tribunais do(s) estado(s) onde a pessoa concorreu e os tribunais superiores. Processos em sigilo não aparecem.',
  aplicavel: () => true,
  linkConsulta: (p) => `${CONSULTA}?nomeParte=${encodeURIComponent(p.nome_norm)}`,
  async consultar(p) {
    const ufsCandidaturas = [...new Set(p.candidaturas.map((c) => c.uf).filter(Boolean))];
    // Quem concorreu a cargo nacional (UF "BR") tem a Justiça do DF como relevante, além dos superiores.
    const ufs = [...new Set(ufsCandidaturas.map((u) => (u === 'BR' ? 'DF' : u)))];
    const siglasRelevantes = tribunaisRelevantes(ufs);

    // 1) Busca geral: descobre quantas publicações existem com esse nome no país.
    const geral = await pagina({ nomeParte: p.nome_norm, pagina: '1' });
    const nomeComum = geral.total > LIMITE_NOME_COMUM;
    let itens = [...geral.itens];

    if (!nomeComum) {
      // Nome pouco comum: lê tudo (até 5 páginas).
      itens = (await todasPaginas({ nomeParte: p.nome_norm }, 5)).itens;
    } else {
      // Nome comum: busca direto nos tribunais relevantes para não perder nada entre milhares de homônimos.
      const lotes = await emLotes(siglasRelevantes.map((sigla) => () =>
        todasPaginas({ nomeParte: p.nome_norm, siglaTribunal: sigla }, 2)), 6);
      for (const l of lotes) itens.push(...l.itens);
    }

    // 2) Agrupa por processo; só aceita publicações em que algum destinatário tem o nome idêntico.
    const processos = new Map();
    const vistos = new Set();
    for (const it of itens) {
      const chave = it.id ?? it.hash ?? JSON.stringify([it.numero_processo, it.data_disponibilizacao]);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      const destinatarios = it.destinatarios ?? it.destinatario ?? [];
      const meu = destinatarios.find((d) => normalizar(campo(d, 'nome', 'nomeParte')) === p.nome_norm);
      if (!meu && destinatarios.length) continue;
      const numero = campo(it, 'numeroprocessocommascara', 'numeroProcessoComMascara', 'numero_processo', 'numeroProcesso');
      if (!numero) continue;
      const data = dataBr(campo(it, 'data_disponibilizacao', 'dataDisponibilizacao', 'datadisponibilizacao'));
      const classe = semHtml(campo(it, 'nomeClasse', 'classe', 'nome_classe')).toUpperCase() || null;
      const tribunal = campo(it, 'siglaTribunal', 'tribunal');
      // Estado de origem: primeiro pelo número do processo (mais preciso); senão, pela abrangência do tribunal.
      const abr = origemPeloNumero(numero) ?? abrangencia(tribunal);
      const atual = processos.get(numero) ?? {
        numero, classe, natureza: natureza(classe), tribunal,
        relevante: abr === 'superior' || (Array.isArray(abr) && abr.some((u) => ufs.includes(u))),
        origem: Array.isArray(abr) && abr.length === 1 ? abr[0] : null,
        orgao: semHtml(campo(it, 'nomeOrgao', 'orgao')) || null,
        polo: POLOS[campo(meu, 'polo')] ?? null,
        publicacoes: 0, ultima: null, link: null, trecho: null,
      };
      atual.publicacoes++;
      if (!atual.ultima || ordenavel(data) > ordenavel(atual.ultima)) {
        atual.ultima = data;
        atual.link = campo(it, 'link', 'url') ?? null;
        atual.trecho = semHtml(campo(it, 'texto', 'conteudo')).slice(0, 280) || null;
        atual.tipo = campo(it, 'tipoComunicacao', 'tipoDocumento');
      }
      processos.set(numero, atual);
    }

    const ordem = { criminal: 0, improbidade: 1, outros: 2 };
    const ordenar = (a, b) => ordem[a.natureza] - ordem[b.natureza] || ordenavel(b.ultima).localeCompare(ordenavel(a.ultima));
    const todos = [...processos.values()];
    const relevantes = todos.filter((x) => x.relevante).sort(ordenar);
    const outros = todos.filter((x) => !x.relevante).sort(ordenar);
    const contar = (lista, n) => lista.filter((x) => x.natureza === n).length;

    const rotuloNatureza = { criminal: 'Classe criminal', improbidade: 'Improbidade / ação civil pública', outros: null };
    const registro = (x) => ({
      titulo: `${x.classe ?? 'PROCESSO'} ${x.numero}`,
      situacao: [rotuloNatureza[x.natureza], x.origem ? `${x.tribunal} (origem: ${x.origem})` : x.tribunal, x.orgao, x.polo]
        .filter(Boolean).join(' · '),
      detalhe: [
        `${x.publicacoes} publicação(ões); última em ${x.ultima ?? '?'}${x.tipo ? ` (${x.tipo})` : ''}`,
        x.trecho && `Trecho: "${x.trecho}${x.trecho.length >= 280 ? '…' : ''}"`,
      ].filter(Boolean).join(' · '),
      correspondencia: 'nome',
      data: x.ultima,
      link: x.link || `${CONSULTA}?numeroProcesso=${encodeURIComponent(x.numero.replace(/\D/g, ''))}`,
    });

    const onde = ufs.length ? `${ufs.join(', ')} e tribunais superiores` : 'tribunais superiores';
    return {
      correspondencia: 'nome',
      link: `${CONSULTA}?nomeParte=${encodeURIComponent(p.nome_norm)}`,
      alerta: false, // só por nome: nunca é tratado como confirmado
      aviso: [
        nomeComum && `Nome muito comum: há ${geral.total.toLocaleString('pt-BR')} publicações no país com esse nome. Por isso buscamos direto nos tribunais de ${onde}.`,
        (relevantes.length || outros.length) && 'Busca feita só pelo nome completo: o DJEN não informa CPF, então pode ser outra pessoa com o mesmo nome. Aparecer num processo não significa culpa (a pessoa pode ser autora, ré, testemunha...). Confira cada processo na fonte.',
      ].filter(Boolean).join(' ') || null,
      indicadores: [
        { rotulo: `Processos em tribunais de ${onde}`, valor: relevantes.length.toLocaleString('pt-BR') },
        { rotulo: 'De classe criminal', valor: contar(relevantes, 'criminal').toLocaleString('pt-BR'), detalhe: 'pelo nome da classe processual' },
        { rotulo: 'Improbidade / ação civil pública', valor: contar(relevantes, 'improbidade').toLocaleString('pt-BR') },
        { rotulo: 'Em outros estados', valor: outros.length.toLocaleString('pt-BR'), detalhe: 'provavelmente outras pessoas com o mesmo nome' },
      ],
      contagem: {
        total: relevantes.length, criminal: contar(relevantes, 'criminal'), improbidade: contar(relevantes, 'improbidade'),
        outros: outros.length, onde,
      },
      tituloRegistros: relevantes.length ? `Processos em tribunais de ${onde} (criminais primeiro)` : null,
      registros: relevantes.slice(0, 40).map(registro),
      tituloOutros: outros.length ? `Em outros estados: ${outros.length} processo(s), provavelmente de outras pessoas com o mesmo nome` : null,
      registrosOutros: outros.slice(0, 30).map(registro),
    };
  },
};
