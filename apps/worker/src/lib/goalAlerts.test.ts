import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { shouldEmitGoalOffTrackAlert } from './goalAlerts.js';

describe('goal off-track alert gate', () => {
  const now = new Date('2026-07-17T07:00:00Z');

  it('emits only for an on-track to off-track transition', () => {
    assert.equal(
      shouldEmitGoalOffTrackAlert({
        previousOnTrack: true,
        currentOnTrack: false,
        lastAlertedAt: null,
        now,
      }),
      true,
    );
    assert.equal(
      shouldEmitGoalOffTrackAlert({
        previousOnTrack: false,
        currentOnTrack: false,
        lastAlertedAt: null,
        now,
      }),
      false,
    );
    assert.equal(
      shouldEmitGoalOffTrackAlert({
        previousOnTrack: null,
        currentOnTrack: false,
        lastAlertedAt: null,
        now,
      }),
      false,
    );
  });

  it('debounces repeated transitions for seven days', () => {
    assert.equal(
      shouldEmitGoalOffTrackAlert({
        previousOnTrack: true,
        currentOnTrack: false,
        lastAlertedAt: new Date('2026-07-12T07:00:00Z'),
        now,
      }),
      false,
    );
    assert.equal(
      shouldEmitGoalOffTrackAlert({
        previousOnTrack: true,
        currentOnTrack: false,
        lastAlertedAt: new Date('2026-07-10T07:00:00Z'),
        now,
      }),
      true,
    );
  });
});
