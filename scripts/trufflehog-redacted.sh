#!/usr/bin/env bash
set -euo pipefail

readonly EXIT_FINDINGS=10
readonly EXIT_SCANNER_ERROR=11
readonly TERMINATION_POLLS=20

# Preserve the caller's stderr only for our bounded messages. Bash may emit
# asynchronous job-status diagnostics while a trapped signal interrupts wait;
# suppress that channel, and never expose the preserved descriptor to scanners.
exec 3>&2
exec 2>/dev/null

scanner="${TRUFFLEHOG_BIN:-}"
timeout_seconds="${TRUFFLEHOG_TIMEOUT_SECONDS:-300}"
if [ -z "$scanner" ] || [ ! -x "$scanner" ]; then
  printf 'trufflehog: scanner unavailable\n' >&3
  exit "$EXIT_SCANNER_ERROR"
fi
if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]{0,2}$ ]] || [ "$timeout_seconds" -gt 600 ]; then
  printf 'trufflehog: invalid timeout\n' >&3
  exit "$EXIT_SCANNER_ERROR"
fi
if ! command -v setsid >/dev/null 2>&1 && ! command -v perl >/dev/null 2>&1; then
  printf 'trufflehog: session launcher unavailable\n' >&3
  exit "$EXIT_SCANNER_ERROR"
fi

group_pid=''
timer_pid=''

launch_isolated() {
  if command -v setsid >/dev/null 2>&1; then
    exec setsid "$scanner" "$@"
  fi
  exec perl -MPOSIX -e 'POSIX::setsid() >= 0 or exit 127; exec {$ARGV[0]} @ARGV or exit 127' "$scanner" "$@"
}

stop_timer() {
  [ -z "$timer_pid" ] || kill -TERM "$timer_pid" >/dev/null 2>&1 || true
  [ -z "$timer_pid" ] || wait "$timer_pid" >/dev/null 2>&1 || true
  timer_pid=''
}

terminate_group() {
  local poll=0
  [ -z "$group_pid" ] || kill -TERM -- "-$group_pid" >/dev/null 2>&1 || true
  while [ -n "$group_pid" ] && [ "$poll" -lt "$TERMINATION_POLLS" ] && kill -0 -- "-$group_pid" >/dev/null 2>&1; do
    sleep 0.05
    poll=$((poll + 1))
  done
  [ -z "$group_pid" ] || kill -KILL -- "-$group_pid" >/dev/null 2>&1 || true
  [ -z "$group_pid" ] || wait "$group_pid" >/dev/null 2>&1 || true
  group_pid=''
}

# Invoked through a signal trap.
# shellcheck disable=SC2329
finish_interrupted() {
  trap - ALRM TERM INT HUP
  stop_timer
  terminate_group
  printf 'trufflehog: scanner interrupted (details redacted)\n' >&3
  exit "$EXIT_SCANNER_ERROR"
}

# Invoked through a signal trap.
# shellcheck disable=SC2329
finish_timeout() {
  trap - ALRM TERM INT HUP
  stop_timer
  terminate_group
  printf 'trufflehog: scanner timeout (details redacted)\n' >&3
  exit "$EXIT_SCANNER_ERROR"
}

trap finish_timeout ALRM
trap finish_interrupted TERM INT HUP

launch_isolated "$@" 3>&- >/dev/null 2>&1 &
group_pid=$!
wrapper_pid=$$
(
  sleep "$timeout_seconds"
  kill -ALRM "$wrapper_pid" >/dev/null 2>&1 || true
) 3>&- >/dev/null 2>&1 &
timer_pid=$!

set +e
wait "$group_pid" >/dev/null 2>&1
status=$?
set -e
stop_timer
# A scanner that exits while leaving descendants behind is still fully reaped.
terminate_group

case "$status" in
  0) printf 'trufflehog: clean\n'; exit 0 ;;
  183) printf 'trufflehog: findings detected (details redacted)\n' >&3; exit "$EXIT_FINDINGS" ;;
  *) printf 'trufflehog: scanner error (details redacted)\n' >&3; exit "$EXIT_SCANNER_ERROR" ;;
esac
