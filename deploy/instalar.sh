#!/usr/bin/env bash
# Instala o Ficha Pública num VPS Ubuntu 24.04 limpo. Rode como root:
#
#   curl -fsSL https://raw.githubusercontent.com/Eric-Gabriel-Larroque/Transparencia-politica/main/deploy/instalar.sh | bash
#
# Com domínio (HTTPS automático), depois que o DNS apontar para o IP do servidor:
#
#   curl -fsSL .../deploy/instalar.sh | DOMINIO=seudominio.com.br bash
#
# Pode ser rodado de novo sem problema: ele só refaz o que faltar.

set -euo pipefail

REPO="https://github.com/Eric-Gabriel-Larroque/Transparencia-politica.git"
PASTA="/opt/ficha-publica"
USUARIO="ficha"
DOMINIO="${DOMINIO:-}"

passo() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then echo "Rode como root."; exit 1; fi
export DEBIAN_FRONTEND=noninteractive

passo "Atualizando o sistema e instalando ferramentas"
apt-get update -q
apt-get install -y -q curl git ca-certificates gnupg ufw debian-keyring debian-archive-keyring apt-transport-https

passo "Instalando Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi
node -v

passo "Instalando Caddy (servidor web com HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

passo "Criando usuário e baixando o código"
id "$USUARIO" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$USUARIO"
if [ ! -d "$PASTA/.git" ]; then
  git clone "$REPO" "$PASTA"
fi
chown -R "$USUARIO:$USUARIO" "$PASTA"
git config --system --add safe.directory "$PASTA" || true
cd "$PASTA"
sudo -u "$USUARIO" git pull --ff-only
sudo -u "$USUARIO" npm ci --omit=dev --no-audit --no-fund

passo "Chave do Portal da Transparência (CGU)"
if [ ! -f "$PASTA/.env" ]; then
  if [ -r /dev/tty ]; then
    printf 'Cole a chave da API do Portal da Transparência (ou só Enter para pular): '
    read -r CHAVE < /dev/tty || CHAVE=""
  else
    CHAVE=""
  fi
  umask 077
  printf 'CHAVE_PORTAL_TRANSPARENCIA=%s\n' "$CHAVE" > "$PASTA/.env"
  chown "$USUARIO:$USUARIO" "$PASTA/.env"
  chmod 600 "$PASTA/.env"
else
  echo "Já existe $PASTA/.env, mantendo."
fi

passo "Montando o índice (TSE + TCU): leva alguns minutos"
if [ ! -f "$PASTA/data/indice.db" ]; then
  sudo -u "$USUARIO" npm run indexar
else
  echo "Índice já existe. Para refazer: sudo -u $USUARIO npm --prefix $PASTA run indexar"
fi

passo "Configurando o serviço do site"
cat > /etc/systemd/system/ficha-publica.service <<EOF
[Unit]
Description=Ficha Publica
After=network-online.target
Wants=network-online.target

[Service]
User=$USUARIO
WorkingDirectory=$PASTA
Environment=NODE_ENV=production HOST=127.0.0.1 PORT=3000
ExecStart=/usr/bin/node --no-warnings --env-file-if-exists=.env src/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

passo "Configurando atualização automática (código a cada 5 min, dados toda semana)"
cat > /etc/systemd/system/ficha-publica-atualizar.service <<EOF
[Unit]
Description=Ficha Publica: atualiza o codigo a partir do GitHub

[Service]
Type=oneshot
ExecStart=/bin/bash $PASTA/deploy/atualizar.sh
EOF
cat > /etc/systemd/system/ficha-publica-atualizar.timer <<EOF
[Unit]
Description=Ficha Publica: verifica atualizacoes a cada 5 minutos

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/ficha-publica-indexar.service <<EOF
[Unit]
Description=Ficha Publica: reconstroi o indice (TSE + TCU)

[Service]
Type=oneshot
ExecStart=/bin/bash -c 'rm -rf $PASTA/data/brutos && sudo -u $USUARIO npm --prefix $PASTA run indexar && systemctl restart ficha-publica'
EOF
cat > /etc/systemd/system/ficha-publica-indexar.timer <<EOF
[Unit]
Description=Ficha Publica: reconstroi o indice toda segunda de madrugada

[Timer]
OnCalendar=Mon 04:17
Persistent=true

[Install]
WantedBy=timers.target
EOF

passo "Configurando o Caddy"
if [ -n "$DOMINIO" ]; then
  ENDERECO="$DOMINIO, www.$DOMINIO"
else
  ENDERECO=":80"
fi
cat > /etc/caddy/Caddyfile <<EOF
$ENDERECO {
  encode gzip
  reverse_proxy 127.0.0.1:3000
}
EOF

passo "Liberando o firewall (SSH, HTTP, HTTPS)"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

passo "Iniciando tudo"
systemctl daemon-reload
systemctl enable --now ficha-publica ficha-publica-atualizar.timer ficha-publica-indexar.timer
systemctl reload caddy || systemctl restart caddy
sleep 3

IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
if curl -fsS -o /dev/null http://127.0.0.1:3000/; then
  passo "Pronto!"
  if [ -n "$DOMINIO" ]; then echo "Acesse: https://$DOMINIO"; else echo "Acesse: http://$IP"; fi
else
  echo "O site não respondeu. Veja o log com: journalctl -u ficha-publica -n 50"
  exit 1
fi
