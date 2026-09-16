export function imageLayerForResource(name: string): number {
  const upper = name.toUpperCase();
  if (/^(KURO|SIRO)$/.test(upper)) return 0;
  if (/^(BG|FG|DAY|KDAY|AIRLOGO|KEYLOGO|S_TT_BG)/.test(upper)) return 0;
  // AIR's CGxx resources are transparent standing-character sprites.
  return 1;
}
