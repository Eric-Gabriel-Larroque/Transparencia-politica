#!/usr/bin/env bash
# Chamado a cada 5 minutos pelo timer ficha-publica-atualizar.
# Se houver commit novo no GitHub, baixa, instala dependências e reinicia o site.

set -euo pipefail
PASTA="/opt/ficha-publica"
USUARIO="ficha"
cd "$PASTA"

sudo -u "$USUARIO" git fetch -q origin main
ATUAL="$(git rev-parse HEAD)"
NOVO="$(git rev-parse origin/main)"
[ "$ATUAL" = "$NOVO" ] && exit 0

echo "Atualizando de ${ATUAL:0:7} para ${NOVO:0:7}"
MUDOU_DEPS="$(git diff --name-only "$ATUAL" "$NOVO" -- package.json package-lock.json)"
MUDOU_INDICE="$(git diff --name-only "$ATUAL" "$NOVO" -- scripts/indexar.js src/lib/db.js)"
sudo -u "$USUARIO" git reset -q --hard origin/main
[ -n "$MUDOU_DEPS" ] && sudo -u "$USUARIO" npm ci --omit=dev --no-audit --no-fund

# Se o formato do índice mudou, reconstrói antes de reiniciar (o site antigo segue no ar enquanto isso).
[ -n "$MUDOU_INDICE" ] && sudo -u "$USUARIO" npm run indexar

# Mantém as definições de serviço em dia com o repositório.
cp "$PASTA"/deploy/systemd/*.service /etc/systemd/system/ 2>/dev/null && systemctl daemon-reload

systemctl restart ficha-publica
echo "Atualizado."
