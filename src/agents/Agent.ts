import { Message, MsgType } from "../messages/types";
import { Kernel } from "../kernel/Kernel";

export abstract class Agent {
  id: number;
  name: string;
  kernel!: Kernel;

  constructor(id: number, name?: string) {
    this.id = id;
    this.name = name ?? `Agent#${id}`;
  }

  attachKernel(k: Kernel) {
    this.kernel = k;
  }

  kernelStarting(_t: number) {}
  kernelStopping() {}

  receive(_t: number, _msg: Message) {}
  wakeup(_t: number) {}

  protected send(to: number, type: MsgType, body?: any, delayNs = 0) {
    this.kernel.send(this.id, to, type, body, delayNs);
  }
  protected setWakeup(atNs: number) {
    this.kernel.wakeup(this.id, atNs);
  }
}
