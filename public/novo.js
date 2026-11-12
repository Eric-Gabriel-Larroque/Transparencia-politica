// Ficha Pública – interface (página inicial "/" e ficha "/p/<id>").
// Usa a mesma API do site atual; só a apresentação muda.

const app = document.getElementById('app');

// ---------------------------------------------------------------- utilidades

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const RESULTADOS = { 'ELEITO POR QP': 'Eleito por quociente partidário', 'ELEITO POR MÉDIA': 'Eleito por média', '2º TURNO': 'Foi ao 2º turno' };
const resultado = (r) => RESULTADOS[String(r ?? '').toUpperCase()] ?? null;
const cap = (s) => String(s ?? '').toLowerCase().replace(/(^|[\s(/-])\S/g, (l) => l.toUpperCase());
const brl = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const brlInteiro = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
function compacto(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return `R$ ${(v / 1e9).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} bi`;
  if (a >= 1e6) return `R$ ${(v / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (a >= 1e3) return `R$ ${(v / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`;
  return brlInteiro(v);
}
/** "R$ 1.666.688,38" vira "R$ 1,7 mi" no destaque, com o valor exato logo abaixo. */
function valorNumero(valor) {
  const t = String(valor ?? '');
  const m = t.match(/^(-?)R\$\s*([\d.]+),(\d{2})$/);
  const n = m ? Number(`${m[1]}${m[2].replace(/\./g, '')}.${m[3]}`) : NaN;
  if (!Number.isFinite(n) || Math.abs(n) < 1e6) return `<b>${esc(t)}</b>`;
  return `<b title="${esc(t)}">${esc(compacto(n))}</b><span class="meta">${esc(t)}</span><br>`;
}
const iniciais = (nome) => String(nome ?? '').split(' ').filter((p) => p.length > 2).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
const plural = (n, um, varios) => `${n.toLocaleString('pt-BR')} ${n === 1 ? um : varios}`;

async function api(caminho) {
  const res = await fetch(caminho);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).erro ?? `Erro ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------- textos "o que isso significa?"

const EXPLICA = {
  tcu: 'O Tribunal de Contas da União julga quem administra dinheiro federal. "Contas irregulares" quer dizer que o TCU concluiu, em decisão definitiva, que houve falha grave na prestação de contas, como dano aos cofres públicos ou gasto sem comprovação. Não é condenação criminal, mas pode tornar a pessoa inelegível.',
  cnj: 'Cadastro do Conselho Nacional de Justiça com condenações cíveis por improbidade administrativa (uso indevido do cargo ou de dinheiro público) e condenações que geram inelegibilidade. São processos cíveis, não criminais.',
  cgu: 'Listas de punições administrativas da Controladoria-Geral da União: CEIS (proibidos de contratar com o governo), CNEP (punidos pela Lei Anticorrupção) e CEAF (servidores expulsos da administração federal).',
  tse: 'Todo pedido de candidatura é julgado pela Justiça Eleitoral. O registro pode ser indeferido pela Lei da Ficha Limpa, por falta de documentos ou por outros motivos. Quando o TSE informa o motivo, ele aparece aqui.',
  djen: 'O Diário de Justiça Eletrônico publica intimações e decisões de todos os tribunais. A busca é pelo nome, porque o diário não informa CPF: o processo pode ser de outra pessoa com o mesmo nome. E estar num processo não significa ser culpado: a pessoa pode ser autora, ré, testemunha ou vítima.',
  bens: 'Ao se candidatar, todo candidato entrega à Justiça Eleitoral a lista dos seus bens. Os valores são os que o próprio candidato informou: não são auditados, costumam seguir o valor de compra (não o de mercado) e não têm correção pela inflação.',
  financiamento: 'Toda campanha presta contas à Justiça Eleitoral. "Dinheiro público" é a soma do Fundo Eleitoral (FEFC) e do Fundo Partidário, distribuídos pelos partidos. O restante vem de doações de pessoas, recursos do próprio candidato e outras fontes. Os valores incluem doações estimáveis, como serviços e materiais doados.',
  empresas: 'Empresas em que a pessoa aparece como sócia no cadastro da Receita Federal. O cruzamento usa o nome completo e os 6 dígitos do CPF que a Receita deixa visíveis. Para cada empresa, consultamos o Portal da Transparência para saber se ela tem contratos, recebeu pagamentos ou foi punida pelo governo federal. Ser sócio de empresa com contrato público não é irregular por si só.',
};

const CORRESPONDENCIA = {
  cpf: 'cruzado pelo CPF',
  nome_nascimento: 'cruzado pelo nome e data de nascimento',
  nome_cpf_parcial: 'cruzado pelo nome e CPF parcial',
  nome: 'só pelo nome (pode ser homônimo)',
};

// ---------------------------------------------------------------- integridade: status de cada fonte

function statusIntegridade(f) {
  if (!f) return null;
  if (f.status === 'erro') return { classe: 'neutro', icone: '?', texto: 'Não foi possível consultar agora.', confirmados: 0, porNome: 0 };
  if (f.status === 'nao_aplicavel') return { classe: 'neutro', icone: '–', texto: f.motivo, confirmados: 0, porNome: 0 };
  if (f.id === 'djen') {
    const k = f.contagem ?? { total: 0, outros: 0 };
    return k.total
      ? { classe: 'atencao', icone: '!', confirmados: 0, porNome: k.total,
        texto: `<strong class="atencao">${plural(k.total, 'processo', 'processos')}</strong> em tribunais de ${esc(k.onde)} com alguém do mesmo nome${k.criminal ? ` (${k.criminal} de classe criminal)` : ''}.` }
      : { classe: 'bom', icone: '✓', confirmados: 0, porNome: 0,
        texto: `<strong class="bom">Nada encontrado</strong> em tribunais de ${esc(k.onde ?? 'seu estado')} desde 2024.` };
  }
  const regs = f.registros ?? [];
  const porNome = regs.filter((r) => (r.correspondencia ?? f.correspondencia) === 'nome').length;
  const confirmados = regs.length - porNome;
  if (confirmados) {
    return { classe: 'critico', icone: '!', confirmados, porNome,
      texto: `<strong class="critico">${plural(confirmados, 'registro confirmado', 'registros confirmados')}</strong>${f.id === 'tse' ? '' : ' pelo CPF'}.` };
  }
  if (porNome) return { classe: 'atencao', icone: '!', confirmados, porNome, texto: `<strong class="atencao">${plural(porNome, 'registro', 'registros')}</strong> de alguém com o mesmo nome, sem CPF para confirmar.` };
  return { classe: 'bom', icone: '✓', confirmados: 0, porNome: 0, texto: '<strong class="bom">Nada consta</strong>.' };
}

const TITULOS_INTEGRIDADE = {
  tcu: 'Tribunal de Contas da União',
  cnj: 'Condenações por improbidade (CNJ)',
  cgu: 'Punições administrativas (CGU)',
  tse: 'Registro de candidatura (TSE)',
  djen: 'Processos no Diário de Justiça',
};

function itemRegistro(r, classe) {
  const titulo = r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.titulo)} ↗</a>` : esc(r.titulo);
  return `<li class="registro ${classe}"><div class="r-titulo">${titulo}${r.data ? ` <span class="meta">· ${esc(r.data)}</span>` : ''}</div>
    ${r.situacao ? `<div class="r-sit">${esc(r.situacao)}</div>` : ''}${r.detalhe ? `<div class="r-det">${esc(r.detalhe)}</div>` : ''}</li>`;
}

function blocoVerificacao(f) {
  const s = statusIntegridade(f);
  if (!s) return '';
  const regs = f.registros ?? [];
  const lista = regs.length ? `<ul class="registros">${regs.slice(0, 6).map((r) => itemRegistro(r, (r.correspondencia ?? f.correspondencia) === 'nome' ? 'atencao' : s.classe)).join('')}</ul>
    ${regs.length > 6 ? `<details class="explica"><summary>Ver todos os ${regs.length}</summary><ul class="registros">${regs.slice(6).map((r) => itemRegistro(r, s.classe)).join('')}</ul></details>` : ''}` : '';
  const outros = f.registrosOutros?.length ? `<details class="explica"><summary>${esc(f.tituloOutros)}</summary>
    <ul class="registros">${f.registrosOutros.map((r) => itemRegistro(r, '')).join('')}</ul></details>` : '';
  return `<div class="verificacao">
    <div class="icone-status ${s.classe}" aria-hidden="true">${s.icone}</div>
    <div>
      <h3>${esc(TITULOS_INTEGRIDADE[f.id] ?? f.nome)}</h3>
      <p class="resultado">${s.texto}</p>
      ${f.status === 'ok' && f.correspondencia ? `<div class="meta">${esc(CORRESPONDENCIA[f.correspondencia] ?? '')}</div>` : ''}
      ${lista}${outros}
      ${EXPLICA[f.id] ? `<details class="explica"><summary>ⓘ O que isso significa?</summary><p>${esc(EXPLICA[f.id])}</p></details>` : ''}
      ${f.link ? `<div class="links-fonte"><a href="${esc(f.link)}" target="_blank" rel="noopener">Fonte oficial ↗</a></div>` : ''}
    </div>
  </div>`;
}

// ---------------------------------------------------------------- gráficos

/** Barras verticais de uma série (evolução do patrimônio). Rótulo de valor em cada barra (poucas barras). */
function graficoBarras(pontos) {
  const L = 600; const A = 230; const m = { t: 24, r: 8, b: 26, l: 8 };
  const max = Math.max(...pontos.map((p) => p.valor), 1);
  const largura = (L - m.l - m.r) / pontos.length;
  const lb = Math.min(72, largura * 0.56);
  const y = (v) => m.t + (A - m.t - m.b) * (1 - v / max);
  const base = A - m.b;
  const barras = pontos.map((p, i) => {
    const cx = m.l + largura * (i + 0.5);
    const x = cx - lb / 2; const yt = Math.min(y(p.valor), base - 4); const r = 4;
    // topo arredondado (4px), base reta ancorada no eixo
    const d = `M${x},${base} V${yt + r} Q${x},${yt} ${x + r},${yt} H${x + lb - r} Q${x + lb},${yt} ${x + lb},${yt + r} V${base} Z`;
    return `<path class="barra-dado" d="${d}"></path>
      <text class="rotulo-barra" x="${cx}" y="${yt - 7}" text-anchor="middle">${esc(compacto(p.valor))}</text>
      <text class="eixo" x="${cx}" y="${A - 8}" text-anchor="middle">${p.rotulo}</text>
      <rect class="alvo" x="${m.l + largura * i}" y="${m.t - 20}" width="${largura}" height="${A - m.t}" data-dica="${esc(`${p.rotulo}: ${brl(p.valor)}`)}"></rect>`;
  }).join('');
  return `<div class="grafico" data-grafico><svg viewBox="0 0 ${L} ${A}" role="img" aria-label="Evolução dos bens declarados">
    <line class="grade" x1="${m.l}" x2="${L - m.r}" y1="${base}" y2="${base}"></line>${barras}</svg><div class="dica"></div></div>`;
}

function ligarDicas(raiz) {
  raiz.querySelectorAll('[data-grafico]').forEach((g) => {
    const dica = g.querySelector('.dica');
    g.querySelectorAll('[data-dica]').forEach((alvo) => {
      const mostrar = (e) => {
        const caixa = g.getBoundingClientRect();
        const r = alvo.getBoundingClientRect();
        dica.textContent = alvo.dataset.dica;
        dica.style.left = `${r.left - caixa.left + r.width / 2}px`;
        dica.style.top = `${(e.clientY ?? r.top) - caixa.top}px`;
        dica.classList.add('visivel');
      };
      alvo.addEventListener('mousemove', mostrar);
      alvo.addEventListener('click', mostrar);
      alvo.addEventListener('mouseleave', () => dica.classList.remove('visivel'));
    });
  });
}

/** Barra de composição: dinheiro público × privado, com legenda e valores. */
function composicaoCampanha(c) {
  const privado = Math.max(0, c.arrecadado - c.publico);
  const pPub = c.arrecadado > 0 ? (c.publico / c.arrecadado) * 100 : 0;
  return `<div class="composicao" role="img" aria-label="${Math.round(pPub)}% dinheiro público">
      ${c.publico > 0 ? `<span style="width:${pPub}%;background:var(--serie-2)" title="Dinheiro público"></span>` : ''}
      ${privado > 0 ? `<span style="width:${100 - pPub}%;background:var(--serie-1)" title="Outras fontes"></span>` : ''}
    </div>
    <div class="legenda">
      <span><i style="background:var(--serie-2)"></i>Dinheiro público: <b>${brlInteiro(c.publico)}</b> (${Math.round(pPub)}%)</span>
      <span><i style="background:var(--serie-1)"></i>Outras fontes: <b>${brlInteiro(privado)}</b> (${Math.round(100 - pPub)}%)</span>
    </div>`;
}

// ---------------------------------------------------------------- abas

function abaIntegridade(d) {
  const fontes = Object.fromEntries(d.fontes.map((f) => [f.id, f]));
  const ordem = ['tcu', 'cnj', 'cgu', 'tse', 'djen'];
  return `<section class="cartao">
      <div class="titulo-secao"><h2>Justiça e órgãos de controle</h2></div>
      <p class="origem">Consultado em ${new Date(d.consultadoEm).toLocaleString('pt-BR')} direto nas bases oficiais.</p>
      ${ordem.map((id) => blocoVerificacao(fontes[id])).join('')}
    </section>
    <section class="cartao aviso">
      <strong>O que esta ficha não verifica</strong>
      <ul>${d.naoCobre.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    </section>`;
}

function abaDinheiro(d) {
  const bens = d.bens ?? [];
  const blocoBens = bens.length ? `<section class="cartao">
      <div class="titulo-secao"><h2>Patrimônio declarado</h2></div>
      <p class="origem">TSE – bens declarados a cada candidatura · <a href="${esc(bens.at(-1).link)}" target="_blank" rel="noopener">fonte oficial ↗</a></p>
      ${bens.length > 1 ? graficoBarras(bens.map((b) => ({ rotulo: String(b.ano), valor: b.total }))) : `<div class="numeros"><div class="numero"><b>${brl(bens[0].total)}</b><span>declarados em ${bens[0].ano}</span></div></div>`}
      <details class="explica"><summary>ⓘ O que isso significa?</summary><p>${esc(EXPLICA.bens)}</p></details>
      ${bens.slice().reverse().map((b) => `<details class="explica"><summary>Ver os ${b.qtd} bens declarados em ${b.ano}</summary>
        <ul class="lista-valores">${b.itens.map((i) => `<li><div>${esc(i.descricao ?? '—')}<div class="meta">${esc(i.tipo ?? '')}</div></div><span class="valor">${brl(i.valor)}</span></li>`).join('')}</ul></details>`).join('')}
    </section>` : '';

  const camp = d.financiamento ?? [];
  const blocoCamp = camp.length ? camp.map((c, i) => `<section class="cartao">
      <div class="titulo-secao"><h2>Campanha de ${c.ano}</h2><span class="chip">${esc(cap(c.cargo))}${c.unidade ? ` · ${esc(cap(c.unidade))}` : ''}</span></div>
      <p class="origem">TSE – prestação de contas eleitorais · <a href="${esc(c.link)}" target="_blank" rel="noopener">fonte oficial ↗</a></p>
      <div class="numeros">
        <div class="numero"><b>${brlInteiro(c.arrecadado)}</b><span>arrecadado</span></div>
        <div class="numero"><b>${brlInteiro(c.gasto)}</b><span>gastos contratados</span></div>
      </div>
      ${composicaoCampanha(c)}
      ${i === 0 ? `<details class="explica"><summary>ⓘ O que isso significa?</summary><p>${esc(EXPLICA.financiamento)}</p></details>` : ''}
      <h3 class="sub">Maiores doadores</h3>
      <ul class="lista-valores">${c.doadores.slice(0, 5).map((x) => `<li><div>${esc(x.nome ?? x.doc)}<div class="meta">${esc(x.origem ?? '')}</div></div><span class="valor">${brlInteiro(x.total)}</span></li>`).join('')}</ul>
      <details class="explica"><summary>Com o que gastou e maiores fornecedores</summary>
        <h3 class="sub">Com o que gastou</h3>
        <ul class="lista-valores">${c.despesas.map((x) => `<li><div>${esc(x.categoria)}</div><span class="valor">${brlInteiro(x.total)}</span></li>`).join('')}</ul>
        <h3 class="sub">Maiores fornecedores</h3>
        <ul class="lista-valores">${c.fornecedores.slice(0, 8).map((x) => `<li><div>${esc(x.nome ?? x.doc)}</div><span class="valor">${brlInteiro(x.total)}</span></li>`).join('')}</ul>
      </details>
    </section>`).join('') : '';
  return `<div class="grade-2"><div>${blocoBens}</div><div>${blocoCamp || '<section class="cartao"><p class="meta">Sem prestação de contas de campanha nas eleições indexadas.</p></section>'}</div></div>`;
}

function abaEmpresas(d) {
  const f = d.fontes.find((x) => x.id === 'empresas');
  if (!f || f.status !== 'ok') return `<section class="cartao"><p class="meta">${esc(f?.motivo ?? 'Sem dados de empresas.')}</p></section>`;
  const regs = f.registros ?? [];
  return `<section class="cartao">
    <div class="titulo-secao"><h2>Empresas das quais é sócio(a)</h2></div>
    <p class="origem">Receita Federal (quadro de sócios) + CGU – Portal da Transparência · ${esc(CORRESPONDENCIA[f.correspondencia] ?? '')}</p>
    ${f.indicadores?.length ? `<div class="numeros">${f.indicadores.map((i) => `<div class="numero"><b>${esc(i.valor)}</b><span>${esc(i.rotulo)}</span></div>`).join('')}</div>` : ''}
    <details class="explica"><summary>ⓘ O que isso significa?</summary><p>${esc(EXPLICA.empresas)}</p></details>
    ${f.aviso ? `<p class="meta">${esc(f.aviso)}</p>` : ''}
    ${regs.length ? `<ul class="registros">${regs.map((r) => itemRegistro(r, /SANCIONADA/.test(r.detalhe ?? '') ? 'critico' : '')).join('')}</ul>` : ''}
  </section>`;
}

/** Agrupa votos pela proposição: ementa uma vez só e os votos resumidos numa linha. */
function listaVotos(l) {
  const grupos = new Map();
  for (const r of l.registros) {
    const [prop, voto] = String(r.titulo).split(' – votou ');
    if (!voto) continue;
    const g = grupos.get(prop) ?? { prop, ementa: r.detalhe, link: r.link, votos: [], ultima: r.data };
    g.votos.push(voto);
    grupos.set(prop, g);
  }
  const itens = [...grupos.values()].map((g) => `<li class="registro">
      <div class="r-titulo">${g.link ? `<a href="${esc(g.link)}" target="_blank" rel="noopener">${esc(g.prop)} ↗</a>` : esc(g.prop)}
        <span class="meta">· ${plural(g.votos.length, 'votação', 'votações')}${g.ultima ? `, última em ${esc(g.ultima)}` : ''}</span></div>
      <div class="r-sit">Votou: <b>${g.votos.map(esc).join(' · ')}</b></div>
      ${g.ementa ? `<div class="r-det">${esc(g.ementa)}</div>` : ''}</li>`);
  if (!itens.length) return '';
  return `<h3 class="sub">${esc(l.titulo)}</h3>
    <ul class="registros">${itens.slice(0, 5).join('')}</ul>
    ${itens.length > 5 ? `<details class="explica"><summary>Ver mais ${itens.length - 5}</summary><ul class="registros">${itens.slice(5).join('')}</ul></details>` : ''}`;
}

function abaAtuacao(d) {
  const casas = d.fontes.filter((f) => ['camara', 'senado'].includes(f.id) && f.status === 'ok');
  if (!casas.length) return '<section class="cartao"><p class="meta">Sem mandato na Câmara dos Deputados ou no Senado desde 1983.</p></section>';
  return casas.map((f) => `<section class="cartao">
    <div class="titulo-secao"><h2>${esc(f.id === 'camara' ? 'Câmara dos Deputados' : 'Senado Federal')}</h2>
      <a class="botao" href="${esc(f.link)}" target="_blank" rel="noopener">Página oficial ↗</a></div>
    <p class="origem">${esc(f.orgao)} · ${esc(CORRESPONDENCIA[f.correspondencia] ?? '')}</p>
    <div class="numeros">${(f.indicadores ?? []).map((i) => `<div class="numero">${valorNumero(i.valor)}<span>${esc(i.rotulo)}</span>${i.detalhe ? `<div class="meta">${esc(i.detalhe)}</div>` : ''}</div>`).join('')}</div>
    ${(f.listasExtras ?? []).map((l) => listaVotos(l)).join('')}
    ${f.registros?.length ? `<details class="explica"><summary>${esc(f.tituloRegistros ?? 'Proposições')}</summary><ul class="registros">${f.registros.map((r) => itemRegistro(r, '')).join('')}</ul></details>` : ''}
  </section>`).join('');
}

function abaCandidaturas(d) {
  return `<section class="cartao">
    <div class="titulo-secao"><h2>Candidaturas</h2></div>
    <p class="origem">TSE – candidaturas desde 2018</p>
    <div class="rolagem"><table class="cartoes-celular">
      <thead><tr><th>Ano</th><th>Cargo</th><th>Local</th><th>Partido</th><th>Resultado</th><th class="num">Bens</th></tr></thead>
      <tbody>${d.candidaturas.map((c) => `<tr><td data-rotulo="Ano"><b>${c.ano}</b></td><td data-rotulo="Cargo">${esc(cap(c.cargo))}</td>
        <td data-rotulo="Local">${esc(cap(c.unidade))}${c.uf && c.uf !== c.unidade && c.uf !== 'BR' ? `/${esc(c.uf)}` : ''}</td><td data-rotulo="Partido">${esc(c.partido)}</td>
        <td data-rotulo="Resultado">${esc(resultado(c.resultado) ?? cap(c.resultado ?? c.situacao ?? '—'))}</td><td class="num" data-rotulo="Bens">${compacto(c.bens)}</td></tr>`).join('')}</tbody>
    </table></div>
  </section>`;
}

// ---------------------------------------------------------------- ficha

function cabecalho(d) {
  const p = d.pessoa;
  const ultima = d.candidaturas[0];
  const eleito = d.candidaturas.find((c) => /^ELEITO/i.test(c.resultado ?? ''));
  const foto = p.foto ?? d.fontes.find((f) => f.foto)?.foto;
  const urna = p.urnas[0] ?? p.nome;
  return `<section class="cartao perfil">
    <div class="avatar" aria-hidden="${foto ? 'false' : 'true'}"><span>${esc(iniciais(p.nome))}</span>${foto
      ? `<img src="${esc(foto)}" alt="Foto oficial de ${esc(cap(urna))}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}</div>
    <div>
      <h1>${esc(cap(urna))}</h1>
      <div class="civil">${esc(cap(p.nome))}${p.nascimento ? ` · nascido(a) em ${esc(p.nascimento)}` : ''}</div>
      <div class="chips">
        <span class="chip marca">${esc(cap(ultima.cargo))} · ${esc(ultima.uf === 'BR' ? 'Brasil' : ultima.uf)} · ${esc(ultima.partido)}</span>
        ${eleito ? `<span class="chip bom">Eleito(a) em ${eleito.ano}</span>` : `<span class="chip">Não eleito(a) desde 2018</span>`}
      </div>
    </div>
    <div class="perfil-acoes">
      <span class="conferido">Dados conferidos em ${new Date(d.consultadoEm).toLocaleDateString('pt-BR')}</span>
      <div class="chips">
        <button type="button" class="botao" data-compartilhar>Compartilhar</button>
        <a class="botao" href="#reportar" data-ir-reporte>Reportar erro</a>
      </div>
    </div>
  </section>`;
}

function destaques(d) {
  const fontes = Object.fromEntries(d.fontes.map((f) => [f.id, f]));
  const st = ['tcu', 'cnj', 'cgu', 'tse'].map((id) => statusIntegridade(fontes[id])).filter(Boolean);
  const confirmados = st.reduce((s, x) => s + x.confirmados, 0);
  const porNome = st.reduce((s, x) => s + x.porNome, 0) + (fontes.djen?.contagem?.total ?? 0);
  const algumErro = ['tcu', 'cnj', 'cgu', 'tse'].some((id) => fontes[id]?.status === 'erro');

  const bens = d.bens ?? [];
  const ultimoBem = bens.at(-1);
  const variacao = bens.length > 1 && bens[0].total > 0 ? Math.round(((ultimoBem.total - bens[0].total) / bens[0].total) * 100) : null;
  const camp = d.financiamento?.[0];
  const emp = fontes.empresas;
  const k = emp?.contagem;

  const kpi = (classe, aba, rotulo, valor, sub) => `<a class="kpi ${classe}" href="#${aba}" data-ir-aba="${aba}">
    <span class="kpi-rotulo">${rotulo}</span><span class="kpi-valor">${valor}</span><span class="kpi-sub">${sub}</span></a>`;

  return `<div class="destaques">
    ${confirmados
      ? kpi('critico', 'integridade', 'Justiça e controle', plural(confirmados, 'registro', 'registros'), 'confirmados pelo CPF em TCU, CNJ, CGU ou TSE')
      : kpi(algumErro ? 'atencao' : 'bom', 'integridade', 'Justiça e controle', algumErro ? 'Incompleto' : 'Nada consta',
        `${algumErro ? 'alguma fonte não respondeu' : 'em TCU, CNJ, CGU e TSE'}${porNome ? ` · ${porNome} registro(s) só pelo nome` : ''}`)}
    ${ultimoBem ? kpi('neutro', 'dinheiro', 'Patrimônio declarado', compacto(ultimoBem.total),
      variacao != null ? `${variacao >= 0 ? '+' : ''}${variacao.toLocaleString('pt-BR')}% desde ${bens[0].ano}` : `declarado em ${ultimoBem.ano}`) : kpi('neutro', 'dinheiro', 'Patrimônio declarado', '—', 'sem declaração')}
    ${camp ? kpi('neutro', 'dinheiro', `Campanha ${camp.ano}`, compacto(camp.arrecadado), `${camp.percentualPublico}% dinheiro público`) : kpi('neutro', 'dinheiro', 'Campanha', '—', 'sem prestação de contas')}
    ${k ? kpi(k.sancionadas ? 'critico' : 'neutro', 'empresas', 'Empresas', plural(k.total, 'empresa', 'empresas'),
      k.consultadas ? `${k.comDinheiroFederal} com dinheiro federal${k.sancionadas ? ` · ${k.sancionadas} sancionada(s)` : ''}` : 'Receita Federal')
      : kpi('neutro', 'empresas', 'Empresas', emp?.status === 'ok' ? 'Nenhuma' : '—', emp?.status === 'ok' ? 'no quadro de sócios da Receita' : 'sem CPF para cruzar')}
  </div>`;
}

const ABAS = [
  ['integridade', 'Justiça e controle', abaIntegridade],
  ['dinheiro', 'Dinheiro', abaDinheiro],
  ['empresas', 'Empresas', abaEmpresas],
  ['atuacao', 'Atuação', abaAtuacao],
  ['candidaturas', 'Candidaturas', abaCandidaturas],
];

function selecionarAba(nome, rolar = false) {
  const valida = ABAS.some(([id]) => id === nome) ? nome : 'integridade';
  app.querySelectorAll('.aba').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.aba === valida)));
  app.querySelectorAll('.painel').forEach((p) => { p.hidden = p.dataset.painel !== valida; });
  history.replaceState(null, '', `#${valida}`);
  if (rolar) app.querySelector('.abas')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function telaFicha(id) {
  app.innerHTML = `<div class="cartao"><div class="esqueleto" style="height:96px"></div></div>
    <div class="destaques">${'<div class="kpi"><div class="esqueleto" style="height:58px"></div></div>'.repeat(4)}</div>
    <p class="carregando">Consultando TSE, TCU, CNJ, CGU, Receita e Diário de Justiça…</p>`;
  let d;
  try { d = await api(`/api/politico/${encodeURIComponent(id)}`); } catch (e) {
    app.innerHTML = `<section class="cartao"><p>${esc(e.message)}</p><a href="/">← Voltar</a></section>`; return;
  }
  document.title = `${cap(d.pessoa.urnas[0] ?? d.pessoa.nome)} · Ficha Pública`;
  const integ = ['tcu', 'cnj', 'cgu', 'tse'].map((x) => statusIntegridade(d.fontes.find((f) => f.id === x))).filter(Boolean);
  const nAlertas = integ.reduce((s, x) => s + x.confirmados, 0);
  const temAtuacao = d.fontes.some((f) => ['camara', 'senado'].includes(f.id) && f.status === 'ok');

  app.innerHTML = `${cabecalho(d)}${destaques(d)}
    <nav class="abas" role="tablist">${ABAS.filter(([id]) => id !== 'atuacao' || temAtuacao).map(([idAba, rotulo]) => `
      <button class="aba" role="tab" data-aba="${idAba}">${rotulo}${idAba === 'integridade' && nAlertas ? ` <span class="contagem critico">${nAlertas}</span>` : ''}</button>`).join('')}</nav>
    ${ABAS.map(([idAba, , render]) => `<div class="painel" role="tabpanel" data-painel="${idAba}">${render(d)}</div>`).join('')}
    ${blocoReporte(d)}
    <p class="apoio">Achou útil? Você pode ajudar a manter o servidor no ar: <a href="${esc(d.apoio?.url ?? '#')}" target="_blank" rel="noopener">☕ Buy me a coffee</a></p>`;
  ligarReporte(d.pessoa.id);
  app.querySelector('[data-ir-reporte]')?.addEventListener('click', (e) => {
    e.preventDefault(); document.getElementById('reportar')?.scrollIntoView({ behavior: 'smooth' });
  });

  app.querySelectorAll('.aba').forEach((b) => b.addEventListener('click', () => selecionarAba(b.dataset.aba)));
  app.querySelectorAll('[data-ir-aba]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); selecionarAba(a.dataset.irAba, true); }));
  selecionarAba(location.hash.slice(1));
  ligarDicas(app);
  app.querySelector('[data-compartilhar]')?.addEventListener('click', async (e) => {
    const url = `${location.origin}/p/${d.pessoa.id}`;
    if (navigator.share) { try { await navigator.share({ title: document.title, url }); } catch { /* cancelado */ } return; }
    try { await navigator.clipboard.writeText(url); e.target.textContent = 'Link copiado ✓'; } catch { e.target.textContent = url; }
  });
}

// ---------------------------------------------------------------- reportar erro

function blocoReporte(d) {
  const secoes = ['Justiça e controle', 'Dinheiro', 'Empresas', 'Atuação', 'Candidaturas', 'Outro'];
  return `<section class="cartao reporte" id="reportar">
    <div class="titulo-secao"><h2>Encontrou um erro?</h2></div>
    <p class="origem">Dado errado, homônimo misturado ou informação desatualizada: conte o que viu. Se você é a pessoa desta ficha, também pode usar este canal.</p>
    <form data-reporte>
      <label>Em qual parte?<select name="secao">${secoes.map((x) => `<option>${esc(x)}</option>`).join('')}</select></label>
      <label>O que está errado?<textarea name="mensagem" rows="4" required minlength="10" maxlength="3000"
        placeholder="Ex.: o processo X é de outra pessoa com o mesmo nome"></textarea></label>
      <label>Contato para retorno (opcional)<input name="contato" maxlength="200" placeholder="e-mail ou telefone"></label>
      <button type="submit" class="botao primario">Enviar</button>
      <p class="meta" data-status></p>
    </form>
  </section>`;
}

function ligarReporte(id) {
  const form = app.querySelector('[data-reporte]');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = form.querySelector('[data-status]');
    const botao = form.querySelector('button');
    botao.disabled = true; status.textContent = 'Enviando…';
    try {
      const res = await fetch('/api/reportar', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ficha: id, nome: document.querySelector('h1')?.textContent, secao: form.secao.value,
          mensagem: form.mensagem.value, contato: form.contato.value }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.erro ?? 'Não foi possível enviar agora.');
      form.innerHTML = '<p class="aviso">Obrigado! Seu reporte foi registrado e será analisado.</p>';
    } catch (err) { status.textContent = err.message; botao.disabled = false; }
  });
}

