export interface CloudInitInput {
  domain: string;
  acmeEmail?: string;
  messageServerImage?: string;
}

export function renderCloudInitUserData(input: CloudInitInput): string {
  const envFile = [
    `DOMAIN=${input.domain}`,
    `ACME_EMAIL=${input.acmeEmail ?? ""}`,
    `MESSAGE_SERVER_IMAGE=${input.messageServerImage ?? "direxio/message-server:latest"}`
  ].join("\n");
  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - ca-certificates
  - curl
  - gnupg
write_files:
  - path: /var/direxio-message-server/.env
    permissions: "0600"
    content: |
${yamlBlock(envFile)}
  - path: /var/direxio-message-server/docker-compose.yml
    permissions: "0644"
    content: |
${yamlBlock(dockerComposeYml)}
  - path: /var/direxio-message-server/Caddyfile
    permissions: "0644"
    content: |
${yamlBlock(caddyfile)}
  - path: /var/direxio-message-server/init-tokens.sh
    permissions: "0755"
    content: |
${yamlBlock(initTokensSh)}
runcmd:
  - |
    set -eu
    TOK=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 300" || true)
    IP=""
    if [ -n "$TOK" ]; then
      IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOK" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
    fi
    [ -n "$IP" ] || IP=$(curl -s https://api.ipify.org || curl -s https://ifconfig.me)
    grep -q '^PUBLIC_IP=' /var/direxio-message-server/.env || echo "PUBLIC_IP=$IP" >> /var/direxio-message-server/.env
    grep -q '^TURN_SECRET=' /var/direxio-message-server/.env || echo "TURN_SECRET=$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)" >> /var/direxio-message-server/.env
    grep -q '^P2P_PORTAL_PASSWORD=' /var/direxio-message-server/.env || echo "P2P_PORTAL_PASSWORD=$(od -An -N4 -tu4 /dev/urandom | awk '{printf "%08d", $1 % 100000000}')" >> /var/direxio-message-server/.env
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable --now docker
  - mkdir -p /var/direxio-message-server/p2p
  - chmod 700 /var/direxio-message-server
  - cd /var/direxio-message-server && docker compose --env-file .env up -d
  - cd /var/direxio-message-server && DOMAIN=$(grep '^DOMAIN=' .env | cut -d= -f2-) bash init-tokens.sh
`;
}

function yamlBlock(value: string): string {
  return value.trimEnd().split(/\r?\n/).map((line) => `      ${line}`).join("\n");
}

const dockerComposeYml = `networks:
  direxio-net:

volumes:
  postgres-data:
  message-config:
  message-data:
  caddy-data:
  caddy-config:

services:
  postgres:
    image: postgres:18-alpine
    networks: [direxio-net]
    environment:
      POSTGRES_USER: direxio_message_server
      POSTGRES_PASSWORD: direxio_message_server
      POSTGRES_DB: direxio_message_server
    volumes:
      - postgres-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U direxio_message_server -d direxio_message_server"]
      interval: 5s
      timeout: 3s
      retries: 30
    restart: unless-stopped

  message-init:
    image: \${MESSAGE_SERVER_IMAGE}
    networks: [direxio-net]
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      TURN_SECRET: \${TURN_SECRET}
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -eu
        mkdir -p /etc/direxio-message-server /var/direxio-message-server /var/direxio-message-server/p2p
        if [ ! -f /etc/direxio-message-server/matrix_key.pem ]; then
          /usr/bin/generate-keys -private-key /etc/direxio-message-server/matrix_key.pem
        fi
        CFG=/etc/direxio-message-server/message-server.yaml
        DB="postgres://direxio_message_server:direxio_message_server@postgres/direxio_message_server?sslmode=disable"
        /usr/bin/generate-config -dir /var/direxio-message-server -db "$$DB" -server "\${DOMAIN}" > "$$CFG"
        printf '\\nclient_api:\\n  turn:\\n    turn_shared_secret: "%s"\\n    turn_user_lifetime: "24h"\\n    turn_uris:\\n      - "turn:%s:3478?transport=udp"\\n      - "turn:%s:3478?transport=tcp"\\n' "$$TURN_SECRET" "\${DOMAIN}" "\${DOMAIN}" >> "$$CFG"
    volumes:
      - message-config:/etc/direxio-message-server
      - message-data:/var/direxio-message-server
    restart: "no"

  message-server:
    image: \${MESSAGE_SERVER_IMAGE}
    networks: [direxio-net]
    depends_on:
      postgres:
        condition: service_healthy
      message-init:
        condition: service_completed_successfully
    environment:
      P2P_PORTAL_CREDENTIALS_FILE: /var/direxio-message-server/p2p/bootstrap.json
      P2P_PORTAL_PASSWORD: \${P2P_PORTAL_PASSWORD}
    command:
      - --config
      - /etc/direxio-message-server/message-server.yaml
      - --http-bind-address
      - :8008
    volumes:
      - message-config:/etc/direxio-message-server
      - message-data:/var/direxio-message-server
      - /var/direxio-message-server/p2p:/var/direxio-message-server/p2p
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://127.0.0.1:8008/_p2p/health >/dev/null"]
      interval: 10s
      timeout: 5s
      retries: 30
      start_period: 15s
    restart: unless-stopped

  caddy:
    image: caddy:2
    networks: [direxio-net]
    depends_on:
      message-server:
        condition: service_healthy
    ports:
      - "80:80"
      - "443:443"
    environment:
      - DOMAIN=\${DOMAIN}
      - ACME_EMAIL=\${ACME_EMAIL}
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    restart: unless-stopped

  coturn:
    image: coturn/coturn:latest
    network_mode: host
    restart: unless-stopped
    command:
      - -n
      - --realm=\${DOMAIN}
      - --listening-port=3478
      - --min-port=49160
      - --max-port=49200
      - --external-ip=\${PUBLIC_IP}
      - --use-auth-secret
      - --static-auth-secret=\${TURN_SECRET}
      - --no-cli
      - --no-tls
      - --no-dtls
      - --no-multicast-peers
      - --denied-peer-ip=10.0.0.0-10.255.255.255
      - --denied-peer-ip=172.16.0.0-172.31.255.255
      - --denied-peer-ip=192.168.0.0-192.168.255.255`;

const caddyfile = `{$DOMAIN} {
  handle /.well-known/matrix/server {
    header Content-Type application/json
    respond "{\\"m.server\\":\\"{$DOMAIN}:443\\"}" 200
  }
  handle /.well-known/matrix/client {
    header Content-Type application/json
    header Access-Control-Allow-Origin *
    respond "{\\"m.homeserver\\":{\\"base_url\\":\\"https://{$DOMAIN}\\"}}" 200
  }
  handle /.well-known/portal/* {
    reverse_proxy message-server:8008
  }
  handle /healthz {
    rewrite * /_p2p/health
    reverse_proxy message-server:8008
  }
  handle /_matrix/* {
    reverse_proxy message-server:8008
  }
  handle /_dendrite/* {
    reverse_proxy message-server:8008
  }
  handle /_synapse/* {
    reverse_proxy message-server:8008
  }
  handle /_p2p/* {
    reverse_proxy message-server:8008
  }
  handle {
    reverse_proxy message-server:8008
  }
}`;

const initTokensSh = `#!/usr/bin/env bash
set -euo pipefail

DIREXIO_DIR=/var/direxio-message-server
COMPOSE="docker compose -f $DIREXIO_DIR/docker-compose.yml --env-file $DIREXIO_DIR/.env"
DOMAIN=${"$"}{DOMAIN:?DOMAIN is required}
BOOTSTRAP_FILE=/var/direxio-message-server/p2p/bootstrap.json

log() { echo "[init-tokens] $*" >&2; }

json_get() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    value = json.load(fh).get(sys.argv[2], "")
print(value if isinstance(value, str) else "")
PY
}

json_set_agent_room() {
  python3 - "$BOOTSTRAP_FILE" "$1" "$DOMAIN" <<'PY'
import json
import sys
path, room_id, domain = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)
data["agent_room_id"] = room_id
data.setdefault("domain", domain)
with open(path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, separators=(",", ":"))
    fh.write("\\n")
PY
  chmod 0600 "$BOOTSTRAP_FILE"
}

room_path() {
  python3 - "$1" <<'PY'
import sys
from urllib.parse import quote
print(quote(sys.argv[1], safe=""))
PY
}

env_value() {
  grep -E "^$1=" "$DIREXIO_DIR/.env" | tail -1 | cut -d= -f2- || true
}

container_post_json() {
  path=$1
  body=$2
  token=""
  if [ "$#" -ge 3 ]; then
    token=$3
  fi
  if [ -n "$token" ]; then
    $COMPOSE exec -T message-server wget -q -O - --header='Content-Type: application/json' --header="Authorization: Bearer $token" --post-data="$body" "http://127.0.0.1:8008$path"
  else
    $COMPOSE exec -T message-server wget -q -O - --header='Content-Type: application/json' --post-data="$body" "http://127.0.0.1:8008$path"
  fi
}

wait_for_message_server() {
  log "waiting for message-server /_p2p/health ..."
  for _ in $(seq 1 90); do
    if $COMPOSE exec -T message-server wget -q -O - http://127.0.0.1:8008/_p2p/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
  done
  return 1
}

bootstrap_portal() {
  password=$(env_value P2P_PORTAL_PASSWORD)
  [ -n "$password" ] || { log "P2P_PORTAL_PASSWORD missing"; return 1; }
  container_post_json "/_p2p/command" "{\\"action\\":\\"portal.bootstrap\\",\\"params\\":{\\"password\\":\\"$password\\"}}" >/dev/null
}

bootstrap_ready() {
  [ -s "$BOOTSTRAP_FILE" ] || return 1
  password=$(json_get "$BOOTSTRAP_FILE" password)
  agent_token=$(json_get "$BOOTSTRAP_FILE" agent_token)
  access_token=$(json_get "$BOOTSTRAP_FILE" access_token)
  [ -n "$password" ] && [ -n "$agent_token" ] && [ -n "$access_token" ]
}

real_agent_room_ready() {
  [ -s "$BOOTSTRAP_FILE" ] || return 1
  room=$(json_get "$BOOTSTRAP_FILE" agent_room_id)
  case "$room" in
    !agent:*|"") return 1 ;;
    !*) return 0 ;;
    *) return 1 ;;
  esac
}

wait_for_bootstrap_file() {
  for _ in $(seq 1 90); do
    if bootstrap_ready; then
      chmod 0600 "$BOOTSTRAP_FILE" 2>/dev/null || true
      return 0
    fi
    sleep 5
  done
  return 1
}

ensure_agent_room() {
  if real_agent_room_ready; then
    return 0
  fi
  owner_token=$(json_get "$BOOTSTRAP_FILE" access_token)
  agent_token=$(json_get "$BOOTSTRAP_FILE" agent_token)
  agent_user="@agent:$DOMAIN"
  session=$(mktemp)
  container_post_json "/_p2p/command" '{"action":"agent.matrix_session.create","params":{"device_id":"DIREXIO_DEPLOY_BOOTSTRAP"}}' "$agent_token" > "$session"
  matrix_agent_token=$(json_get "$session" access_token)
  rm -f "$session"
  [ -n "$matrix_agent_token" ] || { log "agent.matrix_session.create returned no access_token"; return 1; }

  room_resp=$(mktemp)
  container_post_json "/_matrix/client/v3/createRoom" "{\\"preset\\":\\"private_chat\\",\\"visibility\\":\\"private\\",\\"name\\":\\"Direxio Agent\\",\\"invite\\":[\\"$agent_user\\"],\\"is_direct\\":false}" "$owner_token" > "$room_resp"
  room_id=$(json_get "$room_resp" room_id)
  rm -f "$room_resp"
  [ -n "$room_id" ] || { log "Matrix createRoom returned no room_id"; return 1; }

  join_resp=$(mktemp)
  encoded_room=$(room_path "$room_id")
  container_post_json "/_matrix/client/v3/rooms/$encoded_room/join" '{}' "$matrix_agent_token" > "$join_resp"
  rm -f "$join_resp"
  json_set_agent_room "$room_id"
}

mkdir -p "$(dirname "$BOOTSTRAP_FILE")"
wait_for_message_server
bootstrap_portal
wait_for_bootstrap_file
ensure_agent_room
real_agent_room_ready
echo "$BOOTSTRAP_FILE"`;
