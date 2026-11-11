// Interface: busca e ficha do político. Roteamento por hash (#/ e #/p/<id>).

const app = document.getElementById('app');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const brl = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const capitalizar = (s) => String(s ?? '').toLowerCase().replace(/(^|\s)\S/g, (l) => l.toUpperCase());

async function api(caminho) {
  const res = await fetch(caminho);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro ?? `Erro ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- busca

function telaBusca(q = '') {
  app.innerHTML = `
    <section class="hero">
      <h1>O que os dados oficiais dizem sobre um político?</h1>
      <p>Busque qualquer pessoa que já se candidatou no Brasil, de vereador(a) a presidente. Mostramos candidaturas, bens declarados,
      atuação parlamentar e registros no TCU, no CNJ e no TSE, sempre com link para a fonte.</p>
      <form class="busca" role="search">
        <label for="q" class="visualmente-oculto" hidden>Nome ou CPF</label>
        <input id="q" name="q" type="search" placeholder="Nome, nome de urna ou CPF" value="${esc(q)}" autocomplete="off" required minlength="3">
        <button type="submit">Buscar</button>
      </form>
    </section>
    <div id="resultados"></div>`;
  const form = app.querySelector('form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const valor = form.q.value.trim();
    location.hash = `#/?q=${encodeURIComponent(valor)}`;
  });
  if (q) buscar(q);
  else form.q.focus();
}

async function buscar(q) {
  const alvo = document.getElementById('resultados');
  alvo.innerHTML = '<p class="carregando">Buscando</p>';
  try {
    const { resultados } = await api(`/api/buscar?q=${encodeURIComponent(q)}`);
    if (!resultados.length) {
      alvo.innerHTML = '<p class="caixa neutra">Ninguém encontrado. Tente o nome completo ou o nome de urna.</p>';
      return;
    }
    alvo.innerHTML = `<ul class="resultados">${resultados.map((r) => `
      <li><a href="#/p/${esc(r.id)}">
        <div class="nome">${esc(capitalizar(r.nome))}${r.urnas[0] ? ` <span class="meta">(${esc(r.urnas.join(', '))})</span>` : ''}</div>
        <div class="meta">${esc(r.cargos.map(capitalizar).join(', '))} · ${esc(r.ufs.join(', '))} · ${esc(r.partidos.join(', '))}</div>
        <div class="meta">${r.candidaturas} candidatura(s) de ${r.anos[0]} a ${r.anos[1]}${r.eleito ? ` · eleito(a) ${r.eleito}x` : ''}</div>
      </a></li>`).join('')}</ul>`;
  } catch (e) {
    alvo.innerHTML = `<p class="caixa aviso">${esc(e.message)}</p>`;
  }
}

// ---------------------------------------------------------------- ficha

function etiquetaCorrespondencia(c) {
  if (c === 'cpf') return '<span class="etiqueta cpf" title="Cruzamento exato pelo CPF">por CPF</span>';
  if (c === 'nome') return '<span class="etiqueta nome" title="Cruzamento pelo nome: pode haver homônimos">por nome</span>';
  if (c === 'nome_cpf_parcial') return '<span class="etiqueta cpf" title="Nome completo idêntico e 6 dígitos do CPF (os que a Receita deixa visíveis) iguais">por nome e CPF parcial</span>';
  if (c === 'nome_nascimento') return '<span class="etiqueta cpf" title="Cruzamento pelo nome civil completo e pela data de nascimento">por nome e nascimento</span>';
  return '';
}

