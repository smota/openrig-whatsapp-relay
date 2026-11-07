import { computeCanonicalSha256, sha256Hex } from "./canonical.js";
import { PostRenameError, nodeFileIo, type FileIo } from "./fileio.js";
import { dirname } from "node:path";
import type { RelayOutboundEnvelope } from "./types.js";

/**
 * Durable custody and correlation store: an fsync'd, append-only JSONL file.
 *
 * Every state change is one line, appended and fsync'd BEFORE the in-memory state changes and
 * before the caller acknowledges anything. A torn final line (crash mid-append) is discarded on
 * open: it was never acknowledged. A damaged line anywhere else fails closed.
 */

export type DeliveryStatus =
  | "pending" // in custody, not yet handed to the transport
  | "sending" // a send attempt was recorded; outcome not yet recorded
  | "uncertain" // "sending" found after a restart: outcome unknown, never resent automatically
  | "sent" // transport accepted it; waiting for a human reply
  | "answered" // at least one reply was accepted by the daemon and nothing is left open
  | "closed" // nothing to answer (update) or the question went stale
  | "failed"; // retries exhausted or permanent transport failure

export type CorrelationStatus = "open" | "answered" | "closed";

export interface CorrelationEntry {
  /** Short id shown in the `Ref` footer (delivery level) or next to a digest item. */
  id: string;
  /** `null` for the delivery-level entry, otherwise the index into `envelope.items`. */
  itemIndex: number | null;
  /** The opaque daemon token, copied verbatim; null when nothing can be answered. */
  replyRef: string | null;
  status: CorrelationStatus;
  eventId?: string;
  reason?: string;
}

export interface CustodyRecord {
  deliveryId: string;
  payloadSha256: string;
  rawBytesSha256: string;
  receivedAt: string;
  envelope: RelayOutboundEnvelope;
  correlations: CorrelationEntry[];
  status: DeliveryStatus;
  attempts: number;
  messageId?: string;
  sentAt?: string;
  lastError?: string;
  /** When the delivery stopped needing anything (answered or closed); drives retirement. */
  settledAt?: string;
}

export type AcceptResult =
  | { kind: "accepted"; record: CustodyRecord }
  | { kind: "duplicate"; record: Pick<CustodyRecord, "deliveryId" | "payloadSha256"> }
  | { kind: "conflict"; record: Pick<CustodyRecord, "deliveryId" | "payloadSha256"> };

export interface CustodyStats {
  total: number;
  byStatus: Record<DeliveryStatus, number>;
  /** Age in ms of the oldest record still pending or uncertain, or null. */
  oldestUnsentAgeMs: number | null;
}

export class CustodyCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustodyCorruptError";
  }
}

export class CustodyPoisonedError extends Error {
  constructor() {
    super("custody store is poisoned after an unrecoverable write failure; reopen it");
    this.name = "CustodyPoisonedError";
  }
}

export class CustodyFullError extends Error {
  constructor(readonly limit: number) {
    super(`custody holds ${limit} undelivered deliveries; refusing more until some are sent`);
    this.name = "CustodyFullError";
  }
}

export interface CustodyOptions {
  io?: FileIo;
  now?: () => Date;
  /** Compact when the file holds more than max(this, 2 x live entries) lines. Default 1000. */
  compactMinLines?: number;
  /** Back-pressure: refuse new deliveries while this many are pending, sending or uncertain. Default 10000. */
  maxPending?: number;
  /** Settled (answered/closed) deliveries older than this are retired at compaction. Default 7 days. */
  retainSettledMs?: number;
  /** Retired deliveries keep a dedup tombstone for this long. Default 30 days. */
  dedupWindowMs?: number;
  /** Upper bound on tombstones kept; the oldest go first. Default 100000. */
  maxTombstones?: number;
}

interface Tombstone {
  deliveryId: string;
  payloadSha256: string;
  /** Epoch ms when the delivery settled. */
  settledAt: number;
}

