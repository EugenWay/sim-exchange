// src/util/rng.ts
import seedrandom, { PRNG } from "seedrandom";

export class RNG {
  private r: PRNG;

  constructor(seed = "seed-42") {
    this.r = seedrandom(seed);
  }

  uniform(): number {
    return this.r.quick(); // [0,1)
  }

  int(min: number, max: number): number {
    // целое на [min, max]
    return Math.floor(min + this.uniform() * (max - min + 1));
  }
}
