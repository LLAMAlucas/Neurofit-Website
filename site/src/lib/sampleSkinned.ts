/**
 * Points scattered over a skinned mesh's surface, each carrying its skinning.
 *
 * PURE — no three, no DOM. Takes the raw bind-pose arrays of one primitive and
 * returns flat typed arrays ready to become buffer attributes.
 *
 * The points are what the body is drawn with, so they have to move with the
 * skeleton exactly as the mesh would. A point inside a triangle does not belong
 * to one vertex: it takes the three vertices' bone weights blended by its
 * barycentric coordinates. Up to twelve (bone, weight) pairs can land on a
 * point that way; the four heaviest are kept and renormalised, because four is
 * what the shader skins with.
 *
 * Sampling is area-weighted so density is even across the body — sampling per
 * triangle would crowd the hands and face, where the topology is finest.
 *
 * VOLUME. A surface-only cloud reads as a hollow shell once the points thin out
 * enough to see between them. So a share of the points can be pulled INSIDE:
 * each takes a surface sample and moves it toward the axis of the bone that
 * owns it most (its heaviest weight), landing somewhere between skin and bone.
 * That stays inside the body for any limb whose cross-section is roughly convex
 * around its bone — every limb, the neck and the trunk — and it keeps the
 * surface sample's skin weights, which is right: a point halfway into a thigh
 * moves with the thigh.
 */

export type SkinnedSurface = {
  /** xyz per vertex, bind pose. */
  positions: ArrayLike<number>;
  /** xyz per vertex. */
  normals: ArrayLike<number>;
  /** Three per triangle. */
  indices: ArrayLike<number>;
  /** Four bone indices per vertex. */
  skinIndex: ArrayLike<number>;
  /** Four weights per vertex, already de-normalised to 0…1. */
  skinWeight: ArrayLike<number>;
};

export type SampledPoints = {
  count: number;
  position: Float32Array;
  normal: Float32Array;
  /** Four per point. Float, because that is what a vertex attribute reads. */
  skinIndex: Float32Array;
  /** Four per point, summing to 1. */
  skinWeight: Float32Array;
  /** One per point in [0, 1) — per-particle variation in the shader. */
  seed: Float32Array;
  /** One per point: 0 on the surface, rising toward 1 at the bone axis. */
  depth: Float32Array;
};

export type VolumeOptions = {
  /**
   * Bind-pose axis of every bone, in the same space as `positions`: six floats
   * per bone (start xyz, end xyz), indexed like the skin indices.
   */
  axes: ArrayLike<number>;
  /** Share of the points placed inside the body, 0…1. */
  interior: number;
};

/**
 * EVEN spacing (2026-10, the black look): white-noise sampling clumps and leaves gaps, which on
 * black reads as static. With this, the skin points are picked from ~3× as many candidates by
 * dart throwing — a candidate is kept only if no kept point is within the spacing radius — level
 * by level, so the first `levels[0]` points are already evenly spread at the coarse spacing (the
 * phone tier draws that prefix), the next up to `levels[1]` fill in between at a finer one, and
 * so on. `vertexDensity` asks for more points where it's higher (the face and hands — what reads
 * as human), with the radius shrinking as 1/√density there.
 */
export type EvenOptions = {
  /** Cumulative SKIN-point counts, ascending — one per quality tier's prefix. */
  levels: number[];
  /** Per vertex, 1 = average density. */
  vertexDensity?: ArrayLike<number>;
  /** Candidates per point. */
  oversample?: number;
};

/** Spacing radius as a share of the mean spacing: a dart-throwing pass fills to about here. */
const EVEN_FILL = 0.72;
const HASH_SIZE = 1 << 20;

