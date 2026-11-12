// Servidor HTTP: páginas (com título e pré-visualização gerados no servidor), API de busca/perfil,
// sitemap para buscadores e recebimento de reportes de erro.
// Sem dependências externas: node:http + node:sqlite.

import http from 'node:http';
import dns from 'node:dns';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { abrirBanco } from './lib/db.js';
import { lerFicha, gravarFicha, registrarReporte } from './lib/cache.js';
import { normalizar, soDigitos, mascararCpf } from './lib/util.js';
import { montarResumo, NAO_COBRE } from './resumo.js';
import { tse, tcu } from './fontes/locais.js';
import { cnj } from './fontes/cnj.js';
import { camara, senado } from './fontes/legislativo.js';
import { cgu } from './fontes/cgu.js';
import { djen } from './fontes/djen.js';
import { carregarFinanciamento } from './fontes/financiamento.js';
import { empresas } from './fontes/empresas.js';
import { diarios } from './fontes/diarios.js';
import { criarPaginas } from './paginas.js';

// Prefere IPv4 nas conexões de saída. O IPv6 da Hostinger é registrado na Europa e serviços
// brasileiros com bloqueio por país (ex.: DJEN do CNJ) recusam esse endereço; o IPv4 é do Brasil.
dns.setDefaultResultOrder('ipv4first');

const FONTES = [tse, tcu, cnj, djen, cgu, empresas, camara, senado, diarios];
const PORTA = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // em produção: 127.0.0.1 (atrás do Caddy)
const SITE = (process.env.SITE_URL || 'https://transparencia-politica.tech').replace(/\/$/, '');
const LIMITE_POR_MINUTO = Number(process.env.LIMITE_POR_MINUTO) || 20;
const PUBLICO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const VALIDADE_CACHE = 24 * 60 * 60 * 1000; // ficha completa guardada por 24h (banco, sobrevive a reinícios)
const VALIDADE_CACHE_PARCIAL = 10 * 60 * 1000; // ficha com alguma fonte fora do ar: 10 min, só em memória
const TIMEOUT_FONTE = 45_000;
// Aumente quando o formato da ficha mudar: fichas guardadas no formato antigo deixam de ser usadas.
const FORMATO_FICHA = 2;
const POR_SITEMAP = 50_000;

const db = abrirBanco();
const paginas = criarPaginas(db, (process.env.SITE_URL || 'https://transparencia-politica.tech').replace(/\/$/, ''));
const cacheParcial = new Map();
const emAndamento = new Map(); // id -> Promise: várias pessoas abrindo a mesma ficha geram uma consulta só

// ---------------------------------------------------------------- busca

function buscar(q) {
  const digitos = soDigitos(q);
  if (digitos.length === 11) {
    return db.prepare('SELECT * FROM pessoas WHERE pessoa = ?').all(digitos);
  }
  const termos = normalizar(q).split(' ').filter((t) => t.length >= 2).slice(0, 6);
  if (!termos.length) return [];
  const where = termos.map(() => 'busca LIKE ?').join(' AND ');
  const linhas = db.prepare(`SELECT * FROM pessoas WHERE ${where}
    ORDER BY eleito DESC, ultimo_ano DESC, candidaturas DESC LIMIT 300`).all(...termos.map((t) => `%${t}%`));
  // Quem tem nome de urna ou nome completo exatamente igual ao digitado vem primeiro.
  const exato = termos.join(' ');
  const ehExato = (r) => normalizar(r.nome) === exato || (r.urnas ?? '').split(',').some((u) => normalizar(u) === exato);
  return [...linhas.filter(ehExato), ...linhas.filter((r) => !ehExato(r))].slice(0, 30);
}

function resumirPessoa(r) {
  return {
    id: r.id,
    nome: r.nome,
    urnas: r.urnas?.split(',') ?? [],
    partidos: r.partidos?.split(',') ?? [],
    cargos: r.cargos?.split(',') ?? [],
    ufs: r.ufs?.split(',') ?? [],
    anos: [r.primeiro_ano, r.ultimo_ano],
    candidaturas: r.candidaturas,
    eleito: r.eleito,
  };
}