// ---------------------------------------------------------------- busca (página inicial)

function telaInicio(q = '') {
  document.title = 'Ficha Pública · ficha de integridade de qualquer político';
  app.innerHTML = `<section class="hero">
      <h1>Veja se um político tem problemas com a Justiça, com quem ele se relaciona e quem pagou a campanha dele.</h1>
      <p>Processos, contas reprovadas no TCU, punições, empresas com contratos públicos, doadores e patrimônio de qualquer pessoa que já se candidatou no Brasil. Só dados oficiais, sem anúncios.</p>
      <form data-busca><input name="q" type="search" placeholder="Nome, nome de urna ou CPF" value="${esc(q)}" aria-label="Buscar político" required minlength="3"><button>Buscar</button></form>
    </section>
    <div id="resultados"></div>
    <div class="pilares">
      <div class="pilar"><h3>⚖️ Justiça e controle</h3><p>TCU, condenações por improbidade, punições da CGU, registro de candidatura e processos no Diário de Justiça.</p></div>
      <div class="pilar"><h3>💰 Dinheiro</h3><p>Evolução do patrimônio declarado e quem financiou cada campanha, com o peso do dinheiro público.</p></div>
      <div class="pilar"><h3>🏢 Empresas</h3><p>De quais empresas é sócio e se elas têm contratos, pagamentos ou punições do governo federal.</p></div>
      <div class="pilar"><h3>🗳️ Todos os candidatos</h3><p>De vereador a presidente: mais de 880 mil pessoas, com fonte oficial em cada informação.</p></div>
    </div>`;
  app.querySelector('[data-busca]').addEventListener('submit', (e) => {
    e.preventDefault(); const v = e.target.q.value.trim();
    history.pushState(null, '', `/?q=${encodeURIComponent(v)}`); buscar(v);
  });
  if (q) buscar(q);
}

