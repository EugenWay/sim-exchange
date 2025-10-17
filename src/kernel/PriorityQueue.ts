export class PriorityQueue<T extends { at: number }> {
  private heap: T[] = [];

  push(x: T) {
    this.heap.push(x);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const root = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return root;
  }

  peek(): T | undefined {
    return this.heap[0];
  }

  get length() {
    return this.heap.length;
  }

  clear() {
    this.heap = [];
  }

  private bubbleUp(idx: number) {
    while (idx > 0) {
      const parentIdx = Math.floor((idx - 1) / 2);
      if (this.heap[idx]!.at >= this.heap[parentIdx]!.at) break;
      [this.heap[idx], this.heap[parentIdx]] = [this.heap[parentIdx]!, this.heap[idx]!];
      idx = parentIdx;
    }
  }

  private bubbleDown(idx: number) {
    const len = this.heap.length;
    while (true) {
      const leftIdx = 2 * idx + 1;
      const rightIdx = 2 * idx + 2;
      let smallest = idx;

      if (leftIdx < len && this.heap[leftIdx]!.at < this.heap[smallest]!.at) {
        smallest = leftIdx;
      }
      if (rightIdx < len && this.heap[rightIdx]!.at < this.heap[smallest]!.at) {
        smallest = rightIdx;
      }
      if (smallest === idx) break;

      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest]!, this.heap[idx]!];
      idx = smallest;
    }
  }
}