// ---------------------------------------------------------------- perfil

function carregarPessoa(id) {
  const [ano, sq] = String(id).split('-');
  const ref = db.prepare('SELECT pessoa FROM candidaturas WHERE ano = ? AND sq = ?').get(Number(ano), sq);
  if (!ref) return null;
  const candidaturas = db.prepare('SELECT * FROM candidaturas WHERE pessoa = ? ORDER BY ano DESC').all(ref.pessoa);
  const ultima = candidaturas[0];
  const comCpf = candidaturas.find((c) => c.cpf && !c.cpf_inferido) ?? candidaturas.find((c) => c.cpf);
  return {
    pessoa: ref.pessoa,
    id,
    nome: ultima.nome,
    nome_norm: ultima.nome_norm,
    cpf: comCpf?.cpf ?? null,
    nascimento: ultima.nascimento,
    urnas: [...new Set(candidaturas.map((c) => c.urna).filter(Boolean))],
    cargos: [...new Set(candidaturas.map((c) => c.cargo).filter(Boolean))],
    candidaturas,
  };
}

function comTimeout(promessa, ms) {
  return Promise.race([promessa, new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), ms))]);
}

async function consultarFontes(p) {
  return Promise.all(FONTES.map(async (f) => {
    const base = { id: f.id, nome: f.nome, orgao: f.orgao, descricao: f.descricao };
    if (!f.aplicavel(p)) {
      const motivo = typeof f.motivoNaoAplicavel === 'function' ? f.motivoNaoAplicavel(p) : f.motivoNaoAplicavel;
      return { ...base, status: 'nao_aplicavel', motivo };
    }
    const inicio = Date.now();
    try {
      const r = await comTimeout(f.consultar(p, { db }), TIMEOUT_FONTE);
      if (r.naoAplicavel) return { ...base, status: 'nao_aplicavel', motivo: r.motivo };
      return { ...base, status: 'ok', ms: Date.now() - inicio, ...r };
    } catch (e) {
      console.error(`[${f.id}]`, e.message);
      return { ...base, status: 'erro', motivo: e.mensagemPublica ?? `Não foi possível consultar agora (${e.message}).`,
        link: f.linkConsulta?.(p) };
    }
  }));
}

/** Foto oficial da Câmara (endereço fixo pelo id do deputado), sem depender da API responder. */
function fotoOficial(p) {
  if (!p.nascimento) return null;
  const dep = db.prepare('SELECT id FROM camara_deputados WHERE nome_norm = ? AND nascimento = ?').get(p.nome_norm, p.nascimento);
  return dep ? `https://www.camara.leg.br/internet/deputado/bandep/${dep.id}.jpg` : null;
}

async function montarFicha(id) {
  const p = carregarPessoa(id);
  if (!p) return null;
  const fontes = await consultarFontes(p);
  const financiamento = carregarFinanciamento(db, p.candidaturas);
  return {
    pessoa: {
      id: p.id, nome: p.nome, urnas: p.urnas, cargos: p.cargos, cpf: mascararCpf(p.cpf), nascimento: p.nascimento,
      foto: fotoOficial(p),
      identificacao: p.cpf ? 'CPF (divulgado pelo TSE)' : 'nome completo e data de nascimento',
    },
    candidaturas: p.candidaturas.map((c) => ({
      ano: c.ano, cargo: c.cargo, unidade: c.unidade, uf: c.uf, partido: c.partido, numero: c.numero, urna: c.urna,
      resultado: c.resultado, situacao: c.detalhe_situacao ?? c.situacao, bens: c.bens_total,
    })),
    resumo: montarResumo(p, fontes, { financiamento }),
    financiamento,
    naoCobre: NAO_COBRE,
    bens: fontes.find((f) => f.id === 'tse')?.bens ?? [],
    fontes,
    consultadoEm: new Date().toISOString(),
    apoio: { url: process.env.APOIO_URL || 'https://buymeacoffee.com/masbahh' },
    indiceAtualizadoEm: db.prepare("SELECT valor FROM meta WHERE chave = 'atualizado_em'").get()?.valor,
  };
}

