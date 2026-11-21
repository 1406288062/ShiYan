// Run completion must respect commands received while Codex or a safe action
// was awaiting. The caller reads the latest goal and pending events immediately
// before its synchronous database writeback.
export function canApplyGoalActions(goal: any) {
  return goal?.status === "active";
}

export function assertGoalActionAllowed(goal: any, action: any, { hasPendingApproval = false } = {}) {
  const status = goal?.status;
  if (!goal) {
    const error = new Error("goal not found");
    (error as any).statusCode = 404;
    throw error;
  }
  if (status === "cancelled" && action === "cancel") return;
  const terminal = status === "done" || status === "cancelled";
  const allowed = !terminal && (
    action === "pause" || action === "cancel" ||
    (action === "resume" && ["paused", "blocked"].includes(status) && !hasPendingApproval) ||
    (["wake", "instruct"].includes(action) && ["active", "blocked"].includes(status) && !hasPendingApproval)
  );
  if (!allowed) {
    const detail = hasPendingApproval && ["wake", "instruct", "resume"].includes(action)
      ? "Resolve the pending approval before continuing."
      : "The current goal state does not allow this action.";
    const error = new Error(`Cannot ${action} a ${status} goal. ${detail}`);
    (error as any).statusCode = 409;
    throw error;
  }
}

export function mayActivateGoalForEvent(goal: any, { resumeAfterApproval = false, hasPendingApproval = false } = {}) {
  if (hasPendingApproval) return false;
  return ["active", "blocked"].includes(goal?.status) ||
    (goal?.status === "waiting_approval" && resumeAfterApproval);
}

// Goals whose title or instruction describes ongoing monitoring (监测/监控/盯盘/走势) wait at least one hour between self-scheduled runs.
export function monitoringMinIntervalSec(goal: any) {
  return /监测|监控|盯盘|走势/.test(`${goal?.title || ''} ${goal?.instruction || ''}`) ? 3600 : 0;
}

export function resolveGoalRunState(goal: any, {
  requestedStatus,
  actionCount = 0,
  hasPendingEvents = false,
  nowSec,
  wakeAfterSeconds = 900,
  minIntervalSec = 0
}: any) {
  if (!canApplyGoalActions(goal)) {
    return {
      goalStatus: goal?.status || "cancelled",
      effectiveStatus: goal?.status || "cancelled",
      nextWakeAt: goal?.next_wake_at ?? null,
      controlPreserved: true,
      newInputPending: false
    };
  }

  // A new instruction/event was not in this planner's prompt. It must be
  // handled before applying the stale planner's completion/blocker decision.
  const effectiveStatus = hasPendingEvents || (actionCount && requestedStatus !== "needs_approval")
    ? "continue"
    : requestedStatus;
  const goalStatus = effectiveStatus === "done" ? "done"
    : effectiveStatus === "blocked" ? "blocked"
    : effectiveStatus === "needs_approval" ? "waiting_approval"
    : "active";
  // Monitoring goals wait at least minIntervalSec between self-scheduled runs; the 2s action path does not apply to them.
  const selfWake = minIntervalSec > 0 ? Math.max(wakeAfterSeconds, minIntervalSec) : (actionCount ? 2 : wakeAfterSeconds);
  const nextWakeAt = goalStatus !== "active" ? null
    : hasPendingEvents ? nowSec
    : nowSec + selfWake;

  return { goalStatus, effectiveStatus, nextWakeAt, controlPreserved: false, newInputPending: hasPendingEvents };
}

export function classifyGoalRunFailure(errorMessage = "") {
  const message = String(errorMessage);
  if (/(?:network access (?:is )?disabled|network disabled|permission denied|unauthorized|forbidden|invalid api key|authentication failed|configuration error)/i.test(message)) return "non_retryable";
  if (/(?:network|fetch failed|econn(?:reset|refused|aborted)|etimedout|eai_again|enotfound|enetunreach|ehostunreach|socket hang up|connection (?:reset|refused|timed out)|tls handshake|dns lookup|gateway timeout|bad gateway|service unavailable|HTTP.?50[234])/i.test(message)) return "network";
  if (/(?:timed out|timeout|temporarily unavailable|rate limit|too many requests|limit exceeded|limit reached|you.ve hit your .*limit|HTTP.?429)/i.test(message)) return "transient";
  return "non_retryable";
}

export function resolveGoalRunFailure(goal: any, { nowSec, hasPendingEvents = false, errorMessage = "" }: any) {
  const retryKind = classifyGoalRunFailure(errorMessage);
  const networkHours = [1, 2, 4, 8, 24];
  const failureCount = Math.max(0, Number(goal?.failure_count) || 0);
  const retrySeconds = retryKind === "network" ? networkHours[Math.min(failureCount, networkHours.length - 1)] * 60 * 60
    : retryKind === "transient" ? 60 * 60
    : hasPendingEvents ? 0 : null;
  return {
    nextWakeAt: canApplyGoalActions(goal)
      ? retrySeconds === null ? null : nowSec + retrySeconds
      : goal?.next_wake_at ?? null,
    controlPreserved: !canApplyGoalActions(goal),
    cooldown: 0,
    retryKind,
    retrySeconds,
    nextFailureCount: retryKind === "network" ? failureCount + 1 : 0
  };
}
