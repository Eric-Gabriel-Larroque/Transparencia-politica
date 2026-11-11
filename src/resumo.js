// Resumo determinístico do perfil: só contagens, somas e comparações com regras fixas.
// Nada aqui interpreta texto ou dá nota. Cada linha diz de que fonte veio.

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const plural = (n, um, varios) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;

export function montarResumo(p, fontes) {
  const linhas = [];
  const fonte = (id) => fontes.find((f) => f.id === id);
  const c = p.candidaturas;

  // Trajetória eleitoral
  const eleito = c.filter((x) => /^ELEITO/i.test(x.resultado ?? ''));
  const anos = c.map((x) => x.ano);
  linhas.push({
    tipo: 'trajetoria',
    texto: `${plural(c.length, 'candidatura', 'candidaturas')} ${Math.min(...anos) === Math.max(...anos) ? `(${anos[0]})` : `entre ${Math.min(...anos)} e ${Math.max(...anos)}`}; ${eleito.length ? `eleito(a) ${plural(eleito.length, 'vez', 'vezes')}` : 'não foi eleito(a)'}.`,
    detalhe: eleito.length ? `Mandatos conquistados: ${eleito.map((x) => `${x.cargo} (${x.ano}${x.unidade ? `, ${x.unidade}` : ''})`).join('; ')}` : null,
    fonte: 'TSE',
  });

  // Evolução patrimonial declarada
  const bens = fonte('tse')?.bens ?? [];
  if (bens.length >= 2) {
    const [primeiro, ultimo] = [bens[0], bens.at(-1)];
    const variacao = primeiro.total > 0 ? Math.round(((ultimo.total - primeiro.total) / primeiro.total) * 100) : null;
    linhas.push({
      tipo: 'bens',
      texto: `Bens declarados passaram de ${brl(primeiro.total)} (${primeiro.ano}) para ${brl(ultimo.total)} (${ultimo.ano})${variacao != null ? `: ${variacao >= 0 ? '+' : ''}${variacao.toLocaleString('pt-BR')}%` : ''}.`,
      detalhe: 'Valores nominais, como declarados pelo próprio candidato ao TSE, sem correção pela inflação.',
      fonte: 'TSE',
    });
  } else if (bens.length === 1) {
    linhas.push({ tipo: 'bens', texto: `Bens declarados em ${bens[0].ano}: ${brl(bens[0].total)}.`, fonte: 'TSE' });
  }

  // Registros em órgãos de controle e Justiça
  for (const id of ['tse', 'tcu', 'cnj', 'cgu']) {
    const f = fonte(id);
    if (!f || f.status !== 'ok') continue;
    // Confirmado = cruzado por CPF. Só por nome = pode ser outra pessoa com o mesmo nome.
    const regs = f.registros ?? [];
    const porNome = regs.filter((r) => (r.correspondencia ?? f.correspondencia) === 'nome').length;
    const n = regs.length - porNome;
    const [com, sem] = {
      tse: ['registro(s) de candidatura indeferido(s) ou cassado(s)', 'Nenhum registro de candidatura indeferido ou cassado'],
      tcu: ['registro(s) nas listas de responsáveis do TCU', 'Nenhum registro nas listas de responsáveis do TCU'],
      cnj: ['condenação(ões) por improbidade no cadastro do CNJ', 'Nenhuma condenação por improbidade no cadastro do CNJ'],
      cgu: ['sanção(ões) no Portal da Transparência', 'Nenhuma sanção no Portal da Transparência'],
    }[id];
    const sigla = f.orgao.split(' – ')[0];
    if (id === 'tse') { linhas.push({ tipo: n ? 'alerta' : 'limpo', texto: n ? `${n} ${com}.` : `${sem}.`, fonte: sigla }); continue; }
    if (n) linhas.push({ tipo: 'alerta', texto: `${n} ${com}, confirmado(s) pelo CPF.`, fonte: sigla });
    else if (f.correspondencia === 'cpf') linhas.push({ tipo: 'limpo', texto: `${sem} pelo CPF.`, fonte: sigla });
    else if (!porNome) linhas.push({ tipo: 'limpo', texto: `${sem} pelo nome completo (o TSE não divulgou o CPF).`, fonte: sigla });
    if (porNome) {
      linhas.push({
        tipo: 'aviso',
        texto: `${porNome} registro(s) de alguém com o mesmo nome completo, sem CPF para confirmar se é a mesma pessoa.`,
        detalhe: 'Pode ser homônimo. Abra cada registro na fonte oficial antes de tirar conclusões.',
        fonte: sigla,
      });
    }
  }

  // Atuação parlamentar
  for (const id of ['camara', 'senado']) {
    const f = fonte(id);
    if (f?.status !== 'ok' || !f.indicadores?.length) continue;
    linhas.push({
      tipo: 'atuacao',
      texto: f.indicadores.map((i) => `${i.rotulo}: ${i.valor}`).join(' · '),
      fonte: f.orgao.split(' – ')[0],
    });
  }

  // Fontes que não responderam
  const falhas = fontes.filter((f) => f.status === 'erro');
  if (falhas.length) {
    linhas.push({ tipo: 'aviso', texto: `Não foi possível consultar agora: ${falhas.map((f) => f.orgao.split(' – ')[0]).join(', ')}. O resumo pode estar incompleto.` });
  }
  return linhas;
}
