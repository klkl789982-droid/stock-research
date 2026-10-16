import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const absolute = (value) => {
  if (typeof value !== "string" || !path.win32.isAbsolute(value) || /["\r\n\0]/u.test(value)) throw new Error("TASK_ABSOLUTE_WINDOWS_PATH_REQUIRED");
  return path.win32.resolve(value);
};
const quote = (value) => `"${value.replace(/(\\+)$/u, "$1$1")}"`;

export function buildWindowsTask({ root, nodePath, powershellPath, stateDir, userSid, date }) {
  root = absolute(root); nodePath = absolute(nodePath); powershellPath = absolute(powershellPath); stateDir = absolute(stateDir);
  if (!/^S-1-5-(?:\d+-)+\d+$/u.test(userSid ?? "") || !/^\d{4}-\d{2}-\d{2}$/u.test(date ?? "") || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) throw new Error("TASK_IDENTITY_OR_DATE_INVALID");
  if (path.win32.basename(nodePath).toLowerCase() !== "node.exe" || path.win32.basename(powershellPath).toLowerCase() !== "powershell.exe") throw new Error("TASK_EXECUTABLE_INVALID");
  const normalizedRoot = root.toLowerCase(), normalizedState = stateDir.toLowerCase();
  if (normalizedState === normalizedRoot || normalizedState.startsWith(`${normalizedRoot}\\`) || stateDir === path.win32.parse(stateDir).root || stateDir.split("\\").some((part) => [".git", "public"].includes(part.toLowerCase()))) throw new Error("TASK_STATE_DIRECTORY_NOT_PRIVATE");
  const taskName = `TightBudget-Live-Executor-${userSid.split("-").at(-1)}`;
  const marker = `tight-budget-live-executor-managed-v1:${createHash("sha256").update(JSON.stringify({ root: normalizedRoot, stateDir: normalizedState, userSid })).digest("hex")}`;
  const launcher = path.win32.join(root, "infra", "live-executor", "launch-hidden.ps1");
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -File ${quote(launcher)} -NodePath ${quote(nodePath)} -StateDir ${quote(stateDir)}`;
  const document = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>${xml(userSid)}</Author><Description>${xml(marker)}</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>${xml(date)}T13:40:00+09:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(userSid)}</UserId></LogonTrigger>
  </Triggers>
  <Principals><Principal id="Owner"><UserId>${xml(userSid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Priority>7</Priority><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Owner"><Exec><Command>${xml(powershellPath)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>`;
  return { taskName, taskPath: "\\", marker, xml: document, scheduleKst: "13:40 daily + current-user logon", scheduledUtc: "04:40 daily", publicationEnabled: false, accountMode: "InteractiveToken", limitations: ["Requires the configured Windows user to remain logged on", "Powered-off machines cannot run; waking from sleep depends on OS/firmware power settings", "A missed 14:00 observation cannot be backfilled"] };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  try {
    console.log(JSON.stringify(buildWindowsTask({ root: option("root"), nodePath: option("node"), powershellPath: option("powershell"), stateDir: option("state-dir"), userSid: option("sid"), date: option("date") })));
  } catch { console.error("TASK_CONFIGURATION_INVALID"); process.exitCode = 1; }
}
