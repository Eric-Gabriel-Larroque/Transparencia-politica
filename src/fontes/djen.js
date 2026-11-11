// DJEN – Diário de Justiça Eletrônico Nacional (CNJ).
// Reúne as publicações e intimações de todos os tribunais do país (desde 2024).
// API pública: https://comunicaapi.pje.jus.br/api/v1/comunicacao
//
// Atenção:
// - A API bloqueia acessos de fora do Brasil (CloudFront geo-block). Funciona no servidor brasileiro.
// - A busca é pelo NOME da parte: não há CPF. Todo resultado é marcado como possível homônimo.
// - Processos sob sigilo não são publicados no DJEN.
// - Aparecer num processo não significa culpa: pode ser réu, autor, testemunha, vítima...

import { http, normalizar } from '../lib/util.js';

const API = 'https://comunicaapi.pje.jus.br/api/v1/comunicacao';
const CONSULTA = 'https://comunica.pje.jus.br/consulta';
const POR_PAGINA = 100;
const MAX_PAGINAS = 5;

// Classes processuais de natureza criminal (pelo nome da classe, sem interpretar o texto).
const CRIMINAL = /PENAL|CRIM|INQU[EÉ]RITO|TERMO CIRCUNSTANCIADO|HABEAS CORPUS|PRIS[AÃ]O|DEN[UÚ]NCIA|QUEIXA|MEDIDAS? PROTETIVAS?|EXECU[CÇ][AÃ]O DA PENA/i;
// Ações de improbidade e afins (cíveis, mas relacionadas à administração pública).
const IMPROBIDADE = /IMPROBIDADE|A[CÇ][AÃ]O POPULAR|A[CÇ][AÃ]O CIVIL P[UÚ]BLICA/i;

const semHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const campo = (obj, ...nomes) => nomes.map((n) => obj?.[n]).find((v) => v != null && v !== '');

function dataBr(valor) {
  const s = String(valor ?? '');
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s.slice(0, 10) || null;
}
const ordenavel = (br) => (br ? br.split('/').reverse().join('') : '');

function natureza(classe) {
  if (CRIMINAL.test(classe ?? '')) return 'criminal';
  if (IMPROBIDADE.test(classe ?? '')) return 'improbidade';
  return 'outros';
}

const POLOS = { A: 'polo ativo (autor)', P: 'polo passivo (réu/requerido)' };

async function buscarPublicacoes(nome) {
  const itens = [];
  let total = 0;
  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
    const qs = new URLSearchParams({ nomeParte: nome, itensPorPagina: String(POR_PAGINA), pagina: String(pagina) });
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
    const lote = dados.items ?? dados.itens ?? dados.content ?? [];
    total = Number(dados.count ?? dados.total ?? dados.totalElements ?? lote.length);
    itens.push(...lote);
    if (lote.length < POR_PAGINA || itens.length >= total) break;
  }
  return { itens, total };
}

