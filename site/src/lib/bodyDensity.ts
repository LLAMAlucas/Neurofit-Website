/**
 * How densely each part of the body is sampled, by the bone that owns it most — PURE.
 *
 * Even, area-weighted sampling gives the face and hands about as many points as any other patch
 * of skin their size, which is few: and they are what reads as human. So they get more (the
 * sampler's EvenOptions.vertexDensity). Names are the model's Unreal-mannequin bones (Quaternius
 * base characters): head, neck_01, hand_l, thumb_01_l…pinky_03_r, foot_l, ball_l.
 */
export function densityForBone(name: string): number {
  const n = name.toLowerCase();
  if (/head|neck/.test(n)) return 2.4;
  if (/hand|thumb|index|middle|ring|pinky/.test(n)) return 2;
  if (/foot|ball|toe/.test(n)) return 1.2;
  return 1;
}
