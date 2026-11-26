#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run this script with sudo: sudo bash infra/setup-ec2.sh"
  exit 1
fi

DEPLOY_USER="${SUDO_USER:-}"
if [ -z "$DEPLOY_USER" ] || [ "$DEPLOY_USER" = "root" ]; then
  if id -u ubuntu >/dev/null 2>&1; then
    DEPLOY_USER="ubuntu"
  elif id -u admin >/dev/null 2>&1; then
    DEPLOY_USER="admin"
  elif id -u ec2-user >/dev/null 2>&1; then
    DEPLOY_USER="ec2-user"
  else
    echo "Could not detect ubuntu, admin, or ec2-user; set SUDO_USER explicitly."
    exit 1
  fi
fi

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg rsync
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y rsync nodejs22
  if ! command -v curl >/dev/null 2>&1; then
    dnf install -y curl
  fi
else
  echo "Unsupported OS package manager (expected apt-get or dnf)."
  exit 1
fi

mkdir -p /opt/omnix/backend
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" /opt/omnix

curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /opt/omnix/rds-global-bundle.pem
chmod 644 /opt/omnix/rds-global-bundle.pem

if [ ! -f /opt/omnix/.env ]; then
  cat >/opt/omnix/.env <<'EOF'
PORT=3000
NODE_ENV=production
DATABASE_URL=postgres://postgres:CHANGE_ME@YOUR_RDS_ENDPOINT:5432/omnix
DB_SSL=true
DB_SSL_CA=/opt/omnix/rds-global-bundle.pem
EOF
  chown "${DEPLOY_USER}:${DEPLOY_USER}" /opt/omnix/.env
  chmod 600 /opt/omnix/.env
fi

NODE_BIN="$(command -v node)"
cat >/etc/systemd/system/omnix-api.service <<EOF
[Unit]
Description=Omnix Backend API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${DEPLOY_USER}
WorkingDirectory=/opt/omnix/backend
EnvironmentFile=/opt/omnix/.env
ExecStart=${NODE_BIN} /opt/omnix/backend/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/sudoers.d/omnix-deploy <<EOF
${DEPLOY_USER} ALL=(root) NOPASSWD: /bin/systemctl restart omnix-api, /usr/bin/systemctl restart omnix-api, /bin/systemctl status omnix-api, /usr/bin/systemctl status omnix-api
EOF
chmod 440 /etc/sudoers.d/omnix-deploy
visudo -cf /etc/sudoers.d/omnix-deploy

systemctl daemon-reload
systemctl enable omnix-api

echo "EC2 bootstrap complete for user '${DEPLOY_USER}'."
echo "Next: edit /opt/omnix/.env with your real RDS DATABASE_URL, then push to main."

