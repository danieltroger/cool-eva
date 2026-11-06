import assert from "node:assert/strict";
import { sshCommand, type GuestSsh } from "./ssh.ts";

export async function observeOsCatchUp(guest: GuestSsh, execute: typeof sshCommand = sshCommand): Promise<void> {
  const result = await execute(guest, osObservationCommand(), (OBSERVATION_SECONDS + TRANSPORT_GRACE_SECONDS) * 1000);
  assert.match(result, /OS_JOB_SURVIVED_SSH/);
  console.log(result.trim());
}

export function osObservationCommand(): string {
  return `sudo sh -eu <<'OS_JOB_OBSERVATION'
test -e /etc/cool-eva-qemu-fixture
read started idle < /proc/uptime
started=\${started%%.*}
reported=0
previous=
last_state=unknown
while :; do
  read current idle < /proc/uptime
  elapsed=$((\${current%%.*} - started))
  remaining=$((${OBSERVATION_SECONDS} - elapsed))
  [ "$remaining" -gt 0 ] || break
  query_seconds=5
  [ "$remaining" -ge 5 ] || query_seconds=$remaining
  unit_state=unknown
  unit_result=unknown
  unit_status=unknown
  if properties=$(timeout --signal=KILL "$query_seconds" systemctl show cool-eva-install-os.service --property=ActiveState --property=Result --property=ExecMainStatus 2>/dev/null); then
    while IFS='=' read -r property value; do
      case "$property" in
        ActiveState) unit_state=$value ;;
        Result) unit_result=$value ;;
        ExecMainStatus) unit_status=$value ;;
      esac
    done <<OS_JOB_PROPERTIES
$properties
OS_JOB_PROPERTIES
    last_state="state=$unit_state result=$unit_result status=$unit_status"
  else
    query_status=$?
    last_state="query-exit=$query_status"
  fi
  read current idle < /proc/uptime
  elapsed=$((\${current%%.*} - started))
  remaining=$((${OBSERVATION_SECONDS} - elapsed))
  [ "$remaining" -gt 0 ] || break
  case "$unit_state" in
    active)
      if [ "$unit_status" = 0 ] && [ "$unit_result" = success ]; then
        printf 'OS_JOB_SURVIVED_SSH after %ss\\n' "$elapsed"
        exit 0
      fi
      printf 'OS catch-up failed after %ss: %s\\n' "$elapsed" "$last_state" >&2
      exit 1 ;;
    activating|unknown) : ;;
    *)
      printf 'OS catch-up failed after %ss: %s\\n' "$elapsed" "$last_state" >&2
      exit 1 ;;
  esac
  if [ "$last_state" != "$previous" ] || [ "$((elapsed - reported))" -ge 30 ]; then
    printf 'Observing the same OS catch-up unit (%ss): %s\\n' "$elapsed" "$last_state"
    previous=$last_state
    reported=$elapsed
  fi
  sleep_seconds=2
  [ "$remaining" -ge 2 ] || sleep_seconds=$remaining
  sleep "$sleep_seconds"
done
printf 'OS catch-up observation exceeded ${OBSERVATION_SECONDS}s: %s; no job was resubmitted.\\n' "$last_state" >&2
exit 1
OS_JOB_OBSERVATION`;
}

const OBSERVATION_SECONDS = 50 * 60;
const TRANSPORT_GRACE_SECONDS = 50;
