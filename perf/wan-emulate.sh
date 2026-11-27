#!/usr/bin/env bash
#
# wan-emulate.sh — inject WAN-like network conditions (added RTT, jitter, loss,
# optional bandwidth cap) on the load generator, SCOPED to the perf target only,
# so the same k6 scenario can be re-run as a WAN-fidelity check without a remote
# load box. See perf/README.md § WAN emulation.
#
# Why scoped: the shaping is applied via an `htb` root qdisc whose DEFAULT class
# is unshaped (≈line rate) and a single `tc filter` that steers ONLY packets
# destined for the resolved target IP into a `netem` class. Your SSH session to
# the LG (a different destination IP) and all other egress are therefore
# untouched — so as long as <target> is not the host/IP you SSH in from, you
# cannot lag yourself out of the box (and the script refuses a target equal to
# your SSH peer when it can see SSH_CONNECTION).
#
# Model note: netem on the EGRESS qdisc delays the outbound leg only. A request/
# response exchange is delayed once, so the client-observed RTT increase ≈ the
# `delay` value. Set `delay` to the RTT you want to emulate (this is the usual
# netem WAN-emulation convention; it does not perfectly model a symmetric link,
# which would also shape the return leg via an ifb, but it is accurate enough
# for "what does +Xms RTT do to my numbers").
#
# Usage:
#   sudo ./wan-emulate.sh on  <preset> <target-host-or-ip> [iface]
#   sudo ./wan-emulate.sh off [iface]
#   sudo ./wan-emulate.sh status [iface]
#
# Presets (delay ≈ emulated RTT):
#   regional          30ms ±5ms,  0.02% loss            (same-country)
#   continental       80ms ±15ms, 0.10% loss            (cross-country)
#   intercontinental  160ms ±30ms,0.20% loss            (trans-ocean)
#   mobile            120ms ±40ms,1.00% loss, 8mbit cap, 5% reorder (poor 4G)
#
# Examples:
#   sudo ./wan-emulate.sh on continental hackarena.pogrebisky.net
#   # ... run the usual k6 command, compare against the LAN baseline ...
#   sudo ./wan-emulate.sh off
#
set -euo pipefail

# ── Preset table ─────────────────────────────────────────────────────────────
# netem args per preset. `rate`/`reorder` only where they belong.
preset_args() {
  case "$1" in
    regional)         echo "delay 30ms 5ms distribution normal loss 0.02%" ;;
    continental)      echo "delay 80ms 15ms distribution normal loss 0.1%" ;;
    intercontinental) echo "delay 160ms 30ms distribution normal loss 0.2%" ;;
    mobile)           echo "delay 120ms 40ms distribution normal loss 1% reorder 5% rate 8mbit" ;;
    *) return 1 ;;
  esac
}

die() { echo "wan-emulate: $*" >&2; exit 1; }

require_root() { [ "$(id -u)" = "0" ] || die "must run as root (use sudo)."; }
require_tc()   { command -v tc >/dev/null 2>&1 || die "'tc' not found — install iproute2 (apt-get install iproute2)."; }

# Resolve a host (or pass-through an IP) to a single IPv4 address.
resolve_ipv4() {
  local host="$1" ip=""
  # Already an IPv4 literal?
  if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$host"; return 0; fi
  # `|| true` so a non-zero getent (NXDOMAIN → rc 2) under `set -o pipefail`
  # never aborts the script; the function fails cleanly via the rc-1 below.
  if command -v getent >/dev/null 2>&1; then
    ip=$(getent ahostsv4 "$host" 2>/dev/null | awk '{print $1; exit}' || true)
  fi
  if [ -z "$ip" ] && command -v dig >/dev/null 2>&1; then
    ip=$(dig +short A "$host" 2>/dev/null | grep -Em1 '^[0-9.]+$' || true)
  fi
  [ -n "$ip" ] || return 1
  echo "$ip"
}

# Egress interface used to reach a given IP. Captured into a local + printed so
# neither a non-zero `ip route get` nor a SIGPIPE from `head` propagates under
# `set -o pipefail` — returns empty + rc 0 on failure, never aborts a bare call.
iface_for_ip() {
  local d
  d=$(ip -o route get "$1" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n1 || true)
  printf '%s' "$d"
}

