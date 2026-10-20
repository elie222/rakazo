#!/usr/bin/env bash
# Nonzero exit exposes low storage, failed backups, or missing SSH rules to monitoring.
set -euo pipefail
messages=()
report() { messages+=("$1"); echo "$1" >&2; }
for target in / /var/backups; do
  if ! usage="$(df -Pk "${target}" | awk 'NR == 2 { gsub(/%/, "", $5); print $4, $5 }')" || [[ -z "${usage}" ]]; then
    report "Could not inspect storage at ${target}"
    continue
  fi
  read -r free_kb used <<<"${usage}"
  if ((used >= 80 || free_kb < 5 * 1024 * 1024)); then
    echo "${target}: ${used}% used, $((free_kb / 1024))MiB free" >&2
    report "${target} storage is low (at least 80% used or less than 5GiB free)"
  fi
done
if [[ "${RAKAZO_BACKUP_REQUIRE_VOLUME:-0}" == 1 ]] && { ! mountpoint -q /var/backups || [[ "$(stat -c %d /var/backups)" == "$(stat -c %d /)" ]]; }; then
  report "Backup volume is not mounted separately"
fi
latest=""
if [[ -d /var/backups/rakazo ]]; then
  if ! latest="$(find /var/backups/rakazo -mindepth 2 -maxdepth 2 -name SHA256SUMS -type f -printf '%T@\n' | sort -nr | head -1)"; then
    report "Could not inspect backup history"
  fi
fi
if [[ -z "${latest}" ]] || (($(date +%s) - ${latest%.*} > 36 * 3600)); then
  report "No verified backup completed in the last 36 hours"
fi
if systemctl is-failed --quiet rakazo-backup.service; then
  report "The last backup service run failed"
else
  /usr/local/sbin/rakazo-host-alert backup-failure "" || report "Could not deliver backup recovery notification"
fi
if ! ports="$(/usr/sbin/sshd -T | awk '$1 == "port" { print $2 }')" || [[ -z "${ports}" ]]; then
  report "Could not inspect SSH configuration"
else
  for port in ${ports}; do
    if ! grep -qE "^### tuple ### (limit|allow) (tcp|any) ${port} " /etc/ufw/user.rules; then
      report "IPv4 SSH allow rule is missing for port ${port}"
    fi
  done
fi

printf '%s\n' "${messages[@]}" | /usr/local/sbin/rakazo-host-alert host-check
((${#messages[@]} == 0))
