// Lista os reportes de erro enviados pelos visitantes.
//   npm run reportes              -> reportes pendentes
//   npm run reportes -- todos     -> todos
//   npm run reportes -- resolver 3  -> marca o reporte 3 como resolvido
import { listarReportes, marcarResolvido } from '../src/lib/cache.js';

const [acao, id] = process.argv.slice(2);
if (acao === 'resolver' && id) {
  marcarResolvido(id);
  console.log(`Reporte ${id} marcado como resolvido.`);
  process.exit(0);
}
const lista = listarReportes({ todos: acao === 'todos' });
if (!lista.length) console.log('Nenhum reporte pendente.');
for (const r of lista) {
  console.log(`\n#${r.id}  ${r.criado_em.slice(0, 16).replace('T', ' ')}  ${r.resolvido ? '[resolvido]' : '[pendente]'}`);
  console.log(`Ficha: https://transparencia-politica.tech/p/${r.ficha}  (${r.nome ?? ''})`);
  console.log(`Seção: ${r.secao}`);
  console.log(`Mensagem: ${r.mensagem}`);
  if (r.contato) console.log(`Contato: ${r.contato}`);
}
process.exit(0);
