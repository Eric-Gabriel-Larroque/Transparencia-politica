// Conteúdo gerado no servidor para buscadores (e para quem abre a página antes do JavaScript carregar):
// ficha resumida, páginas de estado e de cidade, dados estruturados (schema.org).
// Usa só o índice local: não consulta nenhuma API externa, então é rápido e não gasta cotas.

import { normalizar } from './lib/util.js';
import { carregarFinanciamento } from './fontes/financiamento.js';

export const UFS = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

// "da Bahia", "de São Paulo", "do Rio de Janeiro"
const PREP = { BA: 'da', PB: 'da', AC: 'do', AP: 'do', AM: 'do', CE: 'do', DF: 'do', ES: 'do', MA: 'do', MT: 'do', MS: 'do', PA: 'do',
  PR: 'do', PI: 'do', RJ: 'do', RN: 'do', RS: 'do', TO: 'do' };
export const deUf = (uf) => `${PREP[uf] ?? 'de'} ${UFS[uf] ?? uf}`;
const RESULTADOS = { 'ELEITO POR QP': 'Eleito por quociente partidário', 'ELEITO POR MÉDIA': 'Eleito por média', '2º TURNO': 'Foi ao 2º turno' };
const resultado = (r) => RESULTADOS[String(r ?? '').toUpperCase()] ?? cap(r);

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const cap = (s) => String(s ?? '').toLowerCase().replace(/(^|[\s(/-])\S/g, (l) => l.toUpperCase())
  // preposições ficam minúsculas no meio do nome: "Barra do Corda", "Mato Grosso do Sul"
  .replace(/(?<=\S\s)(De|Da|Do|Das|Dos|E)(?=\s)/g, (w) => w.toLowerCase());
export const slug = (s) => normalizar(s).toLowerCase().replace(/\s+/g, '-');
const brl = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
function compacto(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `R$ ${(v / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} bi`;
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return brl(v);
}
const MUNICIPAIS = /^(PREFEITO|VICE-PREFEITO|VEREADOR)$/;
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const migalhas = (site, itens) => ({
  '@context': 'https://schema.org', '@type': 'BreadcrumbList',
  itemListElement: itens.map(([nome, url], i) => ({ '@type': 'ListItem', position: i + 1, name: nome, item: `${site}${url}` })),
});
const navMigalhas = (itens) => `<nav class="migalhas" aria-label="Você está em">${itens
  .map(([nome, url], i) => (i < itens.length - 1 ? `<a href="${esc(url)}">${esc(nome)}</a>` : `<span>${esc(nome)}</span>`)).join(' › ')}</nav>`;

export function criarPaginas(db, site) {
  const q = (sql) => db.prepare(sql);
  const sqlPessoa = q('SELECT * FROM pessoas WHERE pessoa = ?');
  const sqlCandidaturas = q('SELECT * FROM candidaturas WHERE pessoa = ? ORDER BY ano DESC');
  const sqlTcu = q('SELECT COUNT(*) AS n FROM tcu WHERE cpf = ?');
  const sqlEmpresas = q('SELECT COUNT(*) AS n FROM empresa_socio WHERE cpf = ?');
  const sqlDeputado = q('SELECT * FROM camara_deputados WHERE nome_norm = ? AND nascimento = ?');
  const sqlRef = q('SELECT pessoa FROM candidaturas WHERE ano = ? AND sq = ?');

  // ------------------------------------------------------------ ficha

  function dadosFicha(id) {
    const [ano, sq] = id.split('-');
    const ref = sqlRef.get(Number(ano), sq);
    const pessoa = ref && sqlPessoa.get(ref.pessoa);
    if (!pessoa) return null;
    const cands = sqlCandidaturas.all(ref.pessoa);
    const ultima = cands[0];
    const cpf = /^\d{11}$/.test(pessoa.pessoa) ? pessoa.pessoa : null;
    const bens = cands.filter((c) => c.bens_total != null).sort((a, b) => a.ano - b.ano);
    return {
      pessoa, cands, ultima, cpf,
      urna: cap(ultima.urna ?? ultima.nome),
      nome: cap(ultima.nome),
      eleito: cands.filter((c) => /^ELEITO/i.test(c.resultado ?? '')),
      bens,
      tcu: cpf ? sqlTcu.get(cpf).n : 0,
      empresas: cpf ? sqlEmpresas.get(cpf).n : 0,
      camara: ultima.nascimento ? sqlDeputado.get(ultima.nome_norm, ultima.nascimento) : null,
      camp: carregarFinanciamento(db, cands)[0],
    };
  }

  function local(c) {
    if (!c.uf || c.uf === 'BR') return { nome: 'Brasil', de: 'do Brasil', url: '/' };
    if (MUNICIPAIS.test(c.cargo ?? '')) return { nome: `${cap(c.unidade)}/${c.uf}`, de: `de ${cap(c.unidade)}/${c.uf}`, url: `/uf/${c.uf}/${slug(c.unidade)}` };
    return { nome: UFS[c.uf] ?? c.uf, de: deUf(c.uf), url: `/uf/${c.uf}` };
  }

  function ficha(id) {
    const d = dadosFicha(id);
    if (!d) return null;
    const { ultima, urna } = d;
    const sigla = `${ultima.partido ?? ''}${ultima.uf && ultima.uf !== 'BR' ? `-${ultima.uf}` : ''}`;
    const cargo = cap(ultima.cargo);
    const ondeAtua = local(ultima);
    const variacao = d.bens.length > 1 && d.bens[0].bens_total > 0
      ? Math.round(((d.bens.at(-1).bens_total - d.bens[0].bens_total) / d.bens[0].bens_total) * 100) : null;

    // Frases objetivas, montadas por regras fixas (as mesmas informações da ficha completa).
    const fatos = [
      `${d.cands.length} candidatura(s) entre ${d.cands.at(-1).ano} e ${ultima.ano}${d.eleito.length ? `, eleito(a) ${d.eleito.length} vez(es): ${d.eleito.map((c) => `${cap(c.cargo)} em ${c.ano}`).join(', ')}` : ', sem eleição vencida no período'}.`,
      d.bens.length ? `Patrimônio declarado ao TSE: ${brl(d.bens.at(-1).bens_total)} em ${d.bens.at(-1).ano}${variacao != null ? ` (${variacao >= 0 ? '+' : ''}${variacao}% desde ${d.bens[0].ano})` : ''}.` : null,
      d.camp ? `Campanha de ${d.camp.ano}: arrecadou ${brl(d.camp.arrecadado)}, ${d.camp.percentualPublico}% de dinheiro público${d.camp.doadores[0] ? `; maior doador: ${cap(d.camp.doadores[0].nome ?? '')}` : ''}.` : null,
      d.cpf ? (d.tcu ? `${d.tcu} registro(s) nas listas de responsáveis do Tribunal de Contas da União, confirmados pelo CPF.` : 'Nenhum registro nas listas de responsáveis do Tribunal de Contas da União.') : null,
      d.cpf ? (d.empresas ? `Sócio(a) de ${d.empresas} empresa(s) segundo a Receita Federal.` : 'Nenhuma empresa encontrada no quadro de sócios da Receita Federal.') : null,
      d.camara ? `Foi deputado(a) federal (${1795 + 4 * d.camara.leg_ini}–${d.camara.leg_fim >= 57 ? 'atual' : 1799 + 4 * d.camara.leg_fim}).` : null,
    ].filter(Boolean);

    const titulo = `${urna} (${sigla}): processos, patrimônio, doadores e votações · Ficha Pública`;
    const descricao = [
      `${urna}, ${cargo.toLowerCase()}${ultima.uf && ultima.uf !== 'BR' ? ` (${ultima.uf})` : ''}.`,
      d.cpf ? (d.tcu ? `${d.tcu} registro(s) no TCU.` : 'Nada consta no TCU.') : null,
      d.bens.length ? `Patrimônio de ${compacto(d.bens.at(-1).bens_total)}.` : null,
      d.camp ? `Campanha de ${compacto(d.camp.arrecadado)} (${d.camp.percentualPublico}% público).` : null,
      'Processos, empresas e votações com fonte oficial.',
    ].filter(Boolean).join(' ');

    const trilha = [['Início', '/'], ...(ultima.uf && ultima.uf !== 'BR' ? [[UFS[ultima.uf] ?? ultima.uf, `/uf/${ultima.uf}`]] : []),
      ...(MUNICIPAIS.test(ultima.cargo ?? '') ? [[cap(ultima.unidade), ondeAtua.url]] : []), [urna, `/p/${d.pessoa.id}`]];

    const conteudo = `<article data-ssr>
      ${navMigalhas(trilha)}
      <section class="cartao perfil">
        <div><h1>${esc(urna)}</h1>
          <div class="civil">${esc(d.nome)} · ${esc(cargo)} · ${esc(ondeAtua.nome)} · ${esc(ultima.partido ?? '')}</div></div>
      </section>
      <section class="cartao"><h2>Resumo</h2><ul>${fatos.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <p class="meta">Consultas ao CNJ, Diário de Justiça, CGU e votações carregam ao abrir a página.</p></section>
      <section class="cartao"><h2>Candidaturas</h2><ul>${d.cands.map((c) => `<li>${c.ano}: ${esc(cap(c.cargo))} · ${esc(local(c).nome)}
        · ${esc(c.partido ?? '')}${c.resultado ? ` · ${esc(resultado(c.resultado))}` : ''}</li>`).join('')}</ul>
        <p><a href="${esc(ondeAtua.url)}">Ver outros políticos ${esc(ondeAtua.de)}</a></p></section>
    </article>`;

    const dados = [
      {
        '@context': 'https://schema.org', '@type': 'ProfilePage', url: `${site}/p/${d.pessoa.id}`, name: titulo,
        dateModified: new Date().toISOString().slice(0, 10),
        mainEntity: {
          '@type': 'Person', name: d.nome, alternateName: urna, jobTitle: cargo,
          ...(ultima.partido ? { affiliation: { '@type': 'PoliticalParty', name: ultima.partido } } : {}),
          ...(ondeAtua.nome !== 'Brasil' ? { workLocation: { '@type': 'Place', name: ondeAtua.nome } } : {}),
        },
      },
      migalhas(site, trilha),
    ];
    return { titulo, descricao, url: `${site}/p/${d.pessoa.id}`, conteudo, extra: dados.map(jsonLd).join('') };
  }

  // ------------------------------------------------------------ estados e cidades

  const anoGeral = q("SELECT MAX(ano) AS a FROM candidaturas WHERE cargo = 'DEPUTADO FEDERAL' AND resultado LIKE 'ELEITO%'");
  const anoMunicipal = q("SELECT MAX(ano) AS a FROM candidaturas WHERE cargo = 'PREFEITO' AND resultado LIKE 'ELEITO%'");
  const sqlEleitosUf = q(`SELECT c.cargo, c.urna, c.nome, c.partido, c.ano, p.id FROM candidaturas c JOIN pessoas p ON p.pessoa = c.pessoa
    WHERE c.uf = ? AND c.ano IN (?, ?) AND c.resultado LIKE 'ELEITO%'
      AND c.cargo IN ('GOVERNADOR', 'VICE-GOVERNADOR', 'SENADOR', 'DEPUTADO FEDERAL', 'DEPUTADO ESTADUAL', 'DEPUTADO DISTRITAL')
    ORDER BY c.ano DESC, c.urna`);
  const sqlCidades = q(`SELECT unidade, COUNT(*) AS n FROM candidaturas WHERE uf = ? AND ano = ? AND cargo IN ('PREFEITO', 'VEREADOR')
    GROUP BY unidade ORDER BY unidade`);
  const sqlCidade = q(`SELECT c.cargo, c.urna, c.nome, c.partido, c.resultado, p.id FROM candidaturas c JOIN pessoas p ON p.pessoa = c.pessoa
    WHERE c.uf = ? AND c.ano = ? AND c.unidade = ? AND c.cargo IN ('PREFEITO', 'VICE-PREFEITO', 'VEREADOR') ORDER BY c.urna`);

  const cacheCidades = new Map();
  function cidadesDe(uf) {
    if (!cacheCidades.has(uf)) cacheCidades.set(uf, sqlCidades.all(uf, anoMunicipal.get().a));
    return cacheCidades.get(uf);
  }

  const itemPessoa = (x, extra = '') => `<li><a href="/p/${esc(x.id)}"><span class="nome">${esc(cap(x.urna ?? x.nome))}</span>
    <span class="chip">${esc(x.partido ?? '')}</span><span class="info">${esc(cap(x.nome))}${extra}</span></a></li>`;
  const ORDEM_CARGOS = ['GOVERNADOR', 'VICE-GOVERNADOR', 'SENADOR', 'DEPUTADO FEDERAL', 'DEPUTADO ESTADUAL', 'DEPUTADO DISTRITAL'];
  const PLURAL = { GOVERNADOR: 'Governador(a) eleito(a)', 'VICE-GOVERNADOR': 'Vice-governador(a) eleito(a)', SENADOR: 'Senadores eleitos',
    'DEPUTADO FEDERAL': 'Deputados federais eleitos', 'DEPUTADO ESTADUAL': 'Deputados estaduais eleitos', 'DEPUTADO DISTRITAL': 'Deputados distritais eleitos' };

  function estado(uf) {
    if (!UFS[uf]) return null;
    const ag = anoGeral.get().a;
    const eleitos = sqlEleitosUf.all(uf, ag, ag - 4)
      // senadores: os das duas últimas eleições; demais cargos: só a última
      .filter((x) => x.cargo === 'SENADOR' || x.ano === ag);
    const cidades = cidadesDe(uf);
    const nome = UFS[uf];
    const secoes = ORDEM_CARGOS.map((cargo) => {
      const lista = eleitos.filter((x) => x.cargo === cargo);
      return lista.length ? `<section class="cartao"><h2>${PLURAL[cargo]}</h2>
        <ul class="resultados">${lista.map((x) => itemPessoa(x, ` · eleito(a) em ${x.ano}`)).join('')}</ul></section>` : '';
    }).join('');
    const trilha = [['Início', '/'], [nome, `/uf/${uf}`]];
    const conteudo = `${navMigalhas(trilha)}
      <section class="cartao"><h1>Políticos ${esc(deUf(uf))} (${uf})</h1>
        <p class="meta">Eleitos nas últimas eleições estaduais e federais e cidades do estado. Clique em um nome para ver processos,
          patrimônio, doadores e votações.</p></section>
      ${secoes}
      <section class="cartao"><h2>Cidades ${esc(deUf(uf))}</h2>
        <ul class="grade-links">${cidades.map((c) => `<li><a href="/uf/${uf}/${slug(c.unidade)}">${esc(cap(c.unidade))}</a></li>`).join('')}</ul></section>`;
    return {
      titulo: `Políticos ${deUf(uf)} (${uf}): deputados, senadores, governador e prefeitos · Ficha Pública`,
      descricao: `Veja processos, patrimônio, doadores e votações dos deputados, senadores e governador ${deUf(uf)}, e os políticos das ${cidades.length} cidades do estado. Só dados oficiais.`,
      url: `${site}/uf/${uf}`, conteudo, extra: jsonLd(migalhas(site, trilha)),
    };
  }

  function cidade(uf, slugCidade) {
    if (!UFS[uf]) return null;
    const achada = cidadesDe(uf).find((c) => slug(c.unidade) === slugCidade);
    if (!achada) return null;
    const am = anoMunicipal.get().a;
    const pessoas = sqlCidade.all(uf, am, achada.unidade);
    const nomeCidade = cap(achada.unidade);
    const eleito = (x) => /^ELEITO/i.test(x.resultado ?? '');
    const blocos = [
      ['Prefeitura', pessoas.filter((x) => /PREFEITO/.test(x.cargo) && eleito(x))],
      ['Vereadores eleitos', pessoas.filter((x) => x.cargo === 'VEREADOR' && eleito(x))],
      [`Todos os candidatos a prefeito em ${am}`, pessoas.filter((x) => x.cargo === 'PREFEITO')],
      [`Todos os candidatos a vereador em ${am}`, pessoas.filter((x) => x.cargo === 'VEREADOR' && !eleito(x))],
    ];
    const trilha = [['Início', '/'], [UFS[uf], `/uf/${uf}`], [nomeCidade, `/uf/${uf}/${slugCidade}`]];
    const conteudo = `${navMigalhas(trilha)}
      <section class="cartao"><h1>Políticos de ${esc(nomeCidade)} (${uf})</h1>
        <p class="meta">Prefeito(a), vice e vereadores eleitos em ${am}, e todos os candidatos daquela eleição. Clique em um nome para ver
          processos, patrimônio, doadores e votações.</p></section>
      ${blocos.filter(([, l]) => l.length).map(([titulo, lista]) => `<section class="cartao"><h2>${esc(titulo)}</h2>
        <ul class="resultados">${lista.map((x) => itemPessoa(x, ` · ${cap(x.cargo)}`)).join('')}</ul></section>`).join('')}
      <p><a href="/uf/${uf}">Ver políticos ${esc(deUf(uf))}</a></p>`;
    const pref = blocos[0][1].find((x) => x.cargo === 'PREFEITO');
    return {
      titulo: `Políticos de ${nomeCidade} (${uf}): prefeito e vereadores · Ficha Pública`,
      descricao: `${pref ? `Prefeito(a) eleito(a) em ${am}: ${cap(pref.urna ?? pref.nome)}. ` : ''}Veja processos, patrimônio, doadores e empresas do prefeito e dos vereadores de ${nomeCidade}/${uf}. Só dados oficiais.`,
      url: `${site}/uf/${uf}/${slugCidade}`, conteudo, extra: jsonLd(migalhas(site, trilha)),
    };
  }

  function inicio() {
    return `<section class="cartao"><h2>Políticos por estado</h2>
      <ul class="grade-links">${Object.entries(UFS).map(([uf, nome]) => `<li><a href="/uf/${uf}">${esc(nome)}</a></li>`).join('')}</ul></section>`;
  }

  function urlsLocais() {
    const urls = [];
    for (const uf of Object.keys(UFS)) {
      urls.push(`${site}/uf/${uf}`);
      for (const c of cidadesDe(uf)) urls.push(`${site}/uf/${uf}/${slug(c.unidade)}`);
    }
    return urls;
  }

  return { ficha, estado, cidade, inicio, urlsLocais };
}
