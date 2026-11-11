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

    return {
      correspondencia: 'nome_nascimento',
      link: `https://www.camara.leg.br/deputados/${dep.id}`,
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
  async consultar(p) {
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
    return {
      correspondencia: 'nome_nascimento',
      link: `https://www25.senado.leg.br/web/senadores/senador/-/perfil/${sen.CodigoParlamentar}`,
      indicadores: [
        { rotulo: 'Matérias de autoria', valor: materias.length.toLocaleString('pt-BR') },
        { rotulo: 'Em tramitação', valor: materias.filter((m) => m.tramitando === 'Sim').length.toLocaleString('pt-BR') },
      ],
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
