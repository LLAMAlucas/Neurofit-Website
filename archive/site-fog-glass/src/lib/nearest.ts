/**
 * The k nearest points to each query, by a uniform grid. PURE.
 *
 * Used once at load to tie each skeleton grain to the body particles around
 * it: 6k queries into 71k points is 430M distance checks brute force, and a few
 * hundred thousand this way.
 */
export function nearestK(points: Float32Array, queries: Float32Array, k: number, cell = 0.04): Int32Array {
  const n = Math.floor(points.length / 3);
  const q = Math.floor(queries.length / 3);
  const out = new Int32Array(q * k).fill(-1);
  if (n === 0 || k <= 0) return out;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 3], y = points[i * 3 + 1], z = points[i * 3 + 2];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const nx = Math.max(1, Math.ceil((maxX - minX) / cell) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / cell) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / cell) + 1);
  const cellOf = (v: number, lo: number, size: number) => Math.min(size - 1, Math.max(0, Math.floor((v - lo) / cell)));

  // Counting sort of the points into cells: `start[c]…start[c+1]` in `order`.
  const cells = nx * ny * nz;
  const start = new Int32Array(cells + 1);
  const home = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c =
      (cellOf(points[i * 3 + 2], minZ, nz) * ny + cellOf(points[i * 3 + 1], minY, ny)) * nx +
      cellOf(points[i * 3], minX, nx);
    home[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const fill = start.slice(0, cells);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[home[i]]++] = i;

  const bestD = new Float64Array(k);
  const bestI = new Int32Array(k);
  for (let j = 0; j < q; j++) {
    const x = queries[j * 3], y = queries[j * 3 + 1], z = queries[j * 3 + 2];
    const cx = cellOf(x, minX, nx), cy = cellOf(y, minY, ny), cz = cellOf(z, minZ, nz);
    bestD.fill(Infinity);
    bestI.fill(-1);
    // Grow the search shell by shell. Stop once k are found and the next shell
    // can't hold anything nearer than the k-th: its nearest possible point is
    // at least `r · cell` away (from the query's own cell, outward).
    for (let r = 0; ; r++) {
      for (let dz = -r; dz <= r; dz++) {
        const zz = cz + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -r; dy <= r; dy++) {
          const yy = cy + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -r; dx <= r; dx++) {
            // Only the shell: the inside was searched at smaller r.
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const xx = cx + dx;
            if (xx < 0 || xx >= nx) continue;
            const c = (zz * ny + yy) * nx + xx;
            for (let s = start[c]; s < start[c + 1]; s++) {
              const i = order[s];
              const ddx = points[i * 3] - x, ddy = points[i * 3 + 1] - y, ddz = points[i * 3 + 2] - z;
              const d = ddx * ddx + ddy * ddy + ddz * ddz;
              if (d >= bestD[k - 1]) continue;
              let m = k - 1;
              while (m > 0 && bestD[m - 1] > d) {
                bestD[m] = bestD[m - 1];
                bestI[m] = bestI[m - 1];
                m--;
              }
              bestD[m] = d;
              bestI[m] = i;
            }
          }
        }
      }
      const reach = r * cell;
      const covered = r >= Math.max(nx, ny, nz);
      if (covered || (bestI[k - 1] >= 0 && reach * reach >= bestD[k - 1])) break;
    }
    out.set(bestI, j * k);
  }
  return out;
}