function fichaEmCache(id) {
  const parcial = cacheParcial.get(id);
  if (parcial && Date.now() - parcial.em < VALIDADE_CACHE_PARCIAL) return parcial.dados;
  return lerFicha(`${id}|${FORMATO_FICHA}`, VALIDADE_CACHE);
}

async function perfil(id) {
  const pronta = fichaEmCache(id);
  if (pronta) return pronta;
  if (emAndamento.has(id)) return emAndamento.get(id);

  const promessa = montarFicha(id).then((dados) => {
    if (dados) {
      // Ficha completa vai para o banco (24h). Com alguma fonte fora do ar, guarda só 10 min em memória.
      if (dados.fontes.some((f) => f.status === 'erro')) cacheParcial.set(id, { em: Date.now(), dados });
      else gravarFicha(`${id}|${FORMATO_FICHA}`, dados);
    }
    return dados;
  }).finally(() => emAndamento.delete(id));
  emAndamento.set(id, promessa);
  return promessa;
}

// ---------------------------------------------------------------- limite de uso

const acessos = new Map();
function ipDe(req) {
  // Atrás do Caddy (e opcionalmente do Cloudflare), o IP real vem nos cabeçalhos.
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (!local) return req.socket.remoteAddress;
  return req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
}
function excedeuLimite(chave, limite, janelaMs = 60_000) {
  const agora = Date.now();
  const recentes = (acessos.get(chave) ?? []).filter((t) => agora - t < janelaMs);
  recentes.push(agora);
  acessos.set(chave, recentes);
  return recentes.length > limite;
}
setInterval(() => {
  const agora = Date.now();
  for (const [k, ts] of acessos) if (!ts.some((t) => agora - t < 3_600_000)) acessos.delete(k);
}, 10 * 60_000).unref();

// ---------------------------------------------------------------- páginas (HTML com meta tags)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const capitalizar = (s) => String(s ?? '').toLowerCase().replace(/(^|\s)\S/g, (l) => l.toUpperCase());
let modelo = null;
// Muda a cada reinício (ou seja, a cada atualização): obriga o navegador a baixar CSS/JS novos,
// mesmo que o Cloudflare tenha mandado guardar os antigos por horas.
const VERSAO = Date.now().toString(36);
function modeloHtml() {
  // Relê a cada requisição em desenvolvimento; em produção o arquivo só muda com reinício.
  if (!modelo || process.env.NODE_ENV !== 'production') {
    modelo = fs.readFileSync(path.join(PUBLICO, 'novo.html'), 'utf8').replaceAll('__VERSAO__', VERSAO);
  }
  return modelo;
}

function metaTags({ titulo, descricao, url, indexar = true, extra = '' }) {
  return `<title>${esc(titulo)}</title>
  <meta name="description" content="${esc(descricao)}">
  <link rel="canonical" href="${esc(url)}">
  ${indexar ? '' : '<meta name="robots" content="noindex">'}
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Ficha Pública">
  <meta property="og:title" content="${esc(titulo)}">
  <meta property="og:description" content="${esc(descricao)}">
  <meta property="og:url" content="${esc(url)}">
  <meta property="og:image" content="${SITE}/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="pt_BR">
  <meta name="twitter:card" content="summary_large_image">
  ${extra}`;
}

