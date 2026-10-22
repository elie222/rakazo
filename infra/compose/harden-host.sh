#!/usr/bin/env bash

set -Eeuo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
SSH_PORT="${SSH_PORT:-22}"
[[ "${SSH_PORT}" =~ ^[0-9]+$ ]] && ((SSH_PORT > 0 && SSH_PORT <= 65535)) || { echo "Invalid SSH_PORT" >&2; exit 1; }

if [[ "${EUID}" -ne 0 ]]; then
  exec sudo --preserve-env=DEPLOY_USER,SSH_PORT,SSH_CONNECTION bash "$0" "$@"
fi

# Validate the guard's session identity before installing packages or writing host settings.
[[ -n "${SSH_CONNECTION:-}" ]] || { echo "SSH_CONNECTION is required; use sudo --preserve-env=SSH_CONNECTION" >&2; exit 1; }

if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "Deploy user ${DEPLOY_USER} does not exist" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  age \
  apparmor \
  apparmor-utils \
  auditd \
  audispd-plugins \
  fail2ban \
  needrestart \
  ufw \
  unattended-upgrades

install -d -m 755 /etc/ssh/sshd_config.d
cat >/etc/ssh/sshd_config.d/99-rakazo-hardening.conf <<EOF
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
AuthenticationMethods publickey
PermitEmptyPasswords no
HostbasedAuthentication no
GSSAPIAuthentication no
X11Forwarding no
AllowAgentForwarding no
AllowTcpForwarding local
GatewayPorts no
PermitTunnel no
LoginGraceTime 30
MaxAuthTries 3
MaxSessions 4
MaxStartups 10:30:30
ClientAliveInterval 300
ClientAliveCountMax 2
UseDNS no
LogLevel VERBOSE
AllowUsers ${DEPLOY_USER}
EOF
chmod 600 /etc/ssh/sshd_config.d/99-rakazo-hardening.conf
sshd -t

cat >/etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
enabled = true
backend = systemd
port = ${SSH_PORT}
maxretry = 3
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.factor = 2
bantime.maxtime = 1w
banaction = ufw
EOF

cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF

cat >/etc/apt/apt.conf.d/52rakazo-unattended-upgrades <<'EOF'
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

cat >/etc/sysctl.d/99-rakazo-hardening.conf <<'EOF'
fs.protected_fifos = 2
fs.protected_hardlinks = 1
fs.protected_regular = 2
fs.protected_symlinks = 1
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.perf_event_paranoid = 3
kernel.unprivileged_bpf_disabled = 1
kernel.yama.ptrace_scope = 1
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_rfc1337 = 1
net.ipv4.tcp_syncookies = 1
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv6.conf.default.accept_source_route = 0
EOF
sysctl --system >/dev/null

install -d -m 750 /etc/audit/rules.d
cat >/etc/audit/rules.d/50-rakazo.rules <<'EOF'
-w /etc/ssh/sshd_config -p wa -k sshd_config
-w /etc/ssh/sshd_config.d/ -p wa -k sshd_config
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
EOF
augenrules --load >/dev/null

# Keep existing private-network rules. Roll back unless a fresh SSH session confirms.
install -m 0755 "$(dirname "$0")/firewall-change.sh" /usr/local/sbin/rakazo-firewall-change
/usr/local/sbin/rakazo-firewall-change apply bash -euc '
  ufw default deny incoming
  ufw default allow outgoing
  ufw limit "$1/tcp" comment "Rate-limited SSH"
  ufw allow 80/tcp comment "HTTP for ACME redirect"
  ufw allow 443/tcp comment "HTTPS"
  ufw allow 443/udp comment "HTTP/3"
  ufw --force enable
' _ "${SSH_PORT}"

systemctl enable --now apparmor auditd fail2ban unattended-upgrades
systemctl restart fail2ban
systemctl reload ssh

echo "Host hardening applied. Confirm the firewall token from a fresh SSH session within three minutes."