export const djen = {
  id: 'djen',
  nome: 'Processos com publicação no Diário de Justiça',
  orgao: 'CNJ – Diário de Justiça Eletrônico Nacional (DJEN)',
  descricao: 'Processos de qualquer tribunal do país (estaduais, federais, eleitorais, superiores) que tiveram publicação no DJEN desde 2024 com uma parte de nome idêntico. Processos em sigilo não aparecem.',
  aplicavel: () => true,
  linkConsulta: (p) => `${CONSULTA}?nomeParte=${encodeURIComponent(p.nome_norm)}`,
  async consultar(p) {
    // A grafia nas publicações pode ter ou não acento: busca das duas formas e junta.
    const grafias = [...new Set([p.nome_norm, String(p.nome ?? '').toUpperCase().trim()].filter(Boolean))];
    const resultados = await Promise.all(grafias.map(buscarPublicacoes));
    const vistos = new Set();
    const itens = [];
    for (const r of resultados) {
      for (const it of r.itens) {
        const chave = it.id ?? it.hash ?? JSON.stringify([it.numero_processo, it.data_disponibilizacao, it.texto?.slice(0, 50)]);
        if (vistos.has(chave)) continue;
        vistos.add(chave);
        itens.push(it);
      }
    }
    const total = Math.max(itens.length, ...resultados.map((r) => r.total));

    // Agrupa por processo e só aceita publicações em que algum destinatário tem o nome idêntico.
    const processos = new Map();
    for (const it of itens) {
      const destinatarios = it.destinatarios ?? it.destinatario ?? [];
      const meu = destinatarios.find((d) => normalizar(campo(d, 'nome', 'nomeParte')) === p.nome_norm);
      if (!meu && destinatarios.length) continue;
      const numero = campo(it, 'numeroprocessocommascara', 'numeroProcessoComMascara', 'numero_processo', 'numeroProcesso');
      if (!numero) continue;
      const data = dataBr(campo(it, 'data_disponibilizacao', 'dataDisponibilizacao', 'datadisponibilizacao'));
      const classe = campo(it, 'nomeClasse', 'classe', 'nome_classe');
      const atual = processos.get(numero) ?? {
        numero, classe, natureza: natureza(classe),
        tribunal: campo(it, 'siglaTribunal', 'tribunal'),
        orgao: campo(it, 'nomeOrgao', 'orgao'),
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
    const lista = [...processos.values()].sort((a, b) =>
      ordem[a.natureza] - ordem[b.natureza] || ordenavel(b.ultima).localeCompare(ordenavel(a.ultima)));

    const rotuloNatureza = { criminal: 'Classe criminal', improbidade: 'Improbidade / ação civil pública', outros: null };
    const contagem = (n) => lista.filter((x) => x.natureza === n).length;

    return {
      correspondencia: 'nome',
      link: `${CONSULTA}?nomeParte=${encodeURIComponent(p.nome_norm)}`,
      alerta: false, // só por nome: nunca é tratado como confirmado
      aviso: lista.length
        ? 'Busca feita só pelo nome completo: o DJEN não informa CPF. Pode ser outra pessoa com o mesmo nome, e aparecer num processo não significa culpa (a pessoa pode ser autora, ré, testemunha...). Confira cada processo na fonte.'
        : null,
      indicadores: lista.length ? [
        { rotulo: 'Processos encontrados', valor: lista.length.toLocaleString('pt-BR'),
          detalhe: `${total.toLocaleString('pt-BR')} publicação(ões) com esse nome${total > itens.length ? ` (lidas as ${itens.length} mais recentes)` : ''}` },
        { rotulo: 'De classe criminal', valor: contagem('criminal').toLocaleString('pt-BR'), detalhe: 'pelo nome da classe processual' },
        { rotulo: 'Improbidade / ação civil pública', valor: contagem('improbidade').toLocaleString('pt-BR') },
      ] : [],
      contagem: { criminal: contagem('criminal'), improbidade: contagem('improbidade'), total: lista.length },
      tituloRegistros: lista.length ? 'Processos (criminais primeiro, depois os mais recentes)' : null,
      registros: lista.slice(0, 40).map((x) => ({
        titulo: `${x.classe ?? 'Processo'} ${x.numero}`,
        situacao: [rotuloNatureza[x.natureza], x.tribunal, x.orgao, x.polo].filter(Boolean).join(' · '),
        detalhe: [
          `${x.publicacoes} publicação(ões); última em ${x.ultima ?? '?'}${x.tipo ? ` (${x.tipo})` : ''}`,
          x.trecho && `Trecho: "${x.trecho}${x.trecho.length >= 280 ? '…' : ''}"`,
        ].filter(Boolean).join(' · '),
        correspondencia: 'nome',
        data: x.ultima,
        link: x.link || `${CONSULTA}?numeroProcesso=${encodeURIComponent(x.numero.replace(/\D/g, ''))}`,
      })),
    };
  },
};
