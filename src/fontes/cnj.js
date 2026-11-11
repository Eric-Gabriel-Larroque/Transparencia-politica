// CNJ – Cadastro Nacional de Condenações Cíveis por Ato de Improbidade Administrativa e Inelegibilidade.
// Não há API oficial: a página pública faz uma chamada AJAX (Sajax) que devolve uma tabela HTML.
// Aqui fazemos a mesma chamada que o navegador faz e lemos a tabela.

import { http, normalizar } from '../lib/util.js';

const BASE = 'https://www.cnj.jus.br/improbidade_adm';
const POR_PAGINA = 15;
const MAX_PAGINAS = 4;

async function pesquisar({ cpf = '', nome = '' }, inicio = 0) {
  const corpo = new URLSearchParams();
  corpo.append('rs', 'pesquisarRequeridoGetTabela');
  corpo.append('rst', '');
  corpo.append('rsrnd', String(Date.now()));
  // Ordem dos argumentos: esfera, tribunal, órgão, cpf, nome, tipo pessoa, txtImagem, nº registros, início, quantidade
  for (const arg of ['', '', '', cpf, nome.toUpperCase(), 'F', '', '0',
    `POSICAO_INICIAL_PAGINACAO_PHP${inicio}`, `QUANTIDADE_REGISTROS_PAGINACAO${POR_PAGINA}`]) {
    corpo.append('rsargs[]', arg);
  }
  const res = await http(`${BASE}/consultar_requerido.php`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: corpo,
  });
  const texto = new TextDecoder('latin1').decode(await res.arrayBuffer()).replace(/\\(['"])/g, '$1');

  const linhas = [];
  const reLinha = /seq_condenacao=(\d+)'[^>]*>([^<]+)<\/a>[\s\S]*?seq_processo=(\d+)'[^>]*>([^<]+)<\/a>/g;
  for (const m of texto.matchAll(reLinha)) {
    linhas.push({ condenacao: m[1], nome: m[2].trim(), processoId: m[3], processo: m[4].trim() });
  }
  const total = Number(texto.match(/N[úu]mero de registros:\s*(\d+)/)?.[1] ?? linhas.length);
  return { linhas, total };
}

async function pesquisarTudo(filtro) {
  const primeira = await pesquisar(filtro, 0);
  const linhas = [...primeira.linhas];
  for (let p = 1; p < MAX_PAGINAS && linhas.length < primeira.total; p++) {
    const prox = await pesquisar(filtro, p * POR_PAGINA);
    if (!prox.linhas.length) break;
    linhas.push(...prox.linhas);
  }
  return { linhas, total: primeira.total };
}

export const cnj = {
  id: 'cnj',
  nome: 'Condenações por improbidade administrativa',
  orgao: 'CNJ – Conselho Nacional de Justiça',
  descricao: 'Condenações cíveis por ato de improbidade e condenações que geram inelegibilidade, registradas pelos tribunais de todo o país.',
  aplicavel: () => true,
  async consultar(p) {
    const porCpf = p.cpf ? await pesquisarTudo({ cpf: p.cpf }) : { linhas: [], total: 0 };
    // Nem toda condenação tem CPF cadastrado: também busca pelo nome completo,
    // mas só aceita nomes idênticos (sem acento/caixa) e marca como possível homônimo.
    // O servidor do CNJ lê o formulário em Latin-1; sem acentos evita nomes corrompidos (a busca ignora acentos).
    const porNome = await pesquisarTudo({ nome: p.nome_norm });
    const vistos = new Set(porCpf.linhas.map((l) => l.condenacao));
    const soNome = porNome.linhas.filter((l) => !vistos.has(l.condenacao) && normalizar(l.nome) === p.nome_norm);

    const registro = (l, correspondencia) => ({
      titulo: `Condenação por improbidade – processo ${l.processo}`,
      situacao: 'Condenação registrada no cadastro (ver detalhes no CNJ)',
      detalhe: `Nome no cadastro: ${l.nome}`,
      correspondencia,
      link: `${BASE}/visualizar_condenacao.php?seq_condenacao=${l.condenacao}`,
    });

    const registros = [
      ...porCpf.linhas.map((l) => registro(l, 'cpf')),
      ...soNome.map((l) => registro(l, 'nome')),
    ];
    return {
      correspondencia: p.cpf ? 'cpf' : 'nome',
      link: `${BASE}/consultar_requerido.php`,
      alerta: registros.length > 0,
      aviso: soNome.length
        ? `${soNome.length} registro(s) encontrado(s) só pelo nome completo, sem CPF no cadastro do CNJ. Pode ser homônimo: confira os detalhes.`
        : null,
      registros,
    };
  },
};
