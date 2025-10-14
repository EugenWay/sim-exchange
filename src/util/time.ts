// src/util/time.ts
// простые хелперы времени в наносекундах (число)
export type Ns = number;

/** сейчас (unix) в наносекундах */
export function nowNs(): Ns {
  const ms = Date.now();
  return ms * 1_000_000;
}

/** перевод милли/секунд в наносекунды */
export function ns(v: number, unit: "ms" | "s" | "ns" = "ns"): Ns {
  if (unit === "ns") return v;
  if (unit === "ms") return v * 1_000_000;
  return v * 1_000_000_000; // seconds
}

/** now + duration(ms) → ns */
export function fromNow(ms: number): Ns {
  return nowNs() + ns(ms, "ms");
}
