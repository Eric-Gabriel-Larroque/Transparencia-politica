// Leitura em streaming de CSVs (separados por ";", Latin-1) de dentro de arquivos ZIP.
// Os arquivos do TSE passam de 500 MB descompactados, então nada é carregado inteiro na memória.

import yauzl from 'yauzl';
import readline from 'node:readline';

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
export async function* linhasDoZip(caminho) {
  const zip = await abrirZip(caminho);
  try {
    const csvs = (await listarEntradas(zip)).filter((e) => /\.csv$/i.test(e.fileName));
    const brasil = csvs.filter((e) => /_BRASIL\.csv$/i.test(e.fileName));
    const alvo = brasil.length ? brasil : csvs;

    for (const entrada of alvo) {
      const stream = await abrirEntrada(zip, entrada);
      stream.setEncoding('latin1');
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      let cabecalho = null;
      let pendente = '';
      for await (const bruta of rl) {
        // Campo com quebra de linha dentro de aspas: junta até fechar as aspas.
        const linha = pendente ? `${pendente}\n${bruta}` : bruta;
        if (contarAspas(linha) % 2 === 1) { pendente = linha; continue; }
        pendente = '';
        if (!linha) continue;
        const campos = dividirLinha(linha);
        if (!cabecalho) { cabecalho = campos; continue; }
        const obj = {};
        for (let c = 0; c < cabecalho.length; c++) obj[cabecalho[c]] = campos[c];
        yield obj;
      }
    }
  } finally {
    zip.close();
  }
}
