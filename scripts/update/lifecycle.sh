#!/bin/sh

apply_update() {
    read_state
    repair_pending
    read_state
    save_state '.sequence = ((.sequence // 0) + 1) | .status = {running:true,ok:true,message:"Downloading and checking the release…"}'
    verify_storage
    prune_downloads
    prune_releases
    download_release
    archive_edits
    systemctl stop "$SERVICE"
    snapshot_settings
    # Record intent before switching. Boot recovery always chooses this explicit rollback target.
    save_state --arg target "$TARGET" --arg rollback "$CURRENT" --arg snapshot "$SNAPSHOT" \
        '.pending = {target:$target, rollback:$rollback, snapshot:$snapshot, phase:"trial"}'
    set_current "$TARGET"
    record_status true true 'Trying the new release for 60 seconds…'
    start_current
    if trial_healthy; then
        save_state '.previous = .pending.rollback | .snapshot = .pending.snapshot |
            .current = .pending.target | .pending = null | .lastRollback = null'
        install_helpers "$TARGET"
        record_status false true "Update installed: $RELEASE."
        note "Update installed: $RELEASE."
    else
        rollback_to "$CURRENT" "$TARGET" "$SNAPSHOT" trial health-check-failed true
        fail 'The new release failed its health check. The previous release is running.'
    fi
}

trial_healthy() {
    trial_start=$(monotonic_seconds)
    # Cold SD reads and CAN adapter bring-up precede HTTP on a Zero 2 W.
    ready_deadline=$((trial_start + 120))
    healthy_since=0
    while :; do
        now=$(monotonic_seconds)
        if systemctl is-active --quiet "$SERVICE" && \
            curl --fail --silent --max-time 3 "$HEALTH_URL" > "$PRIVATE/health.json" && \
            jq -e --arg release "$RELEASE" '.ok == true and .release == $release' "$PRIVATE/health.json" >/dev/null; then
            if [ "$healthy_since" = 0 ]; then healthy_since=$now; fi
            [ $((now - healthy_since)) -lt 60 ] || return 0
        else
            [ "$healthy_since" = 0 ] || return 1
            [ "$now" -lt "$ready_deadline" ] || return 1
        fi
        sleep 2
    done
}

repair_pending() {
    if jq -e '.pending != null' "$STATE" >/dev/null; then
        pending_target=$(jq -r .pending.target "$STATE")
        pending_rollback=$(jq -r .pending.rollback "$STATE")
        pending_snapshot=$(jq -r .pending.snapshot "$STATE")
        pending_phase=$(jq -r .pending.phase "$STATE")
        if [ "$pending_phase" = rollback ]; then
            pending_policy=$(jq -r .pending.policy "$STATE")
            pending_reason=$(jq -r .pending.reason "$STATE")
            pending_reject=$(jq -r .pending.reject "$STATE")
        else
            pending_policy=trial
            pending_reason=interrupted
            pending_reject=false
        fi
        rollback_to "$pending_rollback" "$pending_target" "$pending_snapshot" "$pending_policy" "$pending_reason" "$pending_reject"
        note 'Update interrupted — press Update again.'
    else
        # A power cut between promoted journal and link repairs to the committed target too.
        set_current "$CURRENT"
        if jq -e '.status.running == true' "$STATE" >/dev/null; then
            record_status false false 'Update interrupted — press Update again.'
        fi
    fi
}

