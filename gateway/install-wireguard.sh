#!/usr/bin/env bash
# Install the Campus Cloud WireGuard data plane without replacing existing
# Gateway services, routes, UFW policy, NetBird, FRP, HAProxy, or Traefik.

set -Eeuo pipefail

WG_INTERFACE="${WG_INTERFACE:-wg0}"
WG_ADDRESS="${WG_ADDRESS:-10.250.0.1/16}"
WG_CLIENT_SUBNET="${WG_CLIENT_SUBNET:-10.250.0.0/16}"
WG_VM_SUBNET="${WG_VM_SUBNET:-10.10.0.0/16}"
WG_VM_INTERFACE="${WG_VM_INTERFACE:-eth1}"
WG_SNAT_ADDRESS="${WG_SNAT_ADDRESS:-10.10.0.2}"
WG_INGRESS_INTERFACE="${WG_INGRESS_INTERFACE:-eth0}"
WG_LISTEN_PORT="${WG_LISTEN_PORT:-51821}"
WG_ACL_TIMEOUT="${WG_ACL_TIMEOUT:-8h}"

WG_DIR="/etc/wireguard"
WG_CONFIG="${WG_DIR}/${WG_INTERFACE}.conf"
NFT_DIR="/etc/nftables.d"
NFT_CONFIG="${NFT_DIR}/campus-cloud-wg.nft"
FIREWALL_UNIT="/etc/systemd/system/campus-cloud-wg-firewall.service"
WG_OVERRIDE_DIR="/etc/systemd/system/wg-quick@${WG_INTERFACE}.service.d"
WG_OVERRIDE="${WG_OVERRIDE_DIR}/campus-cloud.conf"
BACKUP_ROOT="/root/campus-cloud-backups"
MANAGED_MARKER="# Campus Cloud managed WireGuard interface"

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for command in ip ss systemctl tar; do
  command -v "${command}" >/dev/null || {
    echo "Required command is missing: ${command}" >&2
    exit 1
  }
done

ip link show "${WG_VM_INTERFACE}" >/dev/null 2>&1 || {
  echo "VM interface does not exist: ${WG_VM_INTERFACE}" >&2
  exit 1
}

if ! ip -4 address show dev "${WG_VM_INTERFACE}" | grep -Fq "${WG_SNAT_ADDRESS}/"; then
  echo "SNAT address ${WG_SNAT_ADDRESS} is not assigned to ${WG_VM_INTERFACE}." >&2
  exit 1
fi

if [[ -f "${WG_CONFIG}" ]] && ! grep -Fq "${MANAGED_MARKER}" "${WG_CONFIG}"; then
  echo "Refusing to overwrite unmanaged WireGuard config: ${WG_CONFIG}" >&2
  exit 1
fi

if ss -H -lun "sport = :${WG_LISTEN_PORT}" | grep -q .; then
  current_port="$(wg show "${WG_INTERFACE}" listen-port 2>/dev/null || true)"
  if [[ "${current_port}" != "${WG_LISTEN_PORT}" ]]; then
    echo "UDP ${WG_LISTEN_PORT} is already in use by another service." >&2
    exit 1
  fi
fi

if ! command -v ufw >/dev/null || ! ufw status | grep -Fq "Status: active"; then
  echo "This installer requires the Gateway's existing active UFW policy." >&2
  exit 1
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="${BACKUP_ROOT}/wireguard-${stamp}"
install -d -m 700 "${backup}"
if command -v iptables-save >/dev/null 2>&1; then
  iptables-save >"${backup}/iptables-save.txt"
else
  printf '%s\n' "iptables-save unavailable" >"${backup}/iptables-save.txt"
fi
ip -details address show >"${backup}/ip-address.txt"
ip route show table all >"${backup}/ip-routes.txt"
ufw status numbered >"${backup}/ufw-status.txt"
tar_paths=()
for path in etc/ufw etc/systemd/network etc/systemd/system etc/sysctl.d; do
  [[ -e "/${path}" ]] && tar_paths+=("${path}")
