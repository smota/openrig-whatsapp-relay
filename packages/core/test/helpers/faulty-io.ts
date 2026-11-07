import { nodeFileIo, type FileIo } from "../../src/index.js";
import { statSync } from "node:fs";

export class SimulatedCrash extends Error {
  constructor(where: string) {
    super(`simulated crash: ${where}`);
  }
}

export type Fault =
  | "append-before-write" // dies before any byte is written
  | "append-torn" // writes half the line, never fsyncs
  | "append-after-write-before-fsync" // writes the whole line, dies before fsync
  | "append-after-fsync" // line is durable, dies before the caller learns it
  | "atomic-before-rename" // temp file written and synced, dies before rename
  | "atomic-after-rename"; // rename done, dies before the directory fsync

/**
 * Real filesystem plus a one-shot fault. It also models power loss: `powerLoss()` truncates the
 * file back to the last length that was fsync'd, which is what an unsynced write would lose.
 */
export class FaultyIo implements FileIo {
  private fault: Fault | undefined;
  private syncedSize = new Map<string, number>();
  failTruncate = false;
  /** After a simulated crash the "process" is dead: nothing else it tries touches the disk. */
  private dead = false;

  inject(fault: Fault): void {
    this.fault = fault;
  }

  private take(f: Fault): boolean {
    if (this.fault !== f) return false;
    this.fault = undefined;
    this.dead = true;
    return true;
  }

  private alive(): void {
    if (this.dead) throw new SimulatedCrash("process already dead");
  }

  /** Bring the process back after a simulated crash (a new boot). */
  restart(): void {
    this.dead = false;
  }

  readText(path: string): string | null {
    this.alive();
    return nodeFileIo.readText(path);
  }

  private known(path: string): number {
    if (this.syncedSize.has(path)) return this.syncedSize.get(path) as number;
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  appendDurable(path: string, data: string): void {
    this.alive();
    const before = this.known(path);
    if (this.take("append-before-write")) throw new SimulatedCrash("before write");
    if (this.take("append-torn")) {
      this.syncedSize.set(path, before);
      nodeFileIo.appendDurable(path, data.slice(0, Math.floor(data.length / 2)));
      throw new SimulatedCrash("torn write");
    }
    if (this.take("append-after-write-before-fsync")) {
      this.syncedSize.set(path, before);
      nodeFileIo.appendDurable(path, data);
      throw new SimulatedCrash("between write and fsync");
    }
    nodeFileIo.appendDurable(path, data);
    this.syncedSize.set(path, statSync(path).size);
    if (this.take("append-after-fsync")) throw new SimulatedCrash("after fsync");
  }

  writeAtomic(path: string, data: string): void {
    this.alive();
    if (this.take("atomic-before-rename")) {
      nodeFileIo.appendDurable(`${path}.tmp`, data);
      throw new SimulatedCrash("before rename");
    }
    nodeFileIo.writeAtomic(path, data);
    this.syncedSize.set(path, statSync(path).size);
    if (this.take("atomic-after-rename")) throw new SimulatedCrash("after rename");
  }

  truncate(path: string, size: number): void {
    this.alive();
    if (this.failTruncate) throw new Error("truncate failed");
    nodeFileIo.truncate(path, size);
    this.syncedSize.set(path, size);
  }

  syncFile(path: string): void {
    this.alive();
    nodeFileIo.syncFile(path);
  }

  syncDir(path: string): void {
    this.alive();
    nodeFileIo.syncDir(path);
  }

  remove(path: string): void {
    this.alive();
    nodeFileIo.remove(path);
  }

  /** Lose everything written after the last fsync, as a power cut would. */
  powerLoss(path: string): void {
    const synced = this.syncedSize.get(path);
    if (synced !== undefined) nodeFileIo.truncate(path, synced);
  }
}