function paginaInicial() {
  const dadosSite = {
    '@context': 'https://schema.org', '@type': 'WebSite', name: 'Ficha Pública', alternateName: 'Transparência Política',
    url: `${SITE}/`, potentialAction: { '@type': 'SearchAction', target: `${SITE}/?q={busca}`, 'query-input': 'required name=busca' },
  };
  return modeloHtml()
    .replace('<!--META-->', metaTags({
      titulo: 'Ficha Pública · transparência política: processos, patrimônio e doadores de qualquer político',
      descricao: 'Consulte processos, contas no TCU, condenações por improbidade, empresas, doadores de campanha, patrimônio e votações de qualquer político brasileiro, de vereador a presidente. Só dados oficiais, com link para a fonte, sem anúncios.',
      url: `${SITE}/`,
      extra: `<script type="application/ld+json">${JSON.stringify(dadosSite)}</script>`,
    }))
    .replace('<!--CONTEUDO-->', paginas.inicio());
}

function paginaGerada(p) {
  if (!p) return null;
  return modeloHtml()
    .replace('<!--META-->', metaTags({ titulo: p.titulo, descricao: p.descricao, url: p.url, extra: p.extra }))
    .replace('<!--CONTEUDO-->', p.conteudo);
}

function enviarHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(html);
}

// ---------------------------------------------------------------- sitemap