rollback_to() {
    rollback_target=$1
    failed_target=$2
    rollback_snapshot=$3
    rollback_policy=$4
    rollback_reason=$5
    reject_release=$6
    valid_release_directory "$rollback_target" && valid_release_directory "$failed_target" || fail 'A recorded rollback release is missing.'
    if ! failed_release=$(jq -er .release "$RELEASE_ROOT/releases/$failed_target/release.json"); then
        failed_release=$failed_target
        note 'The failed release identity is unreadable; recovering by its recorded directory.'
    fi
    if ! release_unedited "$failed_target"; then
        reject_release=false
        if [ "$rollback_reason" != interrupted ]; then rollback_reason=edited-release-failed; fi
    fi
    # The same explicit intent is replayed after a cut at ANY later boundary; never exchange links.
    save_state --arg target "$failed_target" --arg rollback "$rollback_target" --arg snapshot "$rollback_snapshot" \
        --arg policy "$rollback_policy" --arg reason "$rollback_reason" --argjson reject "$reject_release" \
        '.pending = {target:$target, rollback:$rollback, snapshot:$snapshot, phase:"rollback", policy:$policy, reason:$reason, reject:$reject}'
    if [ "$ACTION" != recover ]; then systemctl stop "$SERVICE"; fi
    restore_settings "$rollback_target" "$rollback_snapshot" "$rollback_policy"
    set_current "$rollback_target"
    save_state --arg from "$failed_release" --arg reason "$rollback_reason" --argjson restored "$SETTINGS_RESTORED" \
        --argjson reject "$reject_release" '.current = .pending.rollback | .previous = null |
        .rejected = (if $reject then (.rejected + [$from] | unique) else .rejected end) |
        .pending = null | .lastRollback = {from:$from, reason:$reason, settingsRestored:$restored}'
    if [ "$ACTION" != recover ]; then start_current; fi
    if [ "$rollback_reason" = interrupted ]; then
        record_status false false 'Update interrupted — press Update again.'
    else
        record_status false false "Rolled back from $failed_release ($rollback_reason)."
    fi
    note "Rolled back from $failed_release ($rollback_reason)."
}

handle_failure() {
    read_state
    # Once this lock is acquired, a pending trial's former owner has exited or been killed.
    if jq -e '.pending != null' "$STATE" >/dev/null; then repair_pending; return 0; fi
    start_limit_reached || return 0
    automatic_restarts=$(systemctl show "$SERVICE" --property=NRestarts --value)
    case "$automatic_restarts" in ''|*[!0-9]*) fail 'Cannot determine the service restart cause.' ;; esac
    if [ "$automatic_restarts" = 0 ]; then
        note 'Manual restart limit reached; starting the current release.'
        start_current
        return 0
    fi
    previous_target=$(jq -r '.previous // empty' "$STATE")
    if [ -z "$previous_target" ]; then
        note 'The current release keeps failing; no further automatic rollback is available.'
        return 0
    fi
    saved_snapshot=$(jq -er .snapshot "$STATE")
    rollback_to "$previous_target" "$CURRENT" "$saved_snapshot" late start-limit-hit true
}

start_limit_reached() {
    failure_substate=$(systemctl show "$SERVICE" --property=SubState --value) || fail 'Cannot determine the failed service state.'
    [ "$failure_substate" = failed ] || return 1
    failure_result=$(systemctl show "$SERVICE" --property=Result --value) || fail 'Cannot determine the service failure result.'
    [ "$failure_result" != start-limit-hit ] || return 0
    # systemd preserves a preceding exit-code/signal result when the limiter refuses a restart.
    failure_invocation=$(systemctl show "$SERVICE" --property=InvocationID --value) || fail 'Cannot determine the failed service invocation.'
    [ "${#failure_invocation}" = 32 ] || fail 'Cannot determine the failed service invocation.'
    case "$failure_invocation" in *[!a-f0-9]*) fail 'Invalid failed service invocation.' ;; esac
    journal_attempt=0
    while [ "$journal_attempt" -lt 5 ]; do
        limit_events=$(journalctl --boot --no-pager --output=json --lines=16 \
            _PID=1 "UNIT=$SERVICE" "INVOCATION_ID=$failure_invocation") || fail 'Cannot read the service start-limit journal.'
        limit_recorded=$(printf '%s\n' "$limit_events" | jq -r -s --arg service "$SERVICE" --arg invocation "$failure_invocation" \
            'any(.[]; ._PID == "1" and .UNIT == $service and .INVOCATION_ID == $invocation and
                (.MESSAGE | strings | endswith("Start request repeated too quickly.")))') || fail 'Cannot parse the service start-limit journal.'
        [ "$limit_recorded" != true ] || return 0
        journal_attempt=$((journal_attempt + 1))
        sleep 0.2
    done
    note 'No start-limit event for the failed invocation; leaving the current release selected.'
    return 1
}
