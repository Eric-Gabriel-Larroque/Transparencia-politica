// Leitura em streaming de CSVs (separados por ";", Latin-1) de dentro de arquivos ZIP.
// Os arquivos do TSE passam de 500 MB descompactados, então nada é carregado inteiro na memória.

import yauzl from 'yauzl';
import readline from 'node:readline';
import fs from 'node:fs';

function abrirZip(caminho) {
  return new Promise((resolve, reject) => {
    yauzl.open(caminho, { lazyEntries: true, autoClose: false }, (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function listarEntradas(zip) {
  return new Promise((resolve, reject) => {
    const entradas = [];
    zip.on('entry', (e) => { entradas.push(e); zip.readEntry(); });
    zip.on('end', () => resolve(entradas));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function abrirEntrada(zip, entrada) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entrada, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

/** Divide uma linha de CSV respeitando aspas ("" dentro de aspas vira "). */
export function dividirLinha(linha, sep = ';') {
  const campos = [];
  const n = linha.length;
  let i = 0;
  while (i <= n) {
    if (linha[i] === '"') {
      let j = i + 1;
      let valor = '';
      for (;;) {
        const k = linha.indexOf('"', j);
        if (k < 0) { valor += linha.slice(j); i = n + 1; break; }
        if (linha[k + 1] === '"') { valor += linha.slice(j, k + 1); j = k + 2; continue; }
        // Aspas que não fecham o campo (não vêm antes do separador nem no fim) são texto: ex. "Raul"s Ltda".
        if (k + 1 < n && linha[k + 1] !== sep) { valor += linha.slice(j, k + 1); j = k + 1; continue; }
        valor += linha.slice(j, k);
        i = k + 1;
        break;
      }
      campos.push(valor);
      if (linha[i] === sep) i++;
      else i = n + 1;
    } else {
      const k = linha.indexOf(sep, i);
      if (k < 0) { campos.push(linha.slice(i)); break; }
      campos.push(linha.slice(i, k));
      i = k + 1;
    }
  }
  return campos;
}

/**
 * Junta linhas quebradas dentro de aspas, mas no máximo MAX_JUNCAO linhas: um arquivo com uma aspa
 * solta não pode "engolir" o resto do arquivo.
 */
const MAX_JUNCAO = 50;
function* juntarLinhas(estado, bruta) {
  estado.buffer.push(bruta);
  const linha = estado.buffer.join('\n');
  if (contarAspas(linha) % 2 === 0) { estado.buffer = []; yield linha; return; }
  if (estado.buffer.length >= MAX_JUNCAO) {
    const [primeira, ...resto] = estado.buffer;
    estado.buffer = [];
    yield primeira; // processa a linha problemática sozinha (leitura tolerante)
    for (const r of resto) yield* juntarLinhas(estado, r);
  }
}

function contarAspas(s) {
  let c = 0;
  for (let i = s.indexOf('"'); i >= 0; i = s.indexOf('"', i + 1)) c++;
  return c;
}

/**
 * Itera as linhas (como objetos {COLUNA: valor}) dos CSVs de um ZIP.
 * Se existir um arquivo *_BRASIL.csv, lê só ele (ele já junta todas as UFs);
 * caso contrário lê todos os .csv.
 */
export async function* linhasDoZip(caminho, { arquivo, colunas, utf8 = false } = {}) {
  const zip = await abrirZip(caminho);
  try {
    const csvs = (await listarEntradas(zip)).filter((e) => (arquivo ? arquivo.test(e.fileName) : /\.csv$/i.test(e.fileName)));
    const brasil = csvs.filter((e) => /_BRASIL\.csv$/i.test(e.fileName));
    const alvo = brasil.length ? brasil : csvs;

    for (const entrada of alvo) {
      const stream = await abrirEntrada(zip, entrada);
      stream.setEncoding(utf8 ? 'utf8' : 'latin1');
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let cabecalho = colunas ?? null; // arquivos sem cabeçalho (ex.: Receita) recebem os nomes das colunas
      const estado = { buffer: [] };
      for await (const bruta of rl) {
        // Campo com quebra de linha dentro de aspas: junta até fechar as aspas (com limite).
        for (const linha of juntarLinhas(estado, bruta)) {
          if (!linha) continue;
          const campos = dividirLinha(cabecalho ? linha : linha.replace(/^\uFEFF/, ''));
          if (!cabecalho) { cabecalho = campos; continue; }
      if (campos.length < cabecalho.length / 2) continue; // fragmento de linha malformada
          if (campos.length < cabecalho.length / 2) continue; // fragmento de linha malformada
          const obj = {};
          for (let c = 0; c < cabecalho.length; c++) obj[cabecalho[c]] = campos[c];
          yield obj;
        }
      }
    }
  } finally {
    zip.close();
  }
}

/** Itera as linhas (como objetos) de um CSV comum (UTF-8, separado por ";"), em streaming. */
export async function* linhasDoCsv(caminho, { encoding = 'utf8', pular = 0 } = {}) {
  const rl = readline.createInterface({ input: fs.createReadStream(caminho, { encoding }), crlfDelay: Infinity });
  let cabecalho = null;
  const estado = { buffer: [] };
  for await (const bruta of rl) {
    for (const linha of juntarLinhas(estado, bruta)) {
      if (!linha) continue;
      if (pular > 0) { pular--; continue; }
      const campos = dividirLinha(cabecalho ? linha : linha.replace(/^\uFEFF/, ''));
      if (!cabecalho) { cabecalho = campos; continue; }
      if (campos.length < cabecalho.length / 2) continue; // fragmento de linha malformada
      const obj = {};
      for (let c = 0; c < cabecalho.length; c++) obj[cabecalho[c]] = campos[c];
      yield obj;
    }
  }
}
