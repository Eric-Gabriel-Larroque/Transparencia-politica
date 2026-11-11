// Resumo determinístico do perfil: só contagens, somas e comparações com regras fixas.
// Nada aqui interpreta texto ou dá nota. Cada linha diz de que fonte veio, com link.

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const plural = (n, um, varios) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;

/** O que a ficha NÃO consulta. Aparece sempre, para "nada encontrado" não ser lido como "ficha limpa". */
export const NAO_COBRE = [
  'Condenações criminais confirmadas por CPF: não existe base pública unificada. A seção do Diário de Justiça mostra processos publicados desde 2024, mas só pelo nome (pode haver homônimos) e sem os processos em sigilo.',
  'Processos no STF: o portal do Supremo bloqueia consultas automáticas.',
  'Inelegibilidade declarada pela Justiça Eleitoral em ações próprias (como AIJE), quando a pessoa não se candidatou depois da decisão.',
  'Tribunais de contas estaduais e municipais.',
  'Candidaturas anteriores a 2018.',
];

// Frases por fonte: [com registros, sem registros]. Dizem exatamente o que foi buscado e onde.
const FRASES = {
  tse: ['registro(s) de candidatura indeferido(s) ou cassado(s) pela Justiça Eleitoral',
    'Nenhum registro de candidatura indeferido ou cassado entre as candidaturas desde 2018'],
  tcu: ['registro(s) nas listas de responsáveis do TCU',
    'Nenhum registro nas listas de responsáveis do TCU (contas irregulares, inabilitados, inidôneos)'],
  cnj: ['condenação(ões) cível(is) por improbidade administrativa no cadastro do CNJ',
    'Nenhuma condenação cível por improbidade administrativa no cadastro do CNJ'],
  cgu: ['sanção(ões) administrativa(s) no Portal da Transparência',
    'Nenhuma sanção administrativa no Portal da Transparência (CEIS, CNEP, CEAF)'],
};

