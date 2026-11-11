// Câmara dos Deputados e Senado Federal: atuação parlamentar (proposições, gastos).

import { httpJson, normalizar } from '../lib/util.js';

const CAMARA = 'https://dadosabertos.camara.leg.br/api/v2';
const SENADO = 'https://legis.senado.leg.br/dadosabertos';
const LEGISLATURAS = [52, 53, 54, 55, 56, 57, 58]; // 2003 em diante

const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------------------------------------------------------- Câmara

async function acharDeputado(p) {
  const nomes = [...new Set([...p.urnas, p.nome].filter(Boolean))];
  const ids = new Set();
  for (const nome of nomes) {
    const qs = new URLSearchParams({ nome });
    for (const l of LEGISLATURAS) qs.append('idLegislatura', String(l));
    const { dados } = await httpJson(`${CAMARA}/deputados?${qs}`);
    for (const d of dados.dados) ids.add(d.id);
  }
  for (const id of ids) {
    const { dados } = await httpJson(`${CAMARA}/deputados/${id}`);
    const d = dados.dados;
    if (p.cpf ? d.cpf === p.cpf : normalizar(d.nomeCivil) === p.nome_norm) return d;
  }
  return null;
}

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

const PERIODO_LEGISLATURA = (n) => `${1795 + 4 * n}–${1799 + 4 * n}`; // 57 -> 2023–2027

export const camara = {
  id: 'camara',
  nome: 'Atuação na Câmara dos Deputados',
  orgao: 'Câmara dos Deputados – Dados Abertos',
  descricao: 'Proposições apresentadas e gastos da cota parlamentar (CEAP).',
  aplicavel: (p) => p.cargos.some((c) => /DEPUTADO FEDERAL/i.test(c)),
  motivoNaoAplicavel: 'Nunca foi candidato(a) a deputado(a) federal.',
  async consultar(p) {
    const dep = await acharDeputado(p);
    if (!dep) {
      return { correspondencia: p.cpf ? 'cpf' : 'nome', registros: [], indicadores: [], aviso: 'Não exerceu mandato na Câmara desde 2003 (ou não foi encontrado).' };
    }
    const qs = `idDeputadoAutor=${dep.id}&dataApresentacaoInicio=2003-01-01&ordem=DESC&ordenarPor=id`;
    const { dados: props, headers } = await httpJson(`${CAMARA}/proposicoes?${qs}&itens=5`);
    const totalProps = Number(headers.get('x-total-count') ?? props.dados.length);

    const s = dep.ultimoStatus ?? {};
    const legislatura = s.idLegislatura ?? LEGISLATURAS.at(-2);
    const despesas = await somarDespesas(dep.id, legislatura);
    const anos = Object.entries(despesas.porAno).sort(([a], [b]) => a - b);

    return {
      correspondencia: p.cpf ? 'cpf' : 'nome',
      link: `https://www.camara.leg.br/deputados/${dep.id}`,
      indicadores: [
        { rotulo: 'Proposições de autoria', valor: totalProps.toLocaleString('pt-BR'), detalhe: 'desde 2003, inclui requerimentos e emendas' },
        {
          rotulo: `Cota parlamentar (legislatura ${PERIODO_LEGISLATURA(legislatura)})`,
          valor: brl(despesas.total),
          detalhe: `${despesas.qtd.toLocaleString('pt-BR')} despesas${anos.length ? ` · ${anos.map(([a, v]) => `${a}: ${brl(v)}`).join(' · ')}` : ''}`,
        },
        { rotulo: 'Situação atual', valor: s.situacao ?? '—', detalhe: [s.siglaPartido, s.siglaUf].filter(Boolean).join('/') },
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
  const { dados } = await httpJson(`${SENADO}/senador/lista/legislatura/${LEGISLATURAS[0]}/${LEGISLATURAS.at(-2)}.json`);
  const lista = dados.ListaParlamentarLegislatura.Parlamentares.Parlamentar;
  cacheSenadores = lista.map((s) => s.IdentificacaoParlamentar);
  return cacheSenadores;
}

export const senado = {
  id: 'senado',
  nome: 'Atuação no Senado Federal',
  orgao: 'Senado Federal – Dados Abertos',
  descricao: 'Matérias legislativas de autoria do(a) senador(a).',
  aplicavel: (p) => p.cargos.some((c) => /SENADOR|SUPLENTE/i.test(c)),
  motivoNaoAplicavel: 'Nunca foi candidato(a) a senador(a) ou suplente.',
  async consultar(p) {
    // O Senado não publica CPF: a correspondência é pelo nome completo.
    const sen = (await listaSenadores()).find((s) => normalizar(s.NomeCompletoParlamentar) === p.nome_norm);
    if (!sen) return { correspondencia: 'nome', registros: [], indicadores: [], aviso: 'Não exerceu mandato no Senado desde 2003 (ou não foi encontrado).' };

    const { dados } = await httpJson(`${SENADO}/processo?codigoParlamentarAutor=${sen.CodigoParlamentar}`, { timeout: 40_000 });
    const materias = Array.isArray(dados) ? dados : [];
    materias.sort((a, b) => String(b.dataApresentacao).localeCompare(String(a.dataApresentacao)));
    return {
      correspondencia: 'nome',
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