async function buscar(q) {
  const alvo = document.getElementById('resultados');
  if (!alvo) return telaInicio(q);
  alvo.innerHTML = '<p class="carregando">Buscando…</p>';
  const { resultados } = await api(`/api/buscar?q=${encodeURIComponent(q)}`);
  alvo.innerHTML = resultados.length ? `<ul class="resultados">${resultados.map((r) => `<li><a href="/p/${esc(r.id)}">
      <span class="nome">${esc(cap(r.urnas[0] ?? r.nome))}</span>${r.eleito ? `<span class="chip bom">eleito(a) ${r.eleito}x</span>` : '<span></span>'}
      <span class="info">${esc(cap(r.nome))} · ${esc(r.cargos.map(cap).join(', '))} · ${esc(r.ufs.join(', '))} · ${esc(r.partidos.join(', '))} · ${r.anos[0]}–${r.anos[1]}</span></a></li>`).join('')}</ul>`
    : '<p class="carregando">Ninguém encontrado. Tente o nome completo ou o nome de urna.</p>';
}

// ---------------------------------------------------------------- rotas

function rotear() {
  // Links antigos com # (ex.: /#/p/2022-123) continuam funcionando.
  if (location.hash.startsWith('#/')) history.replaceState(null, '', location.hash.slice(1));
  const m = location.pathname.match(/^\/p\/(\d{4}-\d+)/);
  if (m) return telaFicha(m[1]);
  telaInicio(new URLSearchParams(location.search).get('q') ?? '');
}
document.querySelector('[data-busca-topo]')?.addEventListener('submit', (e) => {
  e.preventDefault(); const v = e.target.q.value.trim(); if (!v) return;
  history.pushState(null, '', `/?q=${encodeURIComponent(v)}`); telaInicio(v);
});
window.addEventListener('popstate', rotear);
rotear();
