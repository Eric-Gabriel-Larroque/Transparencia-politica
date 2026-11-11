// Querido Diário (Open Knowledge Brasil): busca em diários oficiais municipais.
// API pública: https://api.queridodiario.ok.org.br/docs
//
// Só para quem disputou cargo municipal (prefeito, vice-prefeito, vereador): procura o nome completo,
// entre aspas, nos diários oficiais do município da candidatura mais recente.
// Aparecer no diário oficial é comum e neutro (nomeações, contratos, portarias, homenagens...).

import { httpJson, normalizar } from '../lib/util.js';

const API = 'https://api.queridodiario.ok.org.br';
const MUNICIPAIS = /PREFEITO|VEREADOR/i;

const cacheCidades = new Map();
async function territorio(municipio, uf) {
  const chave = `${normalizar(municipio)}|${uf}`;
  if (cacheCidades.has(chave)) return cacheCidades.get(chave);
  const { dados } = await httpJson(`${API}/cities?city_name=${encodeURIComponent(municipio)}`);
  const cidades = dados.cities ?? dados ?? [];
  const achada = cidades.find((c) => normalizar(c.territory_name) === normalizar(municipio) && c.state_code === uf) ?? null;
  cacheCidades.set(chave, achada);
  return achada;
}

const limparTrecho = (s) => String(s ?? '').replace(/<\/?[^>]+>/g, '').replace(/\s+/g, ' ').trim();

export const diarios = {
  id: 'diarios',
  nome: 'Menções em diários oficiais do município',
  orgao: 'Querido Diário (Open Knowledge Brasil)',
  descricao: 'Publicações nos diários oficiais da prefeitura em que aparece o nome completo da pessoa: nomeações, contratos, portarias, decretos. Aparecer no diário oficial é comum e não indica irregularidade.',
  aplicavel: (p) => p.candidaturas.some((c) => MUNICIPAIS.test(c.cargo ?? '')),
  motivoNaoAplicavel: 'Só se aplica a quem disputou cargo municipal (prefeito, vice-prefeito ou vereador).',
  async consultar(p) {
    const municipal = p.candidaturas.find((c) => MUNICIPAIS.test(c.cargo ?? ''));
    const cidade = await territorio(municipal.unidade, municipal.uf);
    if (!cidade) {
      return { naoAplicavel: true, motivo: `O Querido Diário ainda não cobre os diários oficiais de ${municipal.unidade}/${municipal.uf}.` };
    }
    const qs = new URLSearchParams({
      territory_ids: cidade.territory_id,
      querystring: `"${p.nome}"`,
      excerpt_size: '300',
      number_of_excerpts: '1',
      size: '15',
      sort_by: 'descending_date',
    });
    const { dados } = await httpJson(`${API}/gazettes?${qs}`, { timeout: 30_000 });
    const total = Number(dados.total_gazettes ?? 0);
    const edicoes = dados.gazettes ?? [];
    const link = `https://queridodiario.ok.org.br/pesquisa?term=${encodeURIComponent(`"${p.nome}"`)}&territory_id=${cidade.territory_id}`;
    return {
      correspondencia: 'nome',
      link,
      aviso: total ? `Busca pelo nome completo nos diários de ${cidade.territory_name}/${cidade.state_code}. Pode haver homônimos.` : null,
      indicadores: [
        { rotulo: `Edições com o nome (${cidade.territory_name}/${cidade.state_code})`, valor: total.toLocaleString('pt-BR') },
      ],
      tituloRegistros: edicoes.length ? 'Edições mais recentes' : null,
      registros: edicoes.map((g) => ({
        titulo: `Diário oficial de ${g.territory_name ?? cidade.territory_name} – ${g.date?.split('-').reverse().join('/')}${g.is_extra_edition ? ' (edição extra)' : ''}`,
        detalhe: g.excerpts?.[0] ? `Trecho: "${limparTrecho(g.excerpts[0])}"` : null,
        correspondencia: 'nome',
        data: g.date?.split('-').reverse().join('/'),
        link: g.url ?? g.txt_url ?? link,
      })),
    };
  },
};