function blocoFonte(f) {
  const cab = `<h2>${esc(f.nome)} ${f.status === 'ok' ? etiquetaCorrespondencia(f.correspondencia) : ''}
    ${f.status === 'erro' ? '<span class="etiqueta erro">indisponível</span>' : ''}</h2>
    <p class="orgao">${esc(f.orgao)}${f.link ? ` · <a href="${esc(f.link)}" target="_blank" rel="noopener">fonte oficial</a>` : ''}</p>`;

  if (f.status === 'nao_aplicavel' || f.status === 'erro') {
    return `<section class="cartao">${cab}<p class="caixa neutra">${esc(f.motivo)}</p></section>`;
  }

  const indicadores = f.indicadores?.length ? `<div class="indicadores">${f.indicadores.map((i) => `
    <div class="indicador"><div class="valor">${esc(i.valor)}</div><div class="rotulo">${esc(i.rotulo)}</div>
    ${i.detalhe ? `<div class="rotulo">${esc(i.detalhe)}</div>` : ''}</div>`).join('')}</div>` : '';

  const item = (r) => `
      <li class="registro ${f.alerta && (r.correspondencia ?? f.correspondencia) === 'cpf' ? 'alerta' : ''}">
        <div class="titulo">${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.titulo)}</a>` : esc(r.titulo)}
          ${r.correspondencia && r.correspondencia !== f.correspondencia ? etiquetaCorrespondencia(r.correspondencia) : ''}
          ${r.data ? `<span class="meta"> · ${esc(r.data)}</span>` : ''}</div>
        ${r.situacao ? `<div>${esc(r.situacao)}</div>` : ''}
        ${r.detalhe ? `<div class="detalhe">${esc(r.detalhe)}</div>` : ''}
      </li>`;
  const regs = f.registros ?? [];
  const registros = regs.length ? `
    ${f.tituloRegistros ? `<h3 class="meta">${esc(f.tituloRegistros)}</h3>` : ''}
    <ul class="registros">${regs.slice(0, 5).map(item).join('')}</ul>
    ${regs.length > 5 ? `<details><summary>Ver todos os ${regs.length} registros</summary>
      <ul class="registros">${regs.slice(5).map(item).join('')}</ul></details>` : ''}` : '';
  const outros = f.registrosOutros?.length ? `<details class="outros"><summary>${esc(f.tituloOutros)}</summary>
      <ul class="registros">${f.registrosOutros.map(item).join('')}</ul></details>` : '';

  const extras = (f.listasExtras ?? []).map((l) => l.recolhido
    ? `<details class="outros"><summary>${esc(l.titulo)}</summary><ul class="registros">${l.registros.map(item).join('')}</ul></details>`
    : `<h3 class="meta">${esc(l.titulo)}</h3><ul class="registros">${l.registros.slice(0, 5).map(item).join('')}</ul>
       ${l.registros.length > 5 ? `<details><summary>Ver todos os ${l.registros.length}</summary><ul class="registros">${l.registros.slice(5).map(item).join('')}</ul></details>` : ''}`).join('');
  const vazio = !indicadores && !registros && !outros && !extras ? '<p class="caixa neutra">Nenhum registro encontrado nesta fonte.</p>' : '';
  const aviso = f.aviso ? `<p class="caixa aviso">${esc(f.aviso)}</p>` : '';
  return `<section class="cartao">${cab}<p class="meta">${esc(f.descricao)}</p>${aviso}${indicadores}${extras}${registros}${outros}${vazio}</section>`;
}

function blocoBens(bens) {
  if (!bens.length) return '';
  const linhas = bens.map((b) => `
    <details class="bens-ano">
      <summary><span class="bens-titulo">${b.ano} · ${esc(capitalizar(b.cargo))}${b.unidade ? ` (${esc(capitalizar(b.unidade))})` : ''}</span>
        <span class="bens-total">${brl(b.total)}</span></summary>
      <ul class="lista-bens">${b.itens.map((i) => `
        <li><div><div>${esc(i.descricao ?? '—')}</div><div class="meta">${esc(i.tipo ?? '')}</div></div>
          <div class="bens-valor">${brl(i.valor)}</div></li>`).join('')}</ul>
      <p class="meta">${b.qtd} bem(ns) declarado(s) · Fonte: <a href="${esc(b.link)}" target="_blank" rel="noopener">TSE – Dados Abertos, Candidatos ${b.ano} (arquivo "Bens de candidatos")</a></p>
    </details>`).join('');
  return `<section class="cartao">
    <h2>Bens declarados</h2>
    <p class="orgao">TSE – Tribunal Superior Eleitoral · <a href="${esc(bens.at(-1).link)}" target="_blank" rel="noopener">fonte oficial</a></p>
    <p class="meta">Ao registrar uma candidatura, todo candidato é obrigado a entregar à Justiça Eleitoral uma lista dos seus bens
      com o valor de cada um. Os valores abaixo são exatamente os que o próprio candidato informou: não são auditados,
      costumam seguir o valor de compra (não o de mercado) e não têm correção pela inflação. Toque em um ano para ver a lista.</p>
    ${linhas}
  </section>`;
}

function blocoFinanciamento(lista) {
  if (!lista?.length) return '';
  const tabela = (titulo, linhas, colunas) => linhas.length ? `
    <h3 class="meta">${titulo}</h3>
    <ul class="lista-bens">${linhas.map((l) => `<li><div><div>${esc(colunas[0](l))}</div>${colunas[1] ? `<div class="meta">${esc(colunas[1](l) ?? '')}</div>` : ''}</div>
      <div class="bens-valor">${brl(l.total)}</div></li>`).join('')}</ul>` : '';
  const anos = lista.map((c, i) => `
    <details class="bens-ano" ${i === 0 ? 'open' : ''}>
      <summary><span class="bens-titulo">${c.ano} · ${esc(capitalizar(c.cargo))}${c.unidade ? ` (${esc(capitalizar(c.unidade))})` : ''}</span>
        <span class="bens-total">${brl(c.arrecadado)}</span></summary>
      <div class="indicadores">
        <div class="indicador"><div class="valor">${brl(c.arrecadado)}</div><div class="rotulo">Arrecadado</div></div>
        <div class="indicador"><div class="valor">${c.percentualPublico}%</div><div class="rotulo">Dinheiro público</div><div class="rotulo">${brl(c.publico)}</div></div>
        <div class="indicador"><div class="valor">${brl(c.gasto)}</div><div class="rotulo">Gastos contratados</div></div>
      </div>
      ${tabela('De onde veio o dinheiro', c.fontes, [(x) => x.nome])}
      ${tabela('Por origem', c.origens, [(x) => x.origem, (x) => `${x.qtd} receita(s)`])}
      ${tabela('Maiores doadores', c.doadores, [(x) => x.nome ?? x.doc, (x) => [x.origem, x.doc && x.doc !== x.nome ? (x.doc.length === 14 ? `CNPJ ${x.doc}` : `CPF ${x.doc}`) : null].filter(Boolean).join(' · ')])}
      ${tabela('Com o que gastou', c.despesas, [(x) => x.categoria, (x) => `${x.qtd} despesa(s)`])}
      ${tabela('Maiores fornecedores', c.fornecedores, [(x) => x.nome ?? x.doc, (x) => (x.doc && x.doc.length === 14 ? `CNPJ ${x.doc}` : null)])}
      <p class="meta">Fonte: <a href="${esc(c.link)}" target="_blank" rel="noopener">TSE – Prestação de Contas Eleitorais ${c.ano}</a></p>
    </details>`).join('');
  return `<section class="cartao">
    <h2>Financiamento de campanha</h2>
    <p class="orgao">TSE – Prestação de contas eleitorais · <a href="${esc(lista[0].link)}" target="_blank" rel="noopener">fonte oficial</a></p>
    <p class="meta">Quanto cada campanha arrecadou, de onde veio o dinheiro, quem mais doou e com o que gastou, como o próprio candidato
      declarou à Justiça Eleitoral. "Dinheiro público" é a soma do Fundo Eleitoral (FEFC) e do Fundo Partidário. Os valores incluem doações
      estimáveis (bens e serviços doados). CPFs de doadores pessoas físicas aparecem mascarados.</p>
    ${anos}
  </section>`;
}

async function telaPerfil(id) {
  app.innerHTML = `<a class="voltar" href="javascript:history.back()">← voltar</a>
    <p class="carregando">Consultando TSE, TCU, CNJ, Câmara e Senado (pode levar até 30 segundos)</p>`;
  let d;
  try {
    d = await api(`/api/politico/${encodeURIComponent(id)}`);
  } catch (e) {
    app.innerHTML = `<a class="voltar" href="#/">← voltar</a><p class="caixa aviso">${esc(e.message)}</p>`;
    return;
  }
  const p = d.pessoa;
  document.title = `${capitalizar(p.nome)} · Ficha Pública`;
  app.innerHTML = `
    <a class="voltar" href="javascript:history.back()">← voltar</a>
    <header class="cabecalho">
      <h1>${esc(capitalizar(p.nome))}</h1>
      <div class="meta">${p.urnas.length ? `Nome de urna: ${esc(p.urnas.join(', '))} · ` : ''}${esc(p.cargos.map(capitalizar).join(', '))}</div>
      <div class="meta">Identificado por ${esc(p.identificacao)}${p.cpf ? ` (${esc(p.cpf)})` : ''}${p.nascimento ? ` · nascimento ${esc(p.nascimento)}` : ''}</div>
    </header>

    <section class="cartao">
      <h2>Resumo</h2>
      <p class="orgao">Gerado por regras fixas (contagens e somas) a partir das fontes abaixo.</p>
      <ul class="resumo">${d.resumo.map((l) => `
        <li class="${esc(l.tipo)}"><span class="ponto" aria-hidden="true"></span>
          <div>${esc(l.texto)}${l.fonte ? ` ${l.link ? `<a class="etiqueta" href="${esc(l.link)}" target="_blank" rel="noopener" title="Abrir a fonte oficial">${esc(l.fonte)} ↗</a>` : `<span class="etiqueta">${esc(l.fonte)}</span>`}` : ''}
          ${l.detalhe ? `<div class="detalhe">${esc(l.detalhe)}</div>` : ''}</div></li>`).join('')}</ul>
      <div class="nao-cobre">
        <strong>O que esta ficha não verifica</strong>
        <p>"Nenhum registro" acima significa só que nada foi encontrado nas bases consultadas. Ficam de fora:</p>
        <ul>${d.naoCobre.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
      </div>
    </section>

    <section class="cartao">
      <h2>Candidaturas</h2>
      <p class="orgao">TSE – Tribunal Superior Eleitoral</p>
      <div class="tabela-rolagem"><table>
        <thead><tr><th>Ano</th><th>Cargo</th><th>Local</th><th>Partido</th><th>Resultado</th><th>Registro</th><th class="num">Bens declarados</th></tr></thead>
        <tbody>${d.candidaturas.map((c) => `<tr>
          <td>${c.ano}</td><td>${esc(capitalizar(c.cargo))}</td><td>${esc(capitalizar(c.unidade))}${c.uf && c.uf !== c.unidade ? `/${esc(c.uf)}` : ''}</td>
          <td>${esc(c.partido)}</td><td>${esc(capitalizar(c.resultado ?? '—'))}</td><td>${esc(capitalizar(c.situacao ?? '—'))}</td>
          <td class="num">${brl(c.bens)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>

    ${blocoFinanciamento(d.financiamento)}

    ${blocoBens(d.bens)}

    ${d.fontes.map(blocoFonte).join('')}

    <p class="meta" style="margin-top:16px">Consulta feita em ${new Date(d.consultadoEm).toLocaleString('pt-BR')}.
      Índice local do TSE/TCU atualizado em ${d.indiceAtualizadoEm ? new Date(d.indiceAtualizadoEm).toLocaleString('pt-BR') : '—'}.</p>`;
}

// ---------------------------------------------------------------- rotas

function rotear() {
  const h = location.hash.slice(1) || '/';
  const perfil = h.match(/^\/p\/([\w-]+)/);
  if (perfil) return telaPerfil(perfil[1]);
  document.title = 'Ficha Pública';
  const q = new URLSearchParams(h.split('?')[1] ?? '').get('q') ?? '';
  telaBusca(q);
}
window.addEventListener('hashchange', rotear);
rotear();
