# Jira Time Tracker

Jira Time Tracker records work against work items and synchronizes completed time back to Jira.

## Language

**Time slice**:
A single interval of tracked work assigned to exactly one work item. Persisted time slice boundaries are normalized to whole minutes, so seconds and milliseconds are not part of the domain record.
_Avoid_: timeslice, slice

**Time rounding**:
A user setting that snaps timer-created boundaries to the nearest configured minute interval after whole-minute normalization. Whole-minute normalization still applies when time rounding is disabled.
_Avoid_: precision tracking

**Work item**:
The task or Jira issue that receives one or more time slices.
_Avoid_: task, ticket

## Example Dialogue

Developer: "If rounding is disabled and a user saves a time slice ending at 10:15:42, what is stored?"

Domain expert: "The time slice stores 10:15:00. Seconds are not meaningful for saved time slices."

Developer: "If rounding is enabled at 15 minutes and the timer stops at 10:08:42?"

Domain expert: "The boundary is normalized and then rounded to the configured interval, so it stores 10:15:00."
