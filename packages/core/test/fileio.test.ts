import { existsSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { CustodyStore, PostRenameError, createNodeFileIo, createOutboundProcessor } from "../src/index.js";
import { OUT, decision, tmpCustodyPath } from "./helpers/util.js";

/** Writes at most `max` bytes per call, like a short write on a full or interrupted disk. */
const shortWriter = (max: number) => (fd: number, buf: Uint8Array, off: number, len: number) =>
  writeSync(fd, buf, off, Math.min(len, max));

describe("file io", () => {
  it("appendDurable loops over short writes until every byte is written", () => {
    const path = tmpCustodyPath();
    const io = createNodeFileIo({ write: shortWriter(3) });
    io.appendDurable(path, "hello, durable world\n");
    expect(readFileSync(path, "utf8")).toBe("hello, durable world\n");
  });

  it("appendDurable throws when the writer makes no progress", () => {
    const path = tmpCustodyPath();
    const io = createNodeFileIo({ write: () => 0 });
    expect(() => io.appendDurable(path, "x\n")).toThrow(/short write/);
  });

  it("a custody append over short writes is acknowledged only when complete and replays intact", () => {
    const path = tmpCustodyPath();
    const store = CustodyStore.open(path, { io: createNodeFileIo({ write: shortWriter(7) }) });
    const res = createOutboundProcessor({ custody: store, outboundToken: OUT }).process({
      authorization: `Bearer ${OUT}`,
      rawBody: JSON.stringify(decision("d1")),
    });
    expect(res.status).toBe(200);
    expect(CustodyStore.open(path).get("d1")?.envelope.body).toContain("rollout");
  });

  it("a stalled writer is never acknowledged and leaves no partial line behind", () => {
    const path = tmpCustodyPath();
    let calls = 0;
    const io = createNodeFileIo({ write: (fd, b, o, l) => (calls++ === 0 ? writeSync(fd, b, o, 10) : 0) });
    const store = CustodyStore.open(path, { io });
    const res = createOutboundProcessor({ custody: store, outboundToken: OUT }).process({
      authorization: `Bearer ${OUT}`,
      rawBody: JSON.stringify(decision("d1")),
    });
    expect(res.status).toBe(503);
    expect(readFileSync(path, "utf8")).toBe("");
    expect(CustodyStore.open(path).list()).toHaveLength(0);
  });

  it("writeAtomic never renames after a short write: the old ledger survives", () => {
    const path = tmpCustodyPath();
    const store = CustodyStore.open(path);
    store.accept(decision("d1"), "{}");
    const before = readFileSync(path, "utf8");
    let n = 0;
    const io = createNodeFileIo({ write: (fd, b, o, l) => (n++ < 1 ? writeSync(fd, b, o, 5) : 0) });
    expect(() => io.writeAtomic(path, "replacement ledger that is long\n")).toThrow(/short write/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("fsyncs the parent directory when it creates the custody file, and fails closed if that fails", () => {
    const path = tmpCustodyPath();
    const synced: string[] = [];
    const io = createNodeFileIo({ syncDir: (d) => void synced.push(d) });
    io.appendDurable(path, "a\n");
    io.appendDurable(path, "b\n");
    expect(synced).toEqual([dirname(path)]); // only on creation

    const path2 = tmpCustodyPath();
    const bad = createNodeFileIo({ syncDir: () => { throw new Error("EIO"); } });
    const store = CustodyStore.open(path2, { io: bad });
    const res = createOutboundProcessor({ custody: store, outboundToken: OUT }).process({
      authorization: `Bearer ${OUT}`,
      rawBody: JSON.stringify(decision("d1")),
    });
    expect(res.status).toBe(503);
  });

  it("a directory fsync failure after the rename is reported, not swallowed", () => {
    const path = tmpCustodyPath();
    CustodyStore.open(path).accept(decision("d1"), "{}");
    const io = createNodeFileIo({ syncDir: () => { throw new Error("EIO"); } });
    expect(() => io.writeAtomic(path, "x\n")).toThrow(PostRenameError);
  });

  it("the store goes read-only (503) after a post-rename failure instead of continuing", () => {
    const path = tmpCustodyPath();
    const base = createNodeFileIo();
    let failRename = true;
    const io = { ...base, writeAtomic(p: string, d: string) { base.writeAtomic(p, d); if (failRename) throw new PostRenameError("dir fsync failed"); } };
    const store = CustodyStore.open(path, { io });
    store.accept(decision("d1"), "{}");
    expect(() => store.compact()).toThrow(PostRenameError);
    failRename = false;
    const res = createOutboundProcessor({ custody: store, outboundToken: OUT }).process({
      authorization: `Bearer ${OUT}`,
      rawBody: JSON.stringify(decision("d2")),
    });
    expect(res.status).toBe(503);
  });

  it("a failed compaction before the rename leaves the store usable", () => {
    const path = tmpCustodyPath();
    const base = createNodeFileIo();
    const io = { ...base, writeAtomic() { throw new Error("short write"); } };
    const store = CustodyStore.open(path, { io });
    store.accept(decision("d1"), "{}");
    expect(() => store.compact()).toThrow();
    expect(store.accept(decision("d2"), "{}").kind).toBe("accepted");
    expect(existsSync(path)).toBe(true);
  });

  describe("fsync on open", () => {
    it("fsyncs the existing ledger and its directory before serving, so a duplicate ack is durable", () => {
      const path = tmpCustodyPath();
      CustodyStore.open(path).accept(decision("d1"), "{}");
      const calls: string[] = [];
      const base = createNodeFileIo();
      const io = { ...base, syncFile: (p: string) => { calls.push("file"); base.syncFile(p); }, syncDir: (p: string) => { calls.push("dir"); base.syncDir(p); } };
      const store = CustodyStore.open(path, { io });
      expect(calls).toEqual(["file", "dir"]);
      expect(store.accept(decision("d1"), "{}").kind).toBe("duplicate");
    });

    it("refuses to open when the sync on open fails", () => {
      const path = tmpCustodyPath();
      CustodyStore.open(path).accept(decision("d1"), "{}");
      const base = createNodeFileIo();
      const io = { ...base, syncFile() { throw new Error("EIO"); } };
      expect(() => CustodyStore.open(path, { io })).toThrow(/EIO/);
    });

    it("does not need a file that does not exist yet", () => {
      expect(() => CustodyStore.open(tmpCustodyPath())).not.toThrow();
    });
  });
});

void writeFileSync;
