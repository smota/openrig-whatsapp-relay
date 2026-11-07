export interface RedactTextOptions {
  /** Truncate the result to this many characters (adds "..."). */
  max?: number;
}

/** Mask JIDs, phone numbers and bearer tokens in a string that is about to be logged. */
export function redactText(text: string, opts: RedactTextOptions = {}): string {
  let out = String(text)
    .replace(/\b[a-z0-9]+(?::\d+)?@(?:s\.whatsapp\.net|lid|g\.us|broadcast)\b/gi, "[jid]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\(?\+?\d[\d ().\-/]{7,}\d/g, "[phone]");
  if (opts.max !== undefined && out.length > opts.max) out = `${out.slice(0, opts.max)}...`;
  return out;
}

const PREFIX = "[relay] libsignal:";
const METHODS = ["log", "info", "warn", "error", "debug", "trace"] as const;
const SESSION_MESSAGES: Array<[RegExp, string]> = [
  [/^Closing session\b/, "closing session"],
  [/^Opening session\b/, "opening session"],
  [/^Removing old closed session\b/, "removing old closed session"],
  [/^Session already closed\b/, "session already closed"],
  [/^Closing open session in favor of incoming prekey bundle\b/, "closing open session in favor of incoming prekey bundle"],
  [/^Closing stale open session\b/, "closing stale open session"],
];
const KEY_FIELDS = new Set([
  "rootKey", "chainKey", "ephemeralKeyPair", "remoteIdentityKey", "lastRemoteEphemeralKey",
  "privKey", "pubKey", "baseKey", "currentRatchet", "indexInfo", "_chains", "messageKeys",
  "pendingPreKey", "signedKeyId", "preKeyId",
]);
const INSTALLED = Symbol.for("openrig-whatsapp-relay.libsignalLogRedaction");

/** True for binary data or an object graph holding Signal key fields. */
export function carriesKeyMaterial(value: unknown, depth = 0, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
  if (depth > 6 || seen.has(value)) return false;
  seen.add(value);
  const name = (value as object).constructor?.name;
  if (name === "SessionEntry" || name === "SessionRecord") return true;
  if (value instanceof Error) return false;
  for (const [key, child] of Object.entries(value)) {
    if (KEY_FIELDS.has(key) || carriesKeyMaterial(child, depth + 1, seen)) return true;
  }
  return false;
}

/** The arguments to print: a one-line note for libsignal session dumps, key material replaced. */
export function redactConsoleArgs(args: unknown[]): unknown[] {
  const first = args[0];
  if (typeof first === "string") {
    for (const [pattern, label] of SESSION_MESSAGES) if (pattern.test(first)) return [`${PREFIX} ${label} (redacted)`];
  }
  if (!args.some((a) => carriesKeyMaterial(a))) return args;
  return args.map((a) => (carriesKeyMaterial(a) ? "[redacted key material]" : a));
}

/** Wrap console methods once (libsignal prints whole session objects). Returns a restore function. */
export function installLibsignalLogRedaction(target: Console = console): () => void {
  const t = target as unknown as Record<string | symbol, unknown>;
  if (typeof t[INSTALLED] === "function") return t[INSTALLED] as () => void;
  const originals: Record<string, (...a: unknown[]) => unknown> = {};
  for (const method of METHODS) {
    const original = t[method];
    if (typeof original !== "function") continue;
    originals[method] = original as (...a: unknown[]) => unknown;
    t[method] = function redactedConsole(this: unknown, ...args: unknown[]) {
      return (original as (...a: unknown[]) => unknown).apply(this, redactConsoleArgs(args));
    };
  }
  const restore = () => {
    for (const [m, original] of Object.entries(originals)) t[m] = original;
    delete t[INSTALLED];
  };
  Object.defineProperty(target, INSTALLED, { value: restore, configurable: true, enumerable: false });
  return restore;
}
