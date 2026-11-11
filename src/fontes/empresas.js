// Empresas das quais o político é sócio (Receita Federal) + situação de cada empresa no governo federal (CGU).
//
// Cruzamento: a Receita publica o quadro de sócios com o CPF parcialmente mascarado (***456789**).
// Aceitamos o sócio quando o nome completo é idêntico E os 6 dígitos visíveis batem com o CPF divulgado
// pelo TSE: a chance de duas pessoas com o mesmo nome terem esses mesmos 6 dígitos é desprezível.

import { http } from '../lib/util.js';

const CGU = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const chave = () => process.env.CHAVE_PORTAL_TRANSPARENCIA;
const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

/** CNPJ da matriz (filial 0001) a partir do CNPJ básico, com dígitos verificadores. */
export function cnpjMatriz(basico) {
  const base = `${String(basico).padStart(8, '0')}0001`;
  const dv = (s) => {
    const pesos = s.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = [...s].reduce((acc, d, i) => acc + Number(d) * pesos[i], 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dv(base);
  const d2 = dv(base + d1);
  return `${base}${d1}${d2}`;
}
/**
 * Situação da empresa no Portal da Transparência. A API responde 200 com corpo vazio quando o CNPJ
 * não aparece em nenhum cadastro federal: isso significa "nada consta", não erro.
 */
async function situacaoFederal(cnpj) {
  try {
    const res = await http(`${CGU}/pessoa-juridica?cnpj=${cnpj}`, { headers: { 'chave-api-dados': chave(), Accept: 'application/json' } });
    const texto = (await res.text()).trim();
    return texto ? JSON.parse(texto) : {};
  } catch {
    return null; // falha de rede/limite: não afirma nada sobre a empresa
  }
}

const formatarCnpj = (c) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');

export const empresas = {
  id: 'empresas',
  nome: 'Empresas das quais é sócio(a)',
  orgao: 'Receita Federal (quadro de sócios) + CGU – Portal da Transparência',
  descricao: 'Empresas em que a pessoa aparece como sócia no cadastro da Receita Federal e, para cada uma, se tem contratos, pagamentos, convênios ou sanções no governo federal.',
  aplicavel: (p) => Boolean(p.cpf),
  motivoNaoAplicavel: 'Sem CPF divulgado pelo TSE: não dá para cruzar com o quadro de sócios com segurança.',
  async consultar(p, { db }) {
    const lista = db.prepare(`SELECT s.cnpj_basico, s.qualificacao, s.data_entrada, e.razao_social, e.capital, e.porte
      FROM empresa_socio s LEFT JOIN empresa e ON e.cnpj_basico = s.cnpj_basico WHERE s.cpf = ? ORDER BY e.capital DESC`).all(p.cpf);
    const mes = db.prepare("SELECT valor FROM meta WHERE chave = 'receita_mes'").get()?.valor;
    if (!lista.length) {
      return { correspondencia: 'nome_cpf_parcial', registros: [], indicadores: [],
        aviso: `Nenhuma empresa encontrada no quadro de sócios da Receita${mes ? ` (dados de ${mes})` : ''}.` };
    }

    // Situação de cada empresa no governo federal (até 15 empresas por consulta).
    const situacoes = chave()
      ? await Promise.all(lista.slice(0, 15).map((x) => situacaoFederal(cnpjMatriz(x.cnpj_basico))))
      : [];

    let comDinheiroFederal = 0;
    let sancionadas = 0;
    const registros = lista.map((x, i) => {
      const cnpj = cnpjMatriz(x.cnpj_basico);
      const s = situacoes[i];
      const marcas = s ? [
        s.possuiContratacao && 'tem contratos com o governo federal',
        s.favorecidoDespesas && 'recebeu pagamentos do governo federal',
        s.convenios && 'tem convênios',
        s.favorecidoTransferencias && 'recebeu transferências',
        (s.sancionadoCEIS || s.sancionadoCNEP || s.sancionadoCEPIM) &&
          `SANCIONADA (${['CEIS', 'CNEP', 'CEPIM'].filter((k) => s[`sancionado${k}`]).join(', ')})`,
      ].filter(Boolean) : [];
      if (s && (s.possuiContratacao || s.favorecidoDespesas || s.convenios || s.favorecidoTransferencias)) comDinheiroFederal++;
      if (s && (s.sancionadoCEIS || s.sancionadoCNEP || s.sancionadoCEPIM)) sancionadas++;
      return {
        titulo: x.razao_social ?? `CNPJ ${formatarCnpj(cnpj)}`,
        situacao: [x.qualificacao, x.data_entrada && `desde ${x.data_entrada}`, x.capital ? `capital social ${brl(x.capital)}` : null, x.porte]
          .filter(Boolean).join(' · '),
        detalhe: [`CNPJ ${formatarCnpj(cnpj)}`, marcas.length ? marcas.join(' · ') : (s ? 'sem contratos, pagamentos ou sanções no governo federal' : null)]
          .filter(Boolean).join(' · '),
        correspondencia: 'nome_cpf_parcial',
        link: `https://portaldatransparencia.gov.br/pessoa-juridica/${cnpj}`,
      };
    });

    return {
      correspondencia: 'nome_cpf_parcial',
      link: 'https://www.gov.br/receitafederal/dados',
      alerta: false,
      aviso: lista.length > 15 ? `Situação no governo federal consultada para as 15 empresas de maior capital (de ${lista.length}).` : null,
      contagem: { total: lista.length, comDinheiroFederal, sancionadas, consultadas: situacoes.length },
      indicadores: [
        { rotulo: 'Empresas em que é sócio(a)', valor: lista.length.toLocaleString('pt-BR'), detalhe: mes ? `Receita Federal, dados de ${mes}` : null },
        situacoes.length && { rotulo: 'Com contratos, pagamentos ou convênios federais', valor: comDinheiroFederal.toLocaleString('pt-BR') },
        situacoes.length && { rotulo: 'Sancionadas (CEIS, CNEP, CEPIM)', valor: sancionadas.toLocaleString('pt-BR') },
      ].filter(Boolean),
      tituloRegistros: 'Empresas (maior capital social primeiro)',
      registros,
    };
  },
};
