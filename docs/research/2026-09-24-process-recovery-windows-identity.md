# Process recovery Windows identity upstream recheck — 2026-09-24

Status: CURRENT OFFICIAL-SOURCE INPUT / SOURCE-ONLY

## Native identity

Microsoft documents GetProcessTimes as returning the process creation FILETIME for a process handle,
and QueryFullProcessImageName as returning the full executable image path when the caller has process
query rights.

Official sources:
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-queryfullprocessimagenamew

Disposition:
- PID alone is never sufficient recovery identity;
- the future Windows ProcessIdentityObserver should bind at least PID + creation time + executable
  image identity;
- a PID whose creation/image identity differs is STALE_IDENTITY and must not be terminated.

## Process-tree containment

Microsoft Job Objects manage groups/process trees as a unit. Processes assigned to a job normally
propagate membership to child processes. JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates processes
associated with the job when the final job handle closes.

Official sources:
- https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information

Disposition:
- native Job Object ownership is the preferred successor to taskkill-based tree cleanup on Windows;
- this source slice does not add a native module or claim Job Object implementation;
- recovery contracts are backend-neutral so the native observer/job backend can be added without
  changing durable ownership semantics.
