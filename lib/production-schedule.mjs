// Nominal GitHub trigger times, not a promise that a runner starts on time.
// Keep in sync with daily-production.yml and the LIVE prewarm workflow.
export function nextProductionSchedule(layer, now = new Date()) {
  const slots = layer === "LIVE" ? [[5, 15, [1, 2, 3, 4, 5]]] : [
    [23, 23, [0, 1, 2, 3, 4]],
    ...[0, 1, 2, 3, 4].map((hour) => [hour, 23, [1, 2, 3, 4, 5]]),
    [9, 47, [1, 2, 3, 4, 5]], ...[11, 13, 15, 17].map((hour) => [hour, 17, [1, 2, 3, 4, 5]]),
  ];
  const candidates = [];
  for (let offset = 0; offset < 8; offset += 1) {
    const date = new Date(now); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() + offset);
    for (const [hour, minute, weekdays] of slots) {
      if (!weekdays.includes(date.getUTCDay())) continue;
      const candidate = new Date(date); candidate.setUTCHours(hour, minute);
      if (candidate > now) candidates.push(candidate.toISOString());
    }
  }
  return candidates.sort()[0] ?? null;
}
