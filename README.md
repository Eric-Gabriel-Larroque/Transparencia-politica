# Ficha Pública

Busca qualquer pessoa que já se candidatou no Brasil (de vereador(a) a presidente) e junta numa página
o que as bases **oficiais** dizem sobre ela, sempre com link para a fonte. Sem IA: o resumo é feito
por regras fixas (contagens, somas, comparações).

## Fontes

| Fonte | O que traz | Como é consultada | Cruzamento |
|---|---|---|---|
| **TSE – candidaturas** | Candidaturas, resultado, registro indeferido/cassado e motivo, bens declarados (item a item) | Dados abertos, índice local | — (é a base de identidade) |
| **TSE – prestação de contas** | Quanto cada campanha arrecadou, % de dinheiro público, maiores doadores, gastos e fornecedores | Dados abertos, índice local (somado por candidatura) | Número da candidatura |
| **TCU** | Contas julgadas irregulares, implicação eleitoral, inabilitados, inidôneos | API pública das listas, índice local | CPF (ou nome + UF sem CPF) |
| **CNJ – improbidade** | Condenações cíveis por improbidade administrativa e inelegibilidade | Consulta pública ao vivo | CPF + nome completo (homônimo marcado) |
| **CNJ – DJEN** | Processos com publicação no Diário de Justiça desde 2024, em qualquer tribunal | API pública ao vivo (só responde a IPs do Brasil, por IPv4) | Nome completo; separa por estado de origem do processo |
| **Câmara** | Mandatos desde 1983, proposições, cota parlamentar, votações nominais do Plenário desde 2019 (participação, alinhamento com o governo, votos em PECs) | API e arquivos de dados abertos | Nome civil + data de nascimento |
| **Senado** | Mandatos desde 1983, matérias, votações nominais, cota parlamentar (CEAPS) | API e arquivos de dados abertos | Nome civil + data de nascimento |
| **CGU** | CEIS, CNEP, CEAF, pessoas expostas politicamente, emendas; situação federal das empresas | API do Portal da Transparência (**precisa de chave**) | CPF / CNPJ |
| **Receita Federal** | Empresas das quais a pessoa é sócia | Quadro de sócios (dados abertos), índice local | Nome completo + 6 dígitos visíveis do CPF |
| **Querido Diário** | Menções em diários oficiais municipais (só cargos municipais) | API pública ao vivo | Nome completo no município da candidatura |

Fora do alcance (bloqueio anti-robô, sem API ou pago): STF, certidões criminais do DivulgaCandContas, tribunais de contas
estaduais, APIs jurídicas comerciais.

## Como rodar

Requisitos: **Node.js 22.13 ou mais novo** e cerca de 15 GB livres em disco (arquivos brutos + índice).

```bash
npm install
npm run indexar   # baixa TSE, TCU, Câmara, Senado e Receita e monta data/indice.db (30–60 min na 1ª vez)
npm start         # http://localhost:3000
```

Para indexar só alguns anos: `ANOS=2022,2024 npm run indexar`.
Rode `npm run indexar` de novo de tempos em tempos para atualizar as listas do TCU.

## Publicar num VPS (Ubuntu 24.04)

No terminal do servidor, como root:

```bash
curl -fsSL https://raw.githubusercontent.com/Eric-Gabriel-Larroque/Transparencia-politica/main/deploy/instalar.sh | bash
```

O script instala Node 22 e Caddy, baixa o código em `/opt/ficha-publica`, pede a chave da CGU, monta o
índice e deixa o site no ar em `http://IP-DO-SERVIDOR`. Depois:

- **Código:** a cada 5 minutos o servidor confere o GitHub; se houver commit novo em `main`, atualiza e reinicia sozinho.
- **Dados:** toda segunda às 04:17 o índice do TSE/TCU é reconstruído (o site continua no ar durante a reconstrução).
- **Domínio com HTTPS:** aponte o DNS (registro A de `@` e `www`) para o IP do servidor e rode de novo:
  `curl -fsSL .../deploy/instalar.sh | DOMINIO=seudominio.com.br bash`

Comandos úteis no servidor:

```bash
journalctl -u ficha-publica -f                  # log do site
journalctl -u ficha-publica-atualizar -n 20     # últimas atualizações automáticas
systemctl restart ficha-publica                 # reiniciar o site
nano /opt/ficha-publica/.env                    # trocar a chave da CGU (depois reinicie)
```

## Chave do Portal da Transparência (CGU)

1. Acesse https://portaldatransparencia.gov.br/api-de-dados/cadastrar-email
2. Informe seu e-mail e entre com sua conta **gov.br**.
3. A chave chega por e-mail.
4. Crie um arquivo `.env` na raiz do projeto (ele já está no `.gitignore`, nunca vai para o Git):

```
CHAVE_PORTAL_TRANSPARENCIA=sua-chave
```

O `npm start` lê esse arquivo automaticamente. Sem a chave, a seção da CGU aparece como "desativada"
e o resto funciona normalmente.

Emendas parlamentares só são buscadas para quem disputou mandato federal. A API da CGU busca pelo nome
parlamentar (sem acento); um autor só é aceito se todas as palavras do nome dele na CGU estiverem no
nome civil completo da pessoa.

## Cuidados

- **Aparecer num cadastro não é condenação criminal.** A página mostra a situação de cada registro como a fonte publica.
- Todo cruzamento é marcado como **por CPF** (exato) ou **por nome** (pode ser homônimo). O resumo só usa
  vermelho para o que foi confirmado pelo CPF.
- O TSE não publica CPF nas eleições de 2024. Quando a mesma pessoa (nome completo + nascimento) aparece em
  outra eleição com CPF, as candidaturas são ligadas; quem só concorreu em 2024 é cruzado pelo nome.
- CPFs são exibidos mascarados (`***.456.789-**`) e não aparecem nas URLs.

## Limitações conhecidas

- O CNJ não tem API: a consulta repete a chamada que a própria página do CNJ faz. Se o site mudar, ela quebra.
- O filtro por ano da API de despesas da Câmara devolve vazio (nov/2026); por isso a cota é somada por legislatura.
- Ainda não incluídos: STF (inquéritos/ações penais, sem API), assembleias legislativas e câmaras municipais
  (cada uma tem um sistema diferente), tribunais de contas estaduais.

## Estrutura

```
scripts/indexar.js     baixa e monta o índice local (TSE + TCU)
src/server.js          servidor HTTP (busca, perfil, arquivos estáticos)
src/resumo.js          resumo por regras fixas
src/fontes/*.js        um módulo por fonte, todos com a mesma interface
public/                página (HTML/CSS/JS puro)
```

Para adicionar uma fonte, crie um módulo em `src/fontes/` exportando
`{ id, nome, orgao, descricao, aplicavel(p), consultar(p) }` e inclua na lista `FONTES` em `src/server.js`.
