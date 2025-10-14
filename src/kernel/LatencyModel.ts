export interface LatencyModel {
  delayNs(from: number, to: number): number;
  computeNs?(agentId: number): number;
}

export class TwoStageRpcLatency implements LatencyModel {
  constructor(
    private getExchangeId: () => number,
    private rpcUpMs = 200,
    private rpcDownMs = 200,
    private computeMs = 300,
    private downJitterMs = 0,
    private rnd: () => number = Math.random // TBD
  ) {}

  delayNs(from: number, to: number): number {
    const exch = this.getExchangeId();
    if (to === exch && from !== exch) return this.ms(this.rpcUpMs);
    if (from === exch && to !== exch) return this.ms(this.rpcDownMs + this.jitter());
    return this.ms(this.rpcUpMs);
  }

  computeNs(_agentId: number): number {
    return this.ms(this.computeMs);
  }

  private jitter() {
    if (this.downJitterMs <= 0) return 0;
    // [-downJitterMs, +downJitterMs]
    const r = (this.rnd() * 2 - 1) * this.downJitterMs;
    return Math.round(r);
  }

  private ms(x: number) {
    return x * 1_000_000;
  }
}
