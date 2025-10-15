export class PriorityQueue<T extends { at: number }> {
  private a: T[] = [];
  push(x: T) {
    this.a.push(x);
    this.a.sort((p, q) => p.at - q.at); // TBD use min-heap
  }
  pop(): T | undefined {
    return this.a.shift();
  }
  peek(): T | undefined {
    return this.a[0];
  }
  get length() {
    return this.a.length;
  }
  clear() {
    this.a = [];
  }
}