type Line =
  | { t: "accept"; at: string; deliveryId: string; payloadSha256: string; rawBytesSha256: string; envelope: RelayOutboundEnvelope; correlations: CorrelationEntry[] }
  | { t: "sending"; at: string; deliveryId: string }
  | { t: "retry"; at: string; deliveryId: string; reason?: string }
  | { t: "sent"; at: string; deliveryId: string; messageId: string }
  | { t: "failed"; at: string; deliveryId: string; reason: string }
  | { t: "requeue"; at: string; deliveryId: string }
  | { t: "corr"; at: string; deliveryId: string; correlationId: string; status: "answered" | "closed"; eventId?: string; reason?: string }
  | { t: "snapshot"; at: string; record: CustodyRecord }
  | { t: "tombstone"; at: string; deliveryId: string; payloadSha256: string; settledAt: number };

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function shortId(seed: string, length: number): string {
  const hex = sha256Hex(seed);
  let out = "";
  for (let i = 0; out.length < length; i++) {
    const byte = Number.parseInt(hex.slice((i * 2) % 62, ((i * 2) % 62) + 2), 16);
    out += ALPHABET[byte % 32];
  }
  return out;
}

function emptyCounts(): Record<DeliveryStatus, number> {
  return { pending: 0, sending: 0, uncertain: 0, sent: 0, answered: 0, closed: 0, failed: 0 };
}

export class CustodyStore {
  private readonly records = new Map<string, CustodyRecord>();
  private readonly order: string[] = [];
  private readonly byMessageId = new Map<string, string>();
  private readonly byCorrelation = new Map<string, { deliveryId: string; index: number }>();
  private readonly tombstones = new Map<string, Tombstone>();
  private size = 0;
  private lineCount = 0;
  private poisoned = false;

  private constructor(
    readonly path: string,
    private readonly io: FileIo,
    private readonly now: () => Date,
    private readonly compactMinLines: number,
    private readonly maxPending: number,
    private readonly retainSettledMs: number,
    private readonly dedupWindowMs: number,
    private readonly maxTombstones: number,
  ) {}

  /** Open (or create) the store, replaying the file. Throws CustodyCorruptError on damage. */
  static open(path: string, opts: CustodyOptions = {}): CustodyStore {
    const store = new CustodyStore(
      path,
      opts.io ?? nodeFileIo,
      opts.now ?? (() => new Date()),
      opts.compactMinLines ?? 1000,
      opts.maxPending ?? 10_000,
      opts.retainSettledMs ?? 7 * 86_400_000,
      opts.dedupWindowMs ?? 30 * 86_400_000,
      opts.maxTombstones ?? 100_000,
    );
    store.io.remove(`${path}.tmp`); // leftover of a crashed compaction; the real file is intact
    store.load();
    // Everything replayed above may only have been in the page cache. Make it durable before this
    // process acknowledges anything (a replayed duplicate gets a 200 without a new write).
    if (store.io.readText(path) !== null) {
      store.io.syncFile(path);
      store.io.syncDir(dirname(path));
    }
    return store;
  }

