// Fila com limite de requisições por minuto (janela deslizante), para APIs com cota, como a da CGU.
// Se a espera na fila passar de `maxEsperaMs`, falha logo com uma mensagem clara em vez de travar a ficha.

export function criarLimitador({ porMinuto, maxEsperaMs = 25_000, mensagem = 'Muita procura agora.' }) {
  const marcas = []; // horários das requisições liberadas no último minuto
  const fila = [];
  let timer = null;

  function liberar() {
    timer = null;
    const agora = Date.now();
    while (marcas.length && agora - marcas[0] >= 60_000) marcas.shift();
    while (fila.length && marcas.length < porMinuto) {
      const item = fila.shift();
      if (agora - item.entrou > maxEsperaMs) { item.rejeitar(); continue; }
      marcas.push(agora);
      item.resolver();
    }
    // Descarta quem já esperou demais, mesmo sem vaga.
    for (let i = fila.length - 1; i >= 0; i--) {
      if (agora - fila[i].entrou > maxEsperaMs) fila.splice(i, 1)[0].rejeitar();
    }
    // Acorda na próxima vaga OU quando o primeiro da fila estourar o tempo de espera, o que vier antes.
    if (fila.length && !timer) {
      const proximaVaga = marcas.length ? 60_000 - (agora - marcas[0]) : 0;
      const proximoEstouro = maxEsperaMs - (agora - fila[0].entrou) + 1;
      timer = setTimeout(liberar, Math.max(50, Math.min(proximaVaga, proximoEstouro)));
      timer.unref?.();
    }
  }

  /** Executa `fn` quando houver vaga no limite. */
  return async function agendar(fn) {
    await new Promise((resolver, rejeitar) => {
      fila.push({
        entrou: Date.now(),
        resolver,
        rejeitar: () => {
          const e = new Error('fila do limitador excedida');
          e.mensagemPublica = mensagem;
          rejeitar(e);
        },
      });
      liberar();
    });
    return fn();
  };
}

// Limite compartilhado da API do Portal da Transparência (CGU): ~90/min por chave; deixamos folga.
export const filaCgu = criarLimitador({
  porMinuto: Number(process.env.CGU_POR_MINUTO) || 80,
  maxEsperaMs: 25_000,
  mensagem: 'Muita procura no momento: o limite de consultas ao Portal da Transparência foi atingido. Tente de novo em alguns minutos.',
});
