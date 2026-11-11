// Financiamento de campanha (TSE – prestação de contas eleitorais), já somado no índice local.
// Mostra de onde veio o dinheiro de cada campanha, quem mais doou e com quem mais se gastou.

import { linkContasTse } from '../lib/db.js';

// "Dinheiro público" = fundo eleitoral (FEFC) + fundo partidário, como o TSE classifica a fonte da receita.
const PUBLICAS = new Set(['FUNDO ESPECIAL', 'FUNDO PARTIDARIO']);
const NOME_FONTE = {
  'FUNDO ESPECIAL': 'Fundo Eleitoral (FEFC) – público',
  'FUNDO PARTIDARIO': 'Fundo Partidário – público',
  'OUTROS RECURSOS': 'Outros recursos (doações, recursos próprios…)',
};

export function carregarFinanciamento(db, candidaturas) {
  const q = (sql) => db.prepare(sql);
  const fontes = q('SELECT fonte, total, qtd FROM fin_fonte WHERE ano = ? AND sq = ? ORDER BY total DESC');
  const origens = q('SELECT origem, total, qtd FROM fin_origem WHERE ano = ? AND sq = ? ORDER BY total DESC');
  const doadores = q('SELECT nome, doc, origem, total, qtd FROM fin_doador WHERE ano = ? AND sq = ? ORDER BY total DESC LIMIT 10');
  const despesas = q('SELECT categoria, total, qtd FROM fin_despesa WHERE ano = ? AND sq = ? ORDER BY total DESC');
  const fornecedores = q('SELECT nome, doc, total, qtd FROM fin_fornecedor WHERE ano = ? AND sq = ? ORDER BY total DESC LIMIT 10');

  const campanhas = [];
  for (const c of candidaturas) {
    const f = fontes.all(c.ano, c.sq);
    const d = despesas.all(c.ano, c.sq);
    if (!f.length && !d.length) continue;
    const arrecadado = f.reduce((s, x) => s + x.total, 0);
    const publico = f.filter((x) => PUBLICAS.has(x.fonte)).reduce((s, x) => s + x.total, 0);
    const gasto = d.reduce((s, x) => s + x.total, 0);
    campanhas.push({
      ano: c.ano,
      cargo: c.cargo,
      unidade: c.unidade,
      arrecadado,
      publico,
      percentualPublico: arrecadado > 0 ? Math.round((publico / arrecadado) * 100) : 0,
      gasto,
      fontes: f.map((x) => ({ ...x, nome: NOME_FONTE[x.fonte] ?? x.fonte })),
      origens: origens.all(c.ano, c.sq),
      doadores: doadores.all(c.ano, c.sq),
      despesas: d.slice(0, 8),
      fornecedores: fornecedores.all(c.ano, c.sq),
      link: linkContasTse(c.ano),
    });
  }
  return campanhas.sort((a, b) => b.ano - a.ano);
}
