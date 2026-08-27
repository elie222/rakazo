export function avatarIdentitySeed(identity: string): number {
  let hash = 0;
  for (let index = 0; index < identity.length; index++) {
    hash = (hash << 5) - hash + identity.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function organicAvatarPath(seed: number, phaseOffset = 0): string {
  const pointCount = 12;
  const phase = ((seed % 360) * Math.PI) / 180 + phaseOffset;
  const family = (seed + 1) % 4;
  const lobes = [2, 3, 4, 5][family] ?? 4;
  const amplitude = [0.045, 0.14, 0.09, 0.025][family] ?? 0.09;
  const points = Array.from({ length: pointCount }, (_, index) => {
    const angle = (index / pointCount) * Math.PI * 2;
    const radius =
      50 * (1 + amplitude * Math.sin(angle * lobes + phase) + 0.025 * Math.sin(angle * 2 - phase));
    return {
      x: Math.cos(angle) * radius * 1.08,
      y: Math.sin(angle) * radius * 0.82,
    };
  });
  const round = (value: number) => Math.round(value * 100) / 100;
  const first = points[0]!;
  let path = `M${round(first.x)} ${round(first.y)}`;
  for (let index = 0; index < pointCount; index++) {
    const before = points[(index - 1 + pointCount) % pointCount]!;
    const current = points[index]!;
    const next = points[(index + 1) % pointCount]!;
    const after = points[(index + 2) % pointCount]!;
    path += `C${round(current.x + (next.x - before.x) / 6)} ${round(current.y + (next.y - before.y) / 6)} ${round(next.x - (after.x - current.x) / 6)} ${round(next.y - (after.y - current.y) / 6)} ${round(next.x)} ${round(next.y)}`;
  }
  return `${path}Z`;
}
