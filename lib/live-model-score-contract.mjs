// A-v1 uses a bounded weighted subtotal (0..100), bonus (0 or 10) and
// penalties (0..30), with no final clamp. The other v1 models are bounded.
export function liveScoreBounds(version) {
  if (version === "A-v1") return [-30, 110];
  if (["B-v1", "C-v1", "D-v1"].includes(version)) return [0, 100];
  return null;
}
export function validLiveScore(version, value) {
  const range = liveScoreBounds(version);
  return !!range && Number.isFinite(value) && value >= range[0] && value <= range[1];
}
