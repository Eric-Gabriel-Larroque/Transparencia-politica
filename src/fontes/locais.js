// Fontes que já estão no índice local (baixadas por "npm run indexar"): TSE e TCU.

const LINK_TSE = 'https://dadosabertos.tse.jus.br/dataset/?groups=candidatos';
const LINK_TCU = 'https://sites.tcu.gov.br/dados-abertos/inidoneos-irregulares/';

const NOMES_LISTA_TCU = {
  contas_irregulares: 'Contas julgadas irregulares',
  implicacao_eleitoral: 'Contas irregulares com possível implicação eleitoral',
  inabilitados: 'Inabilitado para cargo em comissão ou função de confiança',
  inidoneos: 'Declarado inidôneo para licitar',
};

export const tse = {
  id: 'tse',
  nome: 'Candidaturas, bens e julgamentos',
  orgao: 'TSE – Tribunal Superior Eleitoral',
  descricao: 'Todas as candidaturas registradas, situação do registro (deferido, indeferido, cassado), bens declarados e motivos de indeferimento/cassação.',
  aplicavel: () => true,
  async consultar(p, { db }) {
    const cassacoes = db.prepare(`
      SELECT s.ano, s.processo, s.tipo, s.motivo, c.cargo, c.unidade
      FROM cassacoes s JOIN candidaturas c ON c.ano = s.ano AND c.sq = s.sq
      WHERE c.pessoa = ? ORDER BY s.ano DESC`).all(p.pessoa);

    const registros = [];
    for (const c of p.candidaturas) {
      const problema = /INDEFERIDO|CASSADO|IMPUGNA|NÃO CONHECIDO/i.test(
        [c.detalhe_situacao, c.situacao_julgamento, c.situacao_cassacao].filter(Boolean).join(' '));
      if (!problema) continue;
      const motivos = cassacoes.filter((m) => m.ano === c.ano).map((m) => m.motivo).filter(Boolean);
      registros.push({
        titulo: `Registro ${c.detalhe_situacao?.toLowerCase() ?? 'com problema'} – ${c.cargo} ${c.ano}`,
        situacao: [c.detalhe_situacao, c.situacao_julgamento, c.situacao_cassacao].filter(Boolean).join(' · '),
        detalhe: motivos.length ? `Motivo(s) informado(s): ${[...new Set(motivos)].join('; ')}` : null,
        data: String(c.ano),
        link: LINK_TSE,
      });
    }

    const bens = p.candidaturas
      .filter((c) => c.bens_total != null)
      .map((c) => ({ ano: c.ano, total: c.bens_total, qtd: c.bens_qtd }))
      .sort((a, b) => a.ano - b.ano)
      .filter((b, i, arr) => i === arr.findIndex((x) => x.ano === b.ano));

    return {
      correspondencia: p.cpf ? 'cpf' : 'nome',
      link: LINK_TSE,
      registros,
      bens,
      alerta: registros.length > 0,
    };
  },
};

export const tcu = {
  id: 'tcu',
  nome: 'Listas de responsáveis',
  orgao: 'TCU – Tribunal de Contas da União',
  descricao: 'Gestores com contas julgadas irregulares pelo TCU (decisão já transitada em julgado), inabilitados para função pública e inidôneos.',
  aplicavel: () => true,
  async consultar(p, { db }) {
    // Com CPF: cruzamento exato. Sem CPF (ex.: quem só concorreu em 2024): nome completo idêntico + mesma UF.
    const ufs = [...new Set(p.candidaturas.map((c) => c.uf).filter(Boolean))];
    const linhas = p.cpf
      ? db.prepare('SELECT * FROM tcu WHERE cpf = ? ORDER BY lista, transito DESC').all(p.cpf)
      : db.prepare(`SELECT * FROM tcu WHERE nome_norm = ? AND uf IN (${ufs.map(() => '?').join(',') || "''"})
          ORDER BY lista, transito DESC`).all(p.nome_norm, ...ufs);
    return {
      correspondencia: p.cpf ? 'cpf' : 'nome',
      link: LINK_TCU,
      alerta: linhas.length > 0,
      aviso: !p.cpf && linhas.length
        ? 'O TSE não divulgou o CPF desta pessoa: o cruzamento foi feito pelo nome completo e pela UF. Pode ser homônimo.'
        : null,
      registros: linhas.map((l) => ({
        correspondencia: p.cpf ? 'cpf' : 'nome',
        titulo: NOMES_LISTA_TCU[l.lista] ?? l.lista,
        situacao: l.transito ? `Trânsito em julgado em ${l.transito}` : null,
        detalhe: [
          `Processo ${l.processo}`,
          l.acordao && `Acórdão ${l.acordao}`,
          l.data_final && `vigente até ${l.data_final}`,
          l.municipio && `${l.municipio}/${l.uf}`,
        ].filter(Boolean).join(' · '),
        data: l.data_acordao ?? l.transito,
        link: l.link_deliberacao || l.link_processo || LINK_TCU,
      })),
    };
  },
};
