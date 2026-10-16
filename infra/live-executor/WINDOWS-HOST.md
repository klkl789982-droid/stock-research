# Windows operator host

This host runs the existing Node executor directly; GitHub Actions is not a
collection dependency. It uses the current Windows user's interactive account
and never stores that user's Windows password. Public publication is forced off
in the child environment, overriding `.env.local` publication flags.

Prerequisites: Node 22 or later, the existing checkout and `.env.local`, and a
private absolute state directory outside the checkout. The environment file is
read only by Node; its contents are never printed by the installer or supervisor.

Inspect the exact task definition without registering or starting anything:

```powershell
powershell.exe -NoProfile -File infra/live-executor/install-windows-task.ps1 -StateDir C:/Users/user/AppData/Local/TightBudget/live-executor
```

After reviewing the output, the same command with `-Register` registers the task
and reads back its settings. The installer makes no explicit start request;
enabled triggers and missed-start recovery can start the task automatically. No
execution-policy override is used. An existing task can be replaced only when
its description matches the exact managed marker for this checkout, state
directory and user SID. An already running task is preserved.

The task name is `TightBudget-Live-Executor-<current-user-SID-suffix>` under `\`.
Its triggers are 13:40 KST (04:40 UTC) every day and current-user logon. The daemon
applies the existing trading-calendar and 14:00–14:05 quote window. Task settings
request wake from sleep, missed-start recovery and a single running instance.
The task's principal is InteractiveToken/LeastPrivilege. A PowerShell launcher
uses `Start-Process -WindowStyle Hidden`; the Node supervisor also hides its
child window and does not forward child output to logs.

The supervisor persists only process/status metadata in `live/supervisor.json`
using the private execution store. An unexpected child exit is restarted at
most three times, 30 seconds apart. Missing startup heartbeat after two minutes
or heartbeat older than seven minutes terminates and restarts the child. The
longer running threshold accommodates the complete five-minute collection
window. The Task Scheduler adds at most three one-minute host restarts. An
exhausted restart budget is a failure, not successful collection. Cross-process
store locks prevent a second host/daemon from collecting simultaneously.

The user must remain logged on; a locked workstation is still logged on. A
powered-off computer cannot execute the task. Wake from standby/hibernation
depends on Windows, firmware and power settings; the installer does not change
those policies. A start after the observation window records the miss rather
than fabricating a 14:00 observation. Future scheduled observations still require
separate operational verification.

Microsoft references:
- [Trigger time and explicit UTC offset](https://learn.microsoft.com/en-us/windows/win32/taskschd/trigger-startboundary)
- [Task registration](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask)
- [Task settings and restart controls](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)
