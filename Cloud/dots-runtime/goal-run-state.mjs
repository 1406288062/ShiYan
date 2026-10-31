// Run completion must respect commands received while Codex or a safe action
// was awaiting. The caller reads the latest goal and pending events immediately
// before its synchronous database writeback.
export function canApplyGoalActions(goal) {
  return goal?.status === "active";
}

export function assertGoalActionAllowed(goal, action, { hasPendingApproval = false } = {}) {
  const status = goal?.status;
  if (!goal) {
    const error = new Error("goal not found");
    error.statusCode = 404;
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
    error.statusCode = 409;
    throw error;
  }
}

export function mayActivateGoalForEvent(goal, { resumeAfterApproval = false, hasPendingApproval = false } = {}) {
  if (hasPendingApproval) return false;
  return ["active", "blocked"].includes(goal?.status) ||
    (goal?.status === "waiting_approval" && resumeAfterApproval);
}

export function resolveGoalRunState(goal, {
  requestedStatus,
  actionCount = 0,
  hasPendingEvents = false,
  nowSec,
  wakeAfterSeconds = 900
}) {
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
  const nextWakeAt = goalStatus !== "active" ? null
    : hasPendingEvents ? nowSec
    : actionCount ? nowSec + 2
    : nowSec + wakeAfterSeconds;

  return { goalStatus, effectiveStatus, nextWakeAt, controlPreserved: false, newInputPending: hasPendingEvents };
}

export function resolveGoalRunFailure(goal, { nowSec, hasPendingEvents = false }) {
  return {
    nextWakeAt: canApplyGoalActions(goal)
      ? nowSec + (hasPendingEvents ? 0 : 120)
      : goal?.next_wake_at ?? null,
    controlPreserved: !canApplyGoalActions(goal)
  };
}
