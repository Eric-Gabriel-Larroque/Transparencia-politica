// CGU – Portal da Transparência (API de dados). Exige chave gratuita:
// https://portaldatransparencia.gov.br/api-de-dados/cadastrar-email
// Defina a variável de ambiente CHAVE_PORTAL_TRANSPARENCIA para ativar esta fonte.

import { httpJson, numeroBr, normalizar } from '../lib/util.js';
import { filaCgu } from '../lib/limitador.js';

const BASE = 'https://api.portaldatransparencia.gov.br/api-de-dados';
const chave = () => process.env.CHAVE_PORTAL_TRANSPARENCIA;

async function get(caminho) {
  // Toda chamada passa pela fila com limite por minuto (a API da CGU recusa acima de ~90/min).
  const { dados } = await filaCgu(() => httpJson(`${BASE}/${caminho}`, { headers: { 'chave-api-dados': chave() } }));
  return Array.isArray(dados) ? dados : [];
}

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const cgu = {
  id: 'cgu',
  nome: 'Sanções e emendas parlamentares',
  orgao: 'CGU – Portal da Transparência',
  descricao: 'Sanções (CEIS, CNEP), expulsões da administração federal (CEAF), cadastro de pessoas expostas politicamente e emendas parlamentares.',
  aplicavel: (p) => Boolean(chave()) && Boolean(p.cpf),
  motivoNaoAplicavel: () => (chave()
    ? 'Sem CPF divulgado pelo TSE: não dá para cruzar com segurança.'
    : 'Fonte desativada: falta a chave da API do Portal da Transparência (variável CHAVE_PORTAL_TRANSPARENCIA).'),
  async consultar(p, { db }) {
    const [ceis, cnep, ceaf, peps] = await Promise.all([
      get(`ceis?codigoSancionado=${p.cpf}&pagina=1`),
      get(`cnep?codigoSancionado=${p.cpf}&pagina=1`),
      get(`ceaf?cpfSancionado=${p.cpf}&pagina=1`),
      get(`peps?cpf=${p.cpf}&pagina=1`),
    ]);

    // Emendas: a API filtra pelo nome do autor (nome parlamentar), 15 por página.
    const MAX_PAGINAS = 12; // até 180 emendas por autor; acima disso mostra "mais de"
    // Só faz sentido para quem disputou mandato federal. A API busca por trecho do nome e é sensível
    // a acentos (guarda sem acento). Aceita o autor só se todas as palavras do nome dele na CGU
    // estiverem no nome civil completo ("EUNICIO OLIVEIRA" ⊂ "EUNICIO LOPES DE OLIVEIRA").
    const federal = p.cargos.some((c) => /DEPUTADO FEDERAL|SENADOR/i.test(c))
      || Boolean(p.nascimento && db.prepare('SELECT 1 FROM camara_deputados WHERE nome_norm = ? AND nascimento = ?')
        .get(p.nome_norm, p.nascimento));
    const palavrasCivis = new Set(p.nome_norm.split(' '));
    const ehAutor = (e) => normalizar(e.nomeAutor).split(' ').every((w) => palavrasCivis.has(w));
    let emendas = [];
    for (const autor of federal ? p.urnas.slice(0, 2) : []) {
      for (let inicio = 1; inicio <= MAX_PAGINAS; inicio += 5) {
        const lotes = await Promise.all([0, 1, 2, 3, 4].map((i) =>
          get(`emendas?nomeAutor=${encodeURIComponent(normalizar(autor))}&pagina=${inicio + i}`)));
        for (const l of lotes) emendas.push(...l.filter(ehAutor));
        if (lotes.some((l) => l.length < 15)) break;
      }
      if (emendas.length) break;
    }
    const truncado = emendas.length >= MAX_PAGINAS * 15;
    const empenhado = emendas.reduce((s, e) => s + numeroBr(e.valorEmpenhado), 0);
    const pago = emendas.reduce((s, e) => s + numeroBr(e.valorPago), 0);
    const porLocal = {};
    for (const e of emendas) porLocal[e.localidadeDoGasto] = (porLocal[e.localidadeDoGasto] ?? 0) + numeroBr(e.valorPago);
    const destinos = Object.entries(porLocal).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([local, v]) => `${local}: ${brl(v)}`).join(' · ');
    const anos = emendas.map((e) => e.ano).filter(Boolean);

    const sancao = (lista, s) => ({
      titulo: `${lista}: ${s.tipoSancao?.descricaoResumida ?? s.tipoSancao?.descricaoPortal ?? 'sanção'}`,
      situacao: [s.dataInicioSancao && `de ${s.dataInicioSancao}`, s.dataFimSancao && `até ${s.dataFimSancao}`,
        s.dataTransitadoJulgado && `(trânsito em julgado em ${s.dataTransitadoJulgado})`].filter(Boolean).join(' '),
      detalhe: [s.fonteSancao?.nomeExibicao, s.fundamentacao?.[0]?.codigo?.split(' - ').slice(0, 2).join(' - ')]
        .filter(Boolean).join(' · '),
      correspondencia: 'cpf',
      link: 'https://portaldatransparencia.gov.br/sancoes',
    });
    const registros = [
      ...ceis.map((s) => sancao('CEIS', s)),
      ...cnep.map((s) => sancao('CNEP', s)),
      ...ceaf.map((s) => ({
        titulo: `CEAF: ${s.tipoPunicao?.descricao ?? 'expulsão da administração federal'}`,
        situacao: s.dataPublicacao && `Publicado em ${s.dataPublicacao}`,
        detalhe: [s.orgaoLotacao?.nome, s.punicao?.processo && `Processo ${s.punicao.processo}`].filter(Boolean).join(' · '),
        correspondencia: 'cpf',
        link: 'https://portaldatransparencia.gov.br/sancoes/ceaf',
      })),
    ];

    return {
      correspondencia: 'cpf',
      link: 'https://portaldatransparencia.gov.br/',
      alerta: registros.length > 0,
      registros,
      indicadores: [
        { rotulo: 'Emendas parlamentares', valor: `${truncado ? 'mais de ' : ''}${emendas.length.toLocaleString('pt-BR')}`,
          detalhe: `busca pelo nome parlamentar${anos.length ? ` · ${Math.min(...anos)}–${Math.max(...anos)}` : ''}` },
        { rotulo: 'Valor empenhado', valor: brl(empenhado) },
        { rotulo: 'Valor pago', valor: brl(pago), detalhe: destinos ? `Maiores destinos: ${destinos}` : null },
        { rotulo: 'Cargos como pessoa exposta politicamente', valor: peps.length.toLocaleString('pt-BR'),
          detalhe: [...new Set(peps.map((x) => `${x.descricao_funcao} (${x.nome_orgao?.trim()})`))].slice(0, 3).join('; ') },
      ],
    };
  },
};