  private load(): void {
    const text = this.io.readText(this.path);
    if (text === null || text === "") return;
    const pieces = text.split("\n");
    const tail = pieces.pop() ?? ""; // "" when the file ends with a newline, else a torn line
    let kept = 0;
    pieces.forEach((raw, idx) => {
      kept += Buffer.byteLength(raw, "utf8") + 1;
      if (raw.trim() === "") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new CustodyCorruptError(`unparseable custody line ${idx + 1}`);
      }
      this.fold(parsed as Line, idx + 1);
      this.lineCount += 1;
    });
    if (tail !== "") this.io.truncate(this.path, kept); // drop the never-acknowledged torn tail
    this.size = kept;
    for (const rec of this.records.values()) {
      if (rec.status === "sending") rec.status = "uncertain";
    }
  }

  private fold(line: Line, lineNo = 0): void {
    const bad = (why: string): never => {
      throw new CustodyCorruptError(`invalid custody line ${lineNo}: ${why}`);
    };
    if (typeof line !== "object" || line === null || typeof line.t !== "string") return bad("not a record");
    if (line.t === "tombstone") {
      if (typeof line.deliveryId !== "string") return bad("bad tombstone");
      this.tombstones.set(line.deliveryId, { deliveryId: line.deliveryId, payloadSha256: line.payloadSha256, settledAt: line.settledAt });
      return;
    }
    if (line.t === "snapshot") {
      const rec = line.record;
      if (!rec || typeof rec.deliveryId !== "string") return bad("bad snapshot");
      this.putRecord(rec);
      return;
    }
    if (typeof line.deliveryId !== "string") return bad("missing deliveryId");
    if (line.t === "accept") {
      if (this.records.has(line.deliveryId)) return;
      this.putRecord({
        deliveryId: line.deliveryId,
        payloadSha256: line.payloadSha256,
        rawBytesSha256: line.rawBytesSha256,
        receivedAt: line.at,
        envelope: line.envelope,
        correlations: line.correlations,
        status: "pending",
        attempts: 0,
      });
      return;
    }
    const rec = this.records.get(line.deliveryId);
    if (!rec) return bad(`unknown deliveryId for ${line.t}`);
    switch (line.t) {
      case "sending":
        rec.status = "sending";
        rec.attempts += 1;
        break;
      case "retry":
        rec.status = "pending";
        if (line.reason) rec.lastError = line.reason;
        break;
      case "sent":
        rec.status = "sent";
        rec.messageId = line.messageId;
        rec.sentAt = line.at;
        if (!this.byMessageId.has(line.messageId)) this.byMessageId.set(line.messageId, rec.deliveryId);
        this.settle(rec, line.at);
        break;
      case "failed":
        rec.status = "failed";
        rec.lastError = line.reason;
        break;
      case "requeue":
        rec.status = "pending";
        break;
      case "corr": {
        const corr = rec.correlations.find((c) => c.id === line.correlationId);
        if (!corr) return bad("unknown correlation");
        corr.status = line.status;
        if (line.eventId) corr.eventId = line.eventId;
        if (line.reason) corr.reason = line.reason;
        this.settle(rec, line.at);
        break;
      }
      default:
        return bad(`unknown type ${(line as { t: string }).t}`);
    }
  }

  private putRecord(rec: CustodyRecord): void {
    if (!this.records.has(rec.deliveryId)) this.order.push(rec.deliveryId);
    this.records.set(rec.deliveryId, rec);
    rec.correlations.forEach((c, index) => this.byCorrelation.set(c.id, { deliveryId: rec.deliveryId, index }));
    if (rec.messageId && !this.byMessageId.has(rec.messageId)) this.byMessageId.set(rec.messageId, rec.deliveryId);
  }

  /** A sent delivery with nothing left to answer becomes answered or closed. */
  private settle(rec: CustodyRecord, at: string = this.stamp()): void {
    if (rec.status !== "sent" && rec.status !== "answered") return;
    if (rec.correlations.some((c) => c.status === "open")) return;
    rec.status = rec.correlations.some((c) => c.status === "answered") ? "answered" : "closed";
    rec.settledAt ??= at;
  }

  private append(line: Line): void {
    if (this.poisoned) throw new CustodyPoisonedError();
    const data = `${JSON.stringify(line)}\n`;
    try {
      this.io.appendDurable(this.path, data);
    } catch (err) {
      // A failed append may have left a partial line; cut back to the last known good size so
      // the next append cannot glue onto it. If even that fails, refuse all further writes.
      try {
        this.io.truncate(this.path, this.size);
      } catch {
        this.poisoned = true;
      }
      throw err;
    }
    this.size += Buffer.byteLength(data, "utf8");
    this.lineCount += 1;
    this.fold(line);
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  private correlationId(deliveryId: string, index: number): string {
    for (let length = 6; length <= 24; length++) {
      const id = shortId(`${deliveryId}\n${index}`, length);
      if (!this.byCorrelation.has(id)) return id;
    }
    throw new Error("could not allocate a correlation id");
  }

  /**
   * Take custody of an envelope. Idempotent by deliveryId: the same canonical payload is a
   * duplicate, a different payload under the same deliveryId is a conflict. Durable on return.
   */
  accept(envelope: RelayOutboundEnvelope, rawBody: string): AcceptResult {
    const payloadSha256 = computeCanonicalSha256(envelope);
    const existing = this.records.get(envelope.deliveryId) ?? this.tombstones.get(envelope.deliveryId);
    if (existing) {
      return { kind: existing.payloadSha256 === payloadSha256 ? "duplicate" : "conflict", record: existing };
    }
    const unsent = this.list().filter((r) => r.status === "pending" || r.status === "sending" || r.status === "uncertain").length;
    if (unsent >= this.maxPending) throw new CustodyFullError(this.maxPending);
    const correlations: CorrelationEntry[] = [];
    const taken = new Set<string>();
    const add = (itemIndex: number | null, replyRef: string | null): void => {
      let id = this.correlationId(envelope.deliveryId, correlations.length);
      for (let n = 1; taken.has(id); n++) id = shortId(`${envelope.deliveryId}\n${correlations.length}\n${n}`, 8);
      taken.add(id);
      correlations.push({ id, itemIndex, replyRef, status: replyRef === null ? "closed" : "open" });
    };
    add(null, envelope.replyRef);
    (envelope.items ?? []).forEach((item, i) => add(i, item.replyRef));
    this.append({
      t: "accept",
      at: this.stamp(),
      deliveryId: envelope.deliveryId,
      payloadSha256,
      rawBytesSha256: sha256Hex(rawBody),
      envelope,
      correlations,
    });
    this.maybeCompact();
    return { kind: "accepted", record: this.records.get(envelope.deliveryId) as CustodyRecord };
  }

  get(deliveryId: string): CustodyRecord | undefined {
    return this.records.get(deliveryId);
  }

  list(): CustodyRecord[] {
    return this.order.map((id) => this.records.get(id) as CustodyRecord);
  }

  pending(): CustodyRecord[] {
    return this.list().filter((r) => r.status === "pending");
  }

  uncertain(): CustodyRecord[] {
    return this.list().filter((r) => r.status === "uncertain");
  }

  findByMessageId(messageId: string): CustodyRecord | undefined {
    const id = this.byMessageId.get(messageId);
    return id === undefined ? undefined : this.records.get(id);
  }

  findCorrelation(id: string): { record: CustodyRecord; correlation: CorrelationEntry } | undefined {
    const hit = this.byCorrelation.get(id);
    if (!hit) return undefined;
    const record = this.records.get(hit.deliveryId) as CustodyRecord;
    return { record, correlation: record.correlations[hit.index] as CorrelationEntry };
  }

  /** Record that a send attempt is about to start. Durable before the transport is called. */
  markSending(deliveryId: string): void {
    this.require(deliveryId);
    this.append({ t: "sending", at: this.stamp(), deliveryId });
  }

  /** The transport definitely did not send: back to pending. */
  markRetry(deliveryId: string, reason?: string): void {
    this.require(deliveryId);
    this.append({ t: "retry", at: this.stamp(), deliveryId, ...(reason ? { reason } : {}) });
  }

  markSent(deliveryId: string, messageId: string): void {
    this.require(deliveryId);
    this.append({ t: "sent", at: this.stamp(), deliveryId, messageId });
    this.maybeCompact();
  }

  markFailed(deliveryId: string, reason: string): void {
    this.require(deliveryId);
    this.append({ t: "failed", at: this.stamp(), deliveryId, reason });
  }

  /** Operator resolution for a failed or uncertain record: try it again. */
  requeue(deliveryId: string): void {
    const rec = this.require(deliveryId);
    if (rec.status !== "failed" && rec.status !== "uncertain") {
      throw new Error(`cannot requeue a ${rec.status} delivery`);
    }
    this.append({ t: "requeue", at: this.stamp(), deliveryId });
  }

  /** Operator resolution for an uncertain record the human confirmed was delivered. */
  resolveUncertainAsSent(deliveryId: string, messageId: string): void {
    const rec = this.require(deliveryId);
    if (rec.status !== "uncertain") throw new Error(`delivery is ${rec.status}, not uncertain`);
    this.markSent(deliveryId, messageId);
  }

  resolveCorrelation(
    deliveryId: string,
    correlationId: string,
    status: "answered" | "closed",
    meta: { eventId?: string; reason?: string } = {},
  ): void {
    this.require(deliveryId);
    this.append({
      t: "corr",
      at: this.stamp(),
      deliveryId,
      correlationId,
      status,
      ...(meta.eventId ? { eventId: meta.eventId } : {}),
      ...(meta.reason ? { reason: meta.reason } : {}),
    });
  }

  stats(): CustodyStats {
    const byStatus = emptyCounts();
    let oldest: number | null = null;
    const nowMs = this.now().getTime();
    for (const rec of this.records.values()) {
      byStatus[rec.status] += 1;
      if (rec.status === "pending" || rec.status === "uncertain") {
        const age = nowMs - Date.parse(rec.receivedAt);
        if (oldest === null || age > oldest) oldest = age;
      }
    }
    return { total: this.records.size, byStatus, oldestUnsentAgeMs: oldest };
  }

  /**
   * Rewrite the file as one snapshot line per delivery (atomic: temp, fsync, rename, fsync dir).
   * Records are never dropped, so deduplication by deliveryId survives compaction.
   */
  compact(): void {
    if (this.poisoned) throw new CustodyPoisonedError();
    const nowMs = this.now().getTime();
    const retire = this.list().filter(
      (r) => (r.status === "answered" || r.status === "closed") && nowMs - Date.parse(r.settledAt ?? r.receivedAt) >= this.retainSettledMs,
    );
    const retiring = new Set(retire.map((r) => r.deliveryId));
    const tombs = new Map(this.tombstones);
    for (const r of retire) {
      tombs.set(r.deliveryId, { deliveryId: r.deliveryId, payloadSha256: r.payloadSha256, settledAt: Date.parse(r.settledAt ?? r.receivedAt) });
    }
    const kept = [...tombs.values()]
      .filter((t) => nowMs - t.settledAt < this.dedupWindowMs)
      .sort((a, b) => a.settledAt - b.settledAt)
      .slice(-this.maxTombstones);
    const at = this.stamp();
    const lines: string[] = [
      ...kept.map((t) => JSON.stringify({ t: "tombstone", at, deliveryId: t.deliveryId, payloadSha256: t.payloadSha256, settledAt: t.settledAt } satisfies Line)),
      ...this.list().filter((r) => !retiring.has(r.deliveryId)).map((record) => JSON.stringify({ t: "snapshot", at, record } satisfies Line)),
    ];
    const data = lines.map((l) => `${l}\n`).join("");
    try {
      this.io.writeAtomic(this.path, data);
    } catch (err) {
      // After the rename the on-disk ledger may or may not be durable: stop acknowledging.
      if (err instanceof PostRenameError) this.poisoned = true;
      throw err;
    }
    this.size = Buffer.byteLength(data, "utf8");
    this.lineCount = lines.length;
    this.tombstones.clear();
    for (const t of kept) this.tombstones.set(t.deliveryId, t);
    for (const id of retiring) {
      const rec = this.records.get(id) as CustodyRecord;
      this.records.delete(id);
      this.order.splice(this.order.indexOf(id), 1);
      if (rec.messageId) this.byMessageId.delete(rec.messageId);
      for (const c of rec.correlations) this.byCorrelation.delete(c.id);
    }
  }

  private maybeCompact(): void {
    if (this.lineCount > Math.max(this.compactMinLines, (this.records.size + this.tombstones.size) * 2)) {
      try {
        this.compact();
      } catch {
        // Compaction is an optimisation; the append-only file is still correct.
      }
    }
  }

  private require(deliveryId: string): CustodyRecord {
    const rec = this.records.get(deliveryId);
    if (!rec) throw new Error(`unknown deliveryId ${deliveryId}`);
    return rec;
  }
}