export function montarResumo(p, fontes) {
  const linhas = [];
  const fonte = (id) => fontes.find((f) => f.id === id);
  const c = p.candidaturas;
  const tse = fonte('tse');

  // Trajetória eleitoral
  const eleito = c.filter((x) => /^ELEITO/i.test(x.resultado ?? ''));
  const anos = c.map((x) => x.ano);
  linhas.push({
    tipo: 'trajetoria',
    texto: `${plural(c.length, 'candidatura', 'candidaturas')} ${Math.min(...anos) === Math.max(...anos) ? `(${anos[0]})` : `entre ${Math.min(...anos)} e ${Math.max(...anos)}`}; ${eleito.length ? `eleito(a) ${plural(eleito.length, 'vez', 'vezes')}` : 'não foi eleito(a)'}.`,
    detalhe: eleito.length ? `Mandatos conquistados: ${eleito.map((x) => `${x.cargo} (${x.ano}${x.unidade ? `, ${x.unidade}` : ''})`).join('; ')}` : null,
    fonte: 'TSE',
    link: tse?.link,
  });

  // Evolução patrimonial declarada
  const bens = tse?.bens ?? [];
  if (bens.length >= 2) {
    const [primeiro, ultimo] = [bens[0], bens.at(-1)];
    const variacao = primeiro.total > 0 ? Math.round(((ultimo.total - primeiro.total) / primeiro.total) * 100) : null;
    linhas.push({
      tipo: 'bens',
      texto: `Bens declarados ao TSE passaram de ${brl(primeiro.total)} (${primeiro.ano}) para ${brl(ultimo.total)} (${ultimo.ano})${variacao != null ? `: ${variacao >= 0 ? '+' : ''}${variacao.toLocaleString('pt-BR')}%` : ''}.`,
      detalhe: 'Soma dos bens que o próprio candidato declarou ao registrar cada candidatura. Valores nominais, sem correção pela inflação. Veja a lista de cada bem na seção "Bens declarados".',
      fonte: 'TSE',
      link: ultimo.link,
    });
  } else if (bens.length === 1) {
    linhas.push({
      tipo: 'bens',
      texto: `Bens declarados ao TSE em ${bens[0].ano}: ${brl(bens[0].total)}.`,
      detalhe: 'Soma dos bens que o próprio candidato declarou ao registrar a candidatura.',
      fonte: 'TSE',
      link: bens[0].link,
    });
  }

  // Registros em órgãos de controle e Justiça
  for (const id of ['tse', 'tcu', 'cnj', 'cgu']) {
    const f = fonte(id);
    if (!f || f.status !== 'ok') continue;
    // Confirmado = cruzado por CPF. Só por nome = pode ser outra pessoa com o mesmo nome.
    const regs = f.registros ?? [];
    const porNome = regs.filter((r) => (r.correspondencia ?? f.correspondencia) === 'nome').length;
    const n = regs.length - porNome;
    const [com, sem] = FRASES[id];
    const base = { fonte: f.orgao.split(' – ')[0], link: f.link };
    if (id === 'tse') {
      linhas.push({ ...base, tipo: n ? 'alerta' : 'limpo', texto: n ? `${n} ${com}.` : `${sem}.`,
        detalhe: n ? regs.map((r) => `${r.titulo}${r.detalhe ? ` (${r.detalhe})` : ''}`).join('; ') : null });
      continue;
    }
    if (n) linhas.push({ ...base, tipo: 'alerta', texto: `${n} ${com}, confirmado(s) pelo CPF.` });
    else if (f.correspondencia === 'cpf') linhas.push({ ...base, tipo: 'limpo', texto: `${sem} (busca pelo CPF).` });
    else if (!porNome) linhas.push({ ...base, tipo: 'limpo', texto: `${sem} (busca pelo nome completo; o TSE não divulgou o CPF).` });
    if (porNome) {
      linhas.push({
        ...base,
        tipo: 'aviso',
        texto: `${porNome} registro(s) de alguém com o mesmo nome completo, sem CPF para confirmar se é a mesma pessoa.`,
        detalhe: 'Pode ser homônimo. Abra cada registro na fonte oficial antes de tirar conclusões.',
      });
    }
  }

  // Processos no Diário de Justiça (sempre só por nome: vira aviso, nunca alerta)
  const dj = fonte('djen');
  if (dj?.status === 'ok') {
    const k = dj.contagem ?? { total: 0, criminal: 0, improbidade: 0, outros: 0, onde: '' };
    const extras = [k.criminal && `${k.criminal} de classe criminal`, k.improbidade && `${k.improbidade} de improbidade/ação civil pública`].filter(Boolean);
    linhas.push(k.total ? {
      tipo: 'aviso',
      texto: `${k.total} processo(s) com publicação no Diário de Justiça desde 2024 em tribunais de ${k.onde}, em nome de alguém com o mesmo nome completo${extras.length ? ` (${extras.join(', ')})` : ''}.`,
      detalhe: 'Sem CPF para confirmar que é a mesma pessoa. Aparecer num processo não significa culpa. Veja a lista na seção do Diário de Justiça.',
      fonte: 'DJEN', link: dj.link,
    } : {
      tipo: 'limpo',
      texto: `Nenhuma publicação no Diário de Justiça desde 2024 com esse nome completo em tribunais de ${k.onde} (processos em sigilo não aparecem).`,
      detalhe: k.outros ? `Há ${k.outros} processo(s) com o mesmo nome em outros estados, provavelmente de outras pessoas.` : null,
      fonte: 'DJEN', link: dj.link,
    });
  }

  // Atuação parlamentar
  for (const id of ['camara', 'senado']) {
    const f = fonte(id);
    if (f?.status !== 'ok' || !f.indicadores?.length) continue;
    linhas.push({
      tipo: 'atuacao',
      texto: f.indicadores.map((i) => `${i.rotulo}: ${i.valor}`).join(' · '),
      fonte: f.orgao.split(' – ')[0],
      link: f.link,
    });
  }

  // Fontes que não responderam
  const falhas = fontes.filter((f) => f.status === 'erro');
  if (falhas.length) {
    const nomeCurto = (f) => (f.id === 'djen' ? 'Diário de Justiça (DJEN)' : f.orgao.split(' – ')[0]);
    linhas.push({ tipo: 'aviso', texto: `Não foi possível consultar agora: ${falhas.map(nomeCurto).join(', ')}. O resumo pode estar incompleto.` });
  }
  return linhas;
}
