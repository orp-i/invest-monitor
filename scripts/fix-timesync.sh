#!/usr/bin/env bash

set -Eeuo pipefail

readonly WIRED_INTERFACE="enp3s0"
readonly ONLINE_INTERFACE="wlo1"
readonly NETPLAN_OVERLAY="/etc/netplan/99-timesync-online.yaml"
readonly TIMESYNCD_DROP_IN_DIR="/etc/systemd/timesyncd.conf.d"
readonly TIMESYNCD_DROP_IN="${TIMESYNCD_DROP_IN_DIR}/10-fix.conf"
readonly MAX_WAIT_SECONDS=90
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPOSITORY_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

log() {
  printf '[timesync-fix] %s\n' "$*"
}

fail() {
  printf '[timesync-fix] ERROR: %s\n' "$*" >&2
  exit 1
}

for command_name in sudo tee chmod find netplan systemctl networkctl timedatectl sed; do
  command -v "$command_name" >/dev/null 2>&1 \
    || fail "required command not found: ${command_name}"
done

[[ -d "/sys/class/net/${WIRED_INTERFACE}" ]] \
  || fail "network interface not found: ${WIRED_INTERFACE}"
[[ -d "/sys/class/net/${ONLINE_INTERFACE}" ]] \
  || fail "network interface not found: ${ONLINE_INTERFACE}"

log "Requesting sudo access"
sudo -v

log "Writing systemd-timesyncd configuration"
sudo mkdir -p "$TIMESYNCD_DROP_IN_DIR"
sudo tee "$TIMESYNCD_DROP_IN" >/dev/null <<'EOF'
[Time]
NTP=time.cloudflare.com pool.ntp.org
RootDistanceMaxSec=30
EOF

log "Writing Netplan online-state overlay"
sudo tee "$NETPLAN_OVERLAY" >/dev/null <<EOF
network:
  version: 2
  ethernets:
    ${WIRED_INTERFACE}:
      optional: true
  wifis:
    ${ONLINE_INTERFACE}:
      optional: false
EOF
sudo chmod 600 "$NETPLAN_OVERLAY"

log "Restricting Netplan YAML files to owner-only access"
sudo find /etc/netplan -maxdepth 1 -type f -name '*.yaml' -exec chmod 600 {} +

log "Validating Netplan configuration"
sudo netplan generate

log "Applying Netplan configuration; network connectivity may briefly reconnect"
sudo netplan apply

log "Restarting systemd-timesyncd"
sudo systemctl restart systemd-timesyncd

log "Waiting up to ${MAX_WAIT_SECONDS}s for NTP synchronization"
for ((elapsed = 0; elapsed < MAX_WAIT_SECONDS; elapsed += 3)); do
  if [[ "$(timedatectl show -p NTPSynchronized --value)" == "yes" ]]; then
    log "Clock synchronized after approximately ${elapsed}s"
    networkctl status --no-pager | sed -n '1,5p'
    timedatectl
    timedatectl timesync-status
    if command -v docker >/dev/null 2>&1 && [[ -f "${REPOSITORY_ROOT}/docker-compose.yml" ]]; then
      log "Restarting the invest API to clear pre-sync clock-skew samples"
      if ! docker compose --project-directory "$REPOSITORY_ROOT" restart api; then
        log "WARNING: NTP is fixed, but the invest API could not be restarted automatically"
      fi
    fi
    exit 0
  fi
  sleep 3
done

printf '\n[timesync-fix] Synchronization did not complete within %ss.\n' "$MAX_WAIT_SECONDS" >&2
printf '[timesync-fix] Current network state:\n' >&2
networkctl status --no-pager 2>&1 | sed -n '1,8p' >&2 || true
printf '[timesync-fix] Current timesync state:\n' >&2
timedatectl timesync-status --all >&2 || true
printf '[timesync-fix] Recent systemd-timesyncd log:\n' >&2
sudo journalctl -u systemd-timesyncd --since '-3 minutes' --no-pager >&2 || true
exit 1
