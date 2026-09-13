// Single rule for whether an activity card should auto-open its process
// view. The mobile chat keeps process cards compact by default; callers can
// still force-open actionable states such as plan confirmations.
//
// NOT yet wired into the local ActivityMessage — current local behaviour is
// to always show the last-N visible steps regardless of running state. The
// gate lands as part of Batch B (chat renderer split / ActivityTimeline
// component port).

export function activityCardShouldOpen({ running, hasProcess }) {
  return false;
}
