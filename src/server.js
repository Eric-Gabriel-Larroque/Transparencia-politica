// Servidor HTTP: serve a página e a API de busca/perfil.
// Sem dependências externas: node:http + node:sqlite.

import http from 'node:http';
import dns from 'node:dns';

// Prefere IPv4 nas conexões de saída. O IPv6 da Hostinger é registrado na Europa e serviços
// brasileiros com bloqueio por país (ex.: DJEN do CNJ) recusam esse endereço; o IPv4 é do Brasil.
dns.setDefaultResultOrder('ipv4first');
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirBanco } from './lib/db.js';
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

const FONTES = [tse, tcu, cnj, djen, cgu, empresas, camara, senado, diarios];
const PORTA = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // em produção: 127.0.0.1 (atrás do Caddy)
const LIMITE_POR_MINUTO = Number(process.env.LIMITE_POR_MINUTO) || 20;
const PUBLICO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const CACHE_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_FONTE = 45_000;

const db = abrirBanco();
const cache = new Map();

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

async function perfil(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.em < CACHE_MS) return hit.dados;

  const p = carregarPessoa(id);
  if (!p) return null;
  const fontes = await consultarFontes(p);
  const financiamento = carregarFinanciamento(db, p.candidaturas);
  const dados = {
    pessoa: {
      id: p.id, nome: p.nome, urnas: p.urnas, cargos: p.cargos, cpf: mascararCpf(p.cpf), nascimento: p.nascimento,
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
  // Só guarda no cache se nenhuma fonte falhou, para tentar de novo na próxima visita.
  if (!fontes.some((f) => f.status === 'erro')) cache.set(id, { em: Date.now(), dados });
  return dados;
}

// ---------------------------------------------------------------- limite de uso
// Cada perfil consulta várias APIs externas (e gasta a chave da CGU): limita por visitante.

const acessos = new Map();
function ipDe(req) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const encaminhado = req.headers['x-forwarded-for']?.split(',')[0].trim();
  return (local && encaminhado) || req.socket.remoteAddress;
}
function excedeuLimite(ip) {
  const agora = Date.now();
  const recentes = (acessos.get(ip) ?? []).filter((t) => agora - t < 60_000);
  recentes.push(agora);
  acessos.set(ip, recentes);
  return recentes.length > LIMITE_POR_MINUTO;
}
setInterval(() => {
  const agora = Date.now();
  for (const [ip, ts] of acessos) if (!ts.some((t) => agora - t < 60_000)) acessos.delete(ip);
}, 5 * 60_000).unref();

// ---------------------------------------------------------------- HTTP

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function json(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(corpo));
}

const servidor = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/buscar') {
      const q = url.searchParams.get('q') ?? '';
      return json(res, 200, { resultados: buscar(q).map(resumirPessoa) });
    }
    const m = url.pathname.match(/^\/api\/politico\/(\d{4}-\d+)$/);
    if (m) {
      if (!cache.has(m[1]) && excedeuLimite(ipDe(req))) {
        return json(res, 429, { erro: 'Muitas consultas em pouco tempo. Aguarde um minuto e tente de novo.' });
      }
      const dados = await perfil(m[1]);
      return dados ? json(res, 200, dados) : json(res, 404, { erro: 'Político não encontrado' });
    }
    // Arquivos estáticos
    const arquivo = path.join(PUBLICO, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
    if (!arquivo.startsWith(PUBLICO) || !fs.existsSync(arquivo) || fs.statSync(arquivo).isDirectory()) {
      res.writeHead(404); return res.end('Não encontrado');
    }
    res.writeHead(200, { 'Content-Type': TIPOS[path.extname(arquivo)] ?? 'application/octet-stream' });
    fs.createReadStream(arquivo).pipe(res);
  } catch (e) {
    console.error(e);
    json(res, 500, { erro: 'Erro interno' });
  }
});

servidor.listen(PORTA, HOST, () => console.log(`Pronto em http://${HOST ?? 'localhost'}:${PORTA}`));