done
[[ -f /etc/sysctl.conf ]] && tar_paths+=(etc/sysctl.conf)
if ((${#tar_paths[@]})); then
  tar -C / -czf "${backup}/etc-network-firewall.tgz" "${tar_paths[@]}"
else
  tar -C / -czf "${backup}/etc-network-firewall.tgz" --files-from /dev/null
fi
find "${backup}" -maxdepth 1 -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 sha256sum >"${backup}/SHA256SUMS"
sha256sum -c "${backup}/SHA256SUMS" >/dev/null

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends wireguard-tools nftables
# The stock nftables service may load a ruleset containing `flush ruleset`.
# Campus Cloud uses its own unit and deliberately leaves this service disabled.
systemctl disable --now nftables.service >/dev/null 2>&1 || true

install -d -m 700 "${WG_DIR}"
install -d -m 755 "${NFT_DIR}" "${WG_OVERRIDE_DIR}"
if [[ ! -s "${WG_DIR}/server_private.key" ]]; then
  umask 077
  wg genkey >"${WG_DIR}/server_private.key"
fi
wg pubkey <"${WG_DIR}/server_private.key" >"${WG_DIR}/server_public.key"
private_key="$(<"${WG_DIR}/server_private.key")"
umask 077
cat >"${WG_CONFIG}" <<EOF
${MANAGED_MARKER}
[Interface]
Address = ${WG_ADDRESS}
ListenPort = ${WG_LISTEN_PORT}
PrivateKey = ${private_key}
SaveConfig = false
EOF
chmod 600 "${WG_CONFIG}" "${WG_DIR}/server_private.key" "${WG_DIR}/server_public.key"

cat >"${NFT_CONFIG}" <<EOF
destroy table inet campus_cloud_wg

table inet campus_cloud_wg {
    set allowed_tcp {
        type ipv4_addr . ipv4_addr . inet_service
        flags timeout
        timeout ${WG_ACL_TIMEOUT}
        gc-interval 5m
        comment "Authorized WireGuard client, VM and TCP port tuples"
    }

    chain forward_guard {
        type filter hook forward priority -10; policy accept;
        iifname "${WG_INTERFACE}" ip saddr ${WG_CLIENT_SUBNET} ip daddr ${WG_VM_SUBNET} ip saddr . ip daddr . tcp dport @allowed_tcp counter accept
        iifname "${WG_INTERFACE}" counter drop
    }

    chain postrouting {
        type nat hook postrouting priority srcnat; policy accept;
        ip saddr ${WG_CLIENT_SUBNET} ip daddr ${WG_VM_SUBNET} oifname "${WG_VM_INTERFACE}" counter snat ip to ${WG_SNAT_ADDRESS}
    }
}
EOF
chmod 600 "${NFT_CONFIG}"
nft --check --file "${NFT_CONFIG}"

cat >"${FIREWALL_UNIT}" <<EOF
[Unit]
Description=Campus Cloud WireGuard nftables policy
After=network-online.target ufw.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft --file ${NFT_CONFIG}
ExecReload=/usr/sbin/nft --file ${NFT_CONFIG}
ExecStop=-/usr/sbin/nft destroy table inet campus_cloud_wg

[Install]
WantedBy=multi-user.target
EOF

cat >"${WG_OVERRIDE}" <<EOF
[Unit]
Requires=campus-cloud-wg-firewall.service
After=campus-cloud-wg-firewall.service
BindsTo=campus-cloud-wg-firewall.service
EOF

cat >/etc/sysctl.d/90-campus-cloud-wireguard.conf <<EOF
# Campus Cloud WireGuard gateway forwarding
net.ipv4.ip_forward = 1
EOF
sysctl -w net.ipv4.ip_forward=1 >/dev/null

if ! ufw status | grep -Fq "${WG_LISTEN_PORT}/udp on ${WG_INGRESS_INTERFACE}"; then
  ufw allow in on "${WG_INGRESS_INTERFACE}" to any port "${WG_LISTEN_PORT}" \
    proto udp comment "Campus Cloud WireGuard"
fi
if ! ufw status | grep -Fq "Campus Cloud WireGuard routed traffic"; then
  ufw route allow in on "${WG_INTERFACE}" out on "${WG_VM_INTERFACE}" \
    from "${WG_CLIENT_SUBNET}" to "${WG_VM_SUBNET}" \
    comment "Campus Cloud WireGuard routed traffic after nft ACL"
fi

systemctl daemon-reload
systemd-analyze verify campus-cloud-wg-firewall.service "wg-quick@${WG_INTERFACE}.service"
systemctl enable --now campus-cloud-wg-firewall.service
systemctl enable --now "wg-quick@${WG_INTERFACE}.service"

systemctl is-active --quiet campus-cloud-wg-firewall.service
systemctl is-active --quiet "wg-quick@${WG_INTERFACE}.service"
systemctl is-active --quiet ssh

echo "Campus Cloud WireGuard is active."
echo "Backup: ${backup}"
echo "Interface: ${WG_INTERFACE} (${WG_ADDRESS})"
echo "Listen: ${WG_INGRESS_INTERFACE}/udp/${WG_LISTEN_PORT}"
echo "Public key: $(<"${WG_DIR}/server_public.key")"
