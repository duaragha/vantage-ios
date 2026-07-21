const GOAL_ALERT_DEBOUNCE_MS = 7 * 24 * 60 * 60 * 1000;

export function shouldEmitGoalOffTrackAlert(input: {
  previousOnTrack: boolean | null | undefined;
  currentOnTrack: boolean;
  lastAlertedAt: Date | null;
  now: Date;
}): boolean {
  if (input.previousOnTrack !== true || input.currentOnTrack) return false;
  if (input.lastAlertedAt === null) return true;
  return input.now.getTime() - input.lastAlertedAt.getTime() >= GOAL_ALERT_DEBOUNCE_MS;
}
