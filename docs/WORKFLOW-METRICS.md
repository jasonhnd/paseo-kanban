# Workflow metrics

Use a read-only board snapshot and a UTC half-open window. `waitingCardHours`
in `server/waiting-metrics.ts` clips status intervals to that window, includes
cards created earlier and counts repeated waiting intervals. Its SQL is the
source of truth; notification events do not restart the window.

The query below counts delivered prerequisite wakes and completed executor
reopens. Pending or failed attempts do not count. Bind full ISO timestamps to
`window_start` and `window_end`. Projects absent from the result have zero
events in the covered history. Truncated event history limits both metrics;
missing history must not be reported as zero waiting time.

```sql
-- wake_and_reopen_counts
SELECT t.project,
       sum(e.kind = 'wake_prerequisite') AS prerequisite_wakes,
       sum(e.kind = 'rework_reopened') AS automatic_executor_reopens
FROM events e JOIN tasks t ON t.id = e.task_id
WHERE e.kind IN ('wake_prerequisite', 'rework_reopened')
  AND julianday(e.at) >= julianday(:window_start)
  AND julianday(e.at) < julianday(:window_end)
GROUP BY t.project ORDER BY t.project;
```