cmd_on() {
  local preset="${1:-}" target="${2:-}" iface="${3:-}"
  [ -n "$preset" ] && [ -n "$target" ] || die "usage: wan-emulate.sh on <preset> <target-host-or-ip> [iface]"
  local netem_args
  netem_args=$(preset_args "$preset") || die "unknown preset '$preset' (regional|continental|intercontinental|mobile)."

  local ip
  ip=$(resolve_ipv4 "$target") || die "could not resolve an IPv4 address for '$target'."

  # Best-effort self-shaping guard: never steer the operator's own SSH-return
  # traffic into netem. SSH_CONNECTION field 1 is the client IP as the LG sees
  # it == the dst of SSH responses, which is exactly what the `ip dst` filter
  # matches. sudo strips this var (re-invoke via `sudo -E` to keep the check);
  # it's empty for local/console runs, so this no-ops rather than false-trips.
  local ssh_peer="${SSH_CONNECTION:-}"; ssh_peer="${ssh_peer%% *}"
  if [ -n "$ssh_peer" ] && [ "$ssh_peer" = "$ip" ]; then
    die "target $ip is the host you SSH in from — shaping it would lag/stall your own session. Point at the perf target, not the LG/your workstation."
  fi
  # Warn (don't block) when the name has multiple A records — we shape only one.
  if command -v getent >/dev/null 2>&1; then
    local n_a
    n_a=$(getent ahostsv4 "$target" 2>/dev/null | awk '{print $1}' | sort -u | wc -l || true)
    [ "${n_a:-0}" -gt 1 ] && echo "wan-emulate: WARNING — '$target' resolves to $n_a IPv4 addresses; shaping ONLY $ip. A round-robin/anycast name leaves the other(s) at line rate." >&2 || true
  fi

  [ -n "$iface" ] || iface=$(iface_for_ip "$ip")
  [ -n "$iface" ] || die "could not determine egress interface for $ip — pass it explicitly as the 3rd arg."

  # Refuse to stack on top of an existing root qdisc we didn't create — make the
  # operator run `off` first so we never silently clobber unrelated shaping.
  if tc qdisc show dev "$iface" | grep -q 'qdisc htb 1:'; then
    die "an htb root qdisc already exists on $iface — run 'wan-emulate.sh off $iface' first."
  fi

  echo "wan-emulate: applying '$preset' to $target ($ip) on $iface"
  echo "             netem: $netem_args"
  # If any tc step below fails, tear the whole root qdisc back down so we never
  # leave a half-applied (and possibly traffic-affecting) shaping in place.
  trap 'echo "wan-emulate: setup failed — rolling back" >&2; tc qdisc del dev "$iface" root 2>/dev/null || true; exit 1' ERR
  # htb root: default class 1:1 is unshaped (10gbit ceil ≈ line rate); the
  # target class 1:10 carries the netem qdisc. Only the dst-IP filter steers
  # traffic into 1:10, so everything else (SSH, DNS, other hosts) is unshaped.
  tc qdisc add dev "$iface" root handle 1: htb default 1
  tc class add dev "$iface" parent 1: classid 1:1  htb rate 10gbit
  tc class add dev "$iface" parent 1: classid 1:10 htb rate 10gbit
  # shellcheck disable=SC2086
  tc qdisc add dev "$iface" parent 1:10 handle 10: netem $netem_args
  tc filter add dev "$iface" parent 1: protocol ip prio 1 u32 match ip dst "$ip"/32 flowid 1:10
  trap - ERR

  echo "wan-emulate: active. Verify with: ./wan-emulate.sh status $iface"
  echo "             Sanity-check the added latency:  curl -s -o /dev/null -w 'connect=%{time_connect}s total=%{time_total}s\\n' https://$target/api/status"
  echo "             Remove when done with:           sudo ./wan-emulate.sh off $iface"
}

cmd_off() {
  local iface="${1:-}"
  if [ -z "$iface" ]; then
    # Best-effort: clear any iface that carries our htb root.
    local cleared=0 dev
    for dev in /sys/class/net/*; do
      dev=$(basename "$dev")
      if tc qdisc show dev "$dev" 2>/dev/null | grep -q 'qdisc htb 1:'; then
        if tc qdisc del dev "$dev" root 2>/dev/null; then echo "wan-emulate: cleared $dev"; cleared=1; fi
      fi
    done
    [ "$cleared" = "1" ] || echo "wan-emulate: no wan-emulate qdisc found on any interface (nothing to do)."
    return 0
  fi
  # Explicit iface: only act on OUR qdisc (the `htb 1:` signature — never a
  # qdisc the script didn't create), and surface a genuine `tc del` failure
  # instead of collapsing it into the benign "nothing to clear" message.
  if tc qdisc show dev "$iface" 2>/dev/null | grep -q 'qdisc htb 1:'; then
    if tc qdisc del dev "$iface" root; then
      echo "wan-emulate: cleared $iface"
    else
      die "failed to clear the htb qdisc on $iface (see tc error above) — shaping may still be active; check 'tc qdisc show dev $iface'."
    fi
  else
    echo "wan-emulate: nothing to clear on $iface (no wan-emulate qdisc present)."
  fi
}

cmd_status() {
  local iface="${1:-}"
  local -a devs
  if [ -n "$iface" ]; then
    devs=("$iface")
  else
    devs=()
    for d in /sys/class/net/*; do devs+=("$(basename "$d")"); done
  fi
  for dev in "${devs[@]}"; do
    if tc qdisc show dev "$dev" 2>/dev/null | grep -q 'qdisc'; then
      echo "── $dev ──"
      tc qdisc show dev "$dev"
      tc filter show dev "$dev" 2>/dev/null | grep -E 'match|flowid' || true
    fi
  done
}

main() {
  require_tc
  local action="${1:-}"; shift || true
  case "$action" in
    on)     require_root; cmd_on "$@" ;;
    off)    require_root; cmd_off "$@" ;;
    status) cmd_status "$@" ;;
    *) die "usage: wan-emulate.sh {on <preset> <target> [iface] | off [iface] | status [iface]}" ;;
  esac
}

main "$@"