function sitemapIndice() {
  const total = db.prepare('SELECT COUNT(*) AS n FROM pessoas').get().n;
  const partes = Math.ceil(total / POR_SITEMAP);
  const itens = `<sitemap><loc>${SITE}/sitemap-locais.xml</loc></sitemap>`
    + Array.from({ length: partes }, (_, i) => `<sitemap><loc>${SITE}/sitemap-${i + 1}.xml</loc></sitemap>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${itens}</sitemapindex>`;
}

function sitemapParte(n) {
  // Eleitos e candidaturas mais recentes primeiro, com prioridade maior.
  const linhas = db.prepare(`SELECT id, eleito, ultimo_ano FROM pessoas ORDER BY eleito DESC, ultimo_ano DESC, pessoa
    LIMIT ? OFFSET ?`).all(POR_SITEMAP, (n - 1) * POR_SITEMAP);
  const urls = linhas.map((l) => `<url><loc>${SITE}/p/${l.id}</loc><priority>${l.eleito ? '0.8' : '0.4'}</priority></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

// ---------------------------------------------------------------- reportes de erro

function lerCorpo(req, limite = 10_000) {
  return new Promise((resolve, reject) => {
    let corpo = '';
    req.on('data', (c) => { corpo += c; if (corpo.length > limite) { reject(new Error('corpo grande demais')); req.destroy(); } });
    req.on('end', () => resolve(corpo));
    req.on('error', reject);
  });
}

async function receberReporte(req, res) {
  const ip = ipDe(req);
  if (excedeuLimite(`reporte:${ip}`, 5, 3_600_000)) return json(res, 429, { erro: 'Muitos reportes em pouco tempo. Tente mais tarde.' });
  let d;
  try { d = JSON.parse(await lerCorpo(req)); } catch { return json(res, 400, { erro: 'Envio inválido.' }); }
  const ficha = String(d.ficha ?? '').match(/^\d{4}-\d+$/)?.[0];
  const mensagem = String(d.mensagem ?? '').trim().slice(0, 3000);
  if (!ficha || mensagem.length < 10) return json(res, 400, { erro: 'Descreva o problema (pelo menos 10 caracteres).' });
  registrarReporte({
    ficha,
    nome: String(d.nome ?? '').slice(0, 200),
    secao: String(d.secao ?? '').slice(0, 200),
    mensagem,
    contato: String(d.contato ?? '').trim().slice(0, 200) || null,
    // Guarda só um resumo irreversível do IP (para identificar abuso), não o IP em si.
    ipHash: crypto.createHash('sha256').update(`${ip}|ficha-publica`).digest('hex').slice(0, 16),
  });
  return json(res, 200, { ok: true });
}

// ---------------------------------------------------------------- HTTP

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

function json(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(corpo));
}

function arquivoEstatico(res, nome) {
  const arquivo = path.join(PUBLICO, path.normalize(nome));
  if (!arquivo.startsWith(PUBLICO) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) return false;
  const ext = path.extname(arquivo);
  res.writeHead(200, {
    'Content-Type': TIPOS[ext] ?? 'application/octet-stream',
    // CSS/JS mudam a cada atualização: o navegador revalida; imagens podem ficar mais tempo.
    'Cache-Control': ext === '.png' ? 'public, max-age=86400' : 'public, max-age=0, must-revalidate',
    'CDN-Cache-Control': 'max-age=300',
  });
  fs.createReadStream(arquivo).pipe(res);
  return true;
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const caminho = url.pathname;
  try {
    // API
    if (caminho === '/api/buscar') {
      const q = url.searchParams.get('q') ?? '';
      return json(res, 200, { resultados: buscar(q).map(resumirPessoa) });
    }
    const m = caminho.match(/^\/api\/politico\/(\d{4}-\d+)$/);
    if (m) {
      if (!fichaEmCache(m[1]) && !emAndamento.has(m[1]) && excedeuLimite(ipDe(req), LIMITE_POR_MINUTO)) {
        return json(res, 429, { erro: 'Muitas consultas em pouco tempo. Aguarde um minuto e tente de novo.' });
      }
      const dados = await perfil(m[1]);
      return dados ? json(res, 200, dados) : json(res, 404, { erro: 'Político não encontrado' });
    }
    if (caminho === '/api/reportar' && req.method === 'POST') return receberReporte(req, res);

    // Páginas
    if (caminho === '/' || caminho === '/index.html') return enviarHtml(res, 200, paginaInicial());
    const p = caminho.match(/^\/p\/(\d{4}-\d+)\/?$/);
    if (p) {
      const html = paginaGerada(paginas.ficha(p[1]));
      return html ? enviarHtml(res, 200, html) : enviarHtml(res, 404, paginaInicial().replace('<meta property="og:type"', '<meta name="robots" content="noindex"><meta property="og:type"'));
    }
    // Endereços do protótipo redirecionam para os definitivos
    const antigo = caminho.match(/^\/novo(\/p\/\d{4}-\d+)?\/?$/);
    if (antigo) {
      res.writeHead(301, { Location: (antigo[1] ?? '/') + url.search });
      return res.end();
    }
    const est = caminho.match(/^\/uf\/([A-Za-z]{2})\/?$/);
    if (est) {
      const html = paginaGerada(paginas.estado(est[1].toUpperCase()));
      return html ? enviarHtml(res, 200, html) : enviarHtml(res, 404, paginaInicial());
    }
    const cid = caminho.match(/^\/uf\/([A-Za-z]{2})\/([a-z0-9-]+)\/?$/);
    if (cid) {
      const html = paginaGerada(paginas.cidade(cid[1].toUpperCase(), cid[2]));
      return html ? enviarHtml(res, 200, html) : enviarHtml(res, 404, paginaInicial());
    }
    if (caminho === '/sitemap-locais.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
        paginas.urlsLocais().map((u) => `<url><loc>${u}</loc><priority>0.7</priority></url>`).join('')}</urlset>`);
    }
    if (caminho === '/sobre' || caminho === '/sobre/') return arquivoEstatico(res, 'sobre.html') || enviarHtml(res, 404, 'Não encontrado');

    // Buscadores
    if (caminho === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${SITE}/sitemap.xml\n`);
    }
    if (caminho === '/sitemap.xml') {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(sitemapIndice());
    }
    const sm = caminho.match(/^\/sitemap-(\d+)\.xml$/);
    if (sm) {
      res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
      return res.end(sitemapParte(Number(sm[1])));
    }

    // Arquivos estáticos
    if (arquivoEstatico(res, caminho)) return;
    enviarHtml(res, 404, paginaInicial());
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { erro: 'Erro interno' });
  }
});

servidor.listen(PORTA, HOST, () => console.log(`Pronto em http://${HOST ?? 'localhost'}:${PORTA}`));
