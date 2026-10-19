import { EventEmitter } from "node:events";

export interface BusEvent {
  seq: number;
  type: string;
  data: unknown;
  at: number;
}

/**
 * In-process pub/sub for SSE. Keeps a short ring buffer so a reconnecting client
 * can replay what it missed via Last-Event-ID; if the gap is too large the client
 * is told to resync from the REST snapshot.
 */
export class EventBus {
  private emitter = new EventEmitter();
  private ring: BusEvent[] = [];
  private seq = 0;
  readonly epoch = Date.now().toString(36);

  constructor(private capacity = 2000) {
    this.emitter.setMaxListeners(200);
  }

  publish(type: string, data: unknown) {
    const ev: BusEvent = { seq: ++this.seq, type, data, at: Date.now() };
    this.ring.push(ev);
    if (this.ring.length > this.capacity) this.ring.splice(0, this.ring.length - this.capacity);
    this.emitter.emit("event", ev);
  }

  subscribe(fn: (ev: BusEvent) => void) {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }

  /** Events after `seq`, or null when they are no longer buffered (client must resync). */
  since(seq: number): BusEvent[] | null {
    if (seq >= this.seq) return [];
    const first = this.ring[0];
    if (!first || first.seq > seq + 1) return null;
    return this.ring.filter((e) => e.seq > seq);
  }

  get lastSeq() {
    return this.seq;
  }
}