/** Small seeded PRNG, so the same seed always scatters the same body. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleSkinned(
  surface: SkinnedSurface,
  count: number,
  seed = 1,
  volume?: VolumeOptions,
  even?: EvenOptions,
): SampledPoints {
  const { positions: P, normals: N, indices: I, skinIndex: SI, skinWeight: SW } = surface;
  const triCount = Math.floor(I.length / 3);
  const evenPick = even ? pickEven(surface, count - (volume ? Math.round(count * Math.min(1, Math.max(0, volume.interior))) : 0), seed, even) : null;
  let nextEven = 0;

  // Cumulative triangle area, for picking a triangle in proportion to its size.
  const cdf = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3] * 3;
    const b = I[t * 3 + 1] * 3;
    const c = I[t * 3 + 2] * 3;
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
    const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    total += Math.hypot(cx, cy, cz) * 0.5;
    cdf[t] = total;
  }

  const out: SampledPoints = {
    count,
    position: new Float32Array(count * 3),
    normal: new Float32Array(count * 3),
    skinIndex: new Float32Array(count * 4),
    skinWeight: new Float32Array(count * 4),
    seed: new Float32Array(count),
    depth: new Float32Array(count),
  };
  // Which points are pulled inside: `inside` of them, spread evenly through the
  // order rather than all at the end, so ANY prefix of the output has the same
  // skin-to-fill mix as the whole. A slower device draws fewer particles by
  // drawing a prefix; with the fill at the end, that prefix was a hollow shell.
  const inside = volume ? Math.round(count * Math.min(1, Math.max(0, volume.interior))) : 0;
  const isInterior = (i: number) => Math.floor(((i + 1) * inside) / count) > Math.floor((i * inside) / count);

  const rand = mulberry32(seed);
  // Scratch for the up-to-12 (bone, weight) candidates of one point.
  const bones = new Int32Array(12);
  const weights = new Float64Array(12);
  const v = [0, 0, 0];
  const bary = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    let lo: number;
    let s: number;
    let r2: number;
    if (evenPick && !(volume && isInterior(i)) && nextEven < evenPick.tri.length) {
      // The next evenly spaced skin point, in the order it was picked.
      const k = nextEven++;
      lo = evenPick.tri[k];
      s = evenPick.s[k];
      r2 = evenPick.r2[k];
    } else {
      // Binary search the CDF.
      const r = rand() * total;
      lo = 0;
      let hi = triCount - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      // Uniform point in the triangle (square-root warp, so it doesn't bunch at a corner).
      s = Math.sqrt(rand());
      r2 = rand();
    }
    v[0] = I[lo * 3];
    v[1] = I[lo * 3 + 1];
    v[2] = I[lo * 3 + 2];
    bary[0] = 1 - s;
    bary[1] = s * (1 - r2);
    bary[2] = s * r2;

    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 3; k++) {
      const o = v[k] * 3;
      px += P[o] * bary[k];
      py += P[o + 1] * bary[k];
      pz += P[o + 2] * bary[k];
      nx += N[o] * bary[k];
      ny += N[o + 1] * bary[k];
      nz += N[o + 2] * bary[k];
    }
    const nl = Math.hypot(nx, ny, nz) || 1;
    out.position[i * 3] = px;
    out.position[i * 3 + 1] = py;
    out.position[i * 3 + 2] = pz;
    out.normal[i * 3] = nx / nl;
    out.normal[i * 3 + 1] = ny / nl;
    out.normal[i * 3 + 2] = nz / nl;

    // Merge the three vertices' influences, then keep the heaviest four.
    let n = 0;
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 4; c++) {
        const w = SW[v[k] * 4 + c] * bary[k];
        if (w <= 0) continue;
        const b = SI[v[k] * 4 + c];
        let j = 0;
        while (j < n && bones[j] !== b) j++;
        if (j === n) {
          bones[n] = b;
          weights[n] = 0;
          n++;
        }
        weights[j] += w;
      }
    }
    // Partial selection sort: four passes is cheaper than sorting twelve.
    let sum = 0;
    for (let c = 0; c < 4 && c < n; c++) {
      let best = c;
      for (let j = c + 1; j < n; j++) if (weights[j] > weights[best]) best = j;
      const tb = bones[c], tw = weights[c];
      bones[c] = bones[best];
      weights[c] = weights[best];
      bones[best] = tb;
      weights[best] = tw;
      out.skinIndex[i * 4 + c] = bones[c];
      out.skinWeight[i * 4 + c] = weights[c];
      sum += weights[c];
    }
    if (sum > 0) for (let c = 0; c < 4; c++) out.skinWeight[i * 4 + c] /= sum;
    else out.skinWeight[i * 4] = 1; // unskinned vertex: follow bone 0 rather than vanish

    out.seed[i] = rand();

    if (volume && isInterior(i) && n > 0) {
      // Nearest point on the owning bone's axis.
      const ax = volume.axes;
      const o = out.skinIndex[i * 4] * 6;
      const ax0 = ax[o], ay0 = ax[o + 1], az0 = ax[o + 2];
      const dx = ax[o + 3] - ax0, dy = ax[o + 4] - ay0, dz = ax[o + 5] - az0;
      const len2 = dx * dx + dy * dy + dz * dz;
      const u = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax0) * dx + (py - ay0) * dy + (pz - az0) * dz) / len2)) : 0;
      const cx = ax0 + dx * u, cy = ay0 + dy * u, cz = az0 + dz * u;
      // Uniform through the cross-section, not bunched on the axis: in a disc,
      // the share of area within radius r grows as r², so the radius is the
      // square root of a uniform draw.
      const t = 1 - Math.sqrt(rand());
      out.position[i * 3] = px + (cx - px) * t;
      out.position[i * 3 + 1] = py + (cy - py) * t;
      out.position[i * 3 + 2] = pz + (cz - pz) * t;
      out.depth[i] = t;
    }
  }

  return out;
}

/** The evenly spaced skin points, as (triangle, √u, v) in pick order — see EvenOptions. */
function pickEven(surface: SkinnedSurface, want: number, seed: number, even: EvenOptions): { tri: Int32Array; s: Float32Array; r2: Float32Array } {
  const { positions: P, indices: I } = surface;
  const D = even.vertexDensity;
  const triCount = Math.floor(I.length / 3);
  // Candidates are drawn by area × density, from their own stream so the rest of the body is
  // the same whichever way its skin was spaced.
  const cdf = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
    const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) * 0.5;
    const d = D ? (D[a] + D[b] + D[c]) / 3 : 1;
    total += area * d;
    cdf[t] = total;
  }
  const M = Math.max(want, Math.ceil(want * (even.oversample ?? 3)));
  const rand = mulberry32(seed * 7919 + 17);
  const tri = new Int32Array(M);
  const cs = new Float32Array(M);
  const cr = new Float32Array(M);
  const pos = new Float32Array(M * 3);
  const dens = new Float32Array(M);
  for (let j = 0; j < M; j++) {
    const r = rand() * total;
    let lo = 0, hi = triCount - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cdf[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const s = Math.sqrt(rand());
    const r2 = rand();
    const a = I[lo * 3], b = I[lo * 3 + 1], c = I[lo * 3 + 2];
    const w0 = 1 - s, w1 = s * (1 - r2), w2 = s * r2;
    for (let k = 0; k < 3; k++) pos[j * 3 + k] = P[a * 3 + k] * w0 + P[b * 3 + k] * w1 + P[c * 3 + k] * w2;
    tri[j] = lo;
    cs[j] = s;
    cr[j] = r2;
    dens[j] = D ? D[a] * w0 + D[b] * w1 + D[c] * w2 : 1;
  }

  // Dart throwing, level by level, through a spatial hash of what's been kept.
  const picked = new Int32Array(want);
  let n = 0;
  const taken = new Uint8Array(M);
  const head = new Int32Array(HASH_SIZE);
  const next = new Int32Array(M);
  let cell = 1;
  const key = (x: number, y: number, z: number) =>
    ((Math.floor(x / cell) * 73856093) ^ (Math.floor(y / cell) * 19349663) ^ (Math.floor(z / cell) * 83492791)) & (HASH_SIZE - 1);
  const rehash = () => {
    head.fill(-1);
    for (let k = 0; k < n; k++) {
      const j = picked[k];
      const h = key(pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]);
      next[j] = head[h];
      head[h] = j;
    }
  };
  const levels = [...even.levels.map((l) => Math.min(want, Math.max(1, Math.round(l)))), want].sort((a, b) => a - b);
  for (const target of levels) {
    let r = EVEN_FILL * Math.sqrt(total / target);
    for (let tries = 0; n < target && tries < 24; tries++, r *= 0.93) {
      cell = r;
      rehash();
      for (let j = 0; j < M && n < target; j++) {
        if (taken[j]) continue;
        const x = pos[j * 3], y = pos[j * 3 + 1], z = pos[j * 3 + 2];
        let free = true;
        for (let dx = -1; dx <= 1 && free; dx++)
          for (let dy = -1; dy <= 1 && free; dy++)
            for (let dz = -1; dz <= 1 && free; dz++) {
              for (let q = head[key(x + dx * cell, y + dy * cell, z + dz * cell)]; q >= 0; q = next[q]) {
                const rr = r / Math.sqrt(Math.max(dens[j], dens[q]));
                const ex = pos[q * 3] - x, ey = pos[q * 3 + 1] - y, ez = pos[q * 3 + 2] - z;
                if (ex * ex + ey * ey + ez * ez < rr * rr) {
                  free = false;
                  break;
                }
              }
            }
        if (!free) continue;
        taken[j] = 1;
        picked[n++] = j;
        const h = key(x, y, z);
        next[j] = head[h];
        head[h] = j;
      }
    }
  }
  // Out of candidates (not expected): the rest in their drawn order.
  for (let j = 0; j < M && n < want; j++) if (!taken[j]) picked[n++] = j;

  const out = { tri: new Int32Array(n), s: new Float32Array(n), r2: new Float32Array(n) };
  for (let k = 0; k < n; k++) {
    const j = picked[k];
    out.tri[k] = tri[j];
    out.s[k] = cs[j];
    out.r2[k] = cr[j];
  }
  return out;
}
