import {
  closeSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * The only filesystem surface custody uses. Injectable so tests can simulate a crash between
 * write and fsync, a short write, or a failing directory fsync.
 */
export interface FileIo {
  /** Whole file as text, or null when it does not exist. */
  readText(path: string): string | null;
  /**
   * Append every byte, fsync the file, and (when the file was just created) fsync its parent
   * directory, before returning. Throws on any failure, including a short write.
   */
  appendDurable(path: string, data: string): void;
  /**
   * Replace the file atomically: write every byte to a temp file, fsync, rename, fsync the
   * directory. Failures before the rename throw a plain Error and leave the old file in place;
   * a failure after the rename throws PostRenameError.
   */
  writeAtomic(path: string, data: string): void;
  /** Truncate to `size` bytes and fsync. A missing file is a no-op. */
  truncate(path: string, size: number): void;
  /** fsync an existing file. */
  syncFile(path: string): void;
  /** fsync a directory. */
  syncDir(path: string): void;
  /** Remove a file if present. */
  remove(path: string): void;
}

/** The rename happened but its durability could not be confirmed. The ledger must not be trusted for acks. */
export class PostRenameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostRenameError";
  }
}

export interface NodeFileIoHooks {
  /** Replaces `writeSync(fd, buf, off, len)`; tests use it to inject short writes. */
  write?: (fd: number, buf: Uint8Array, offset: number, length: number) => number;
  /** Replaces the directory fsync. */
  syncDir?: (dir: string) => void;
}

function realSyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP") throw err; // the filesystem cannot fsync directories
  } finally {
    closeSync(fd);
  }
}

export function createNodeFileIo(hooks: NodeFileIoHooks = {}): FileIo {
  const write = hooks.write ?? ((fd, buf, off, len) => writeSync(fd, buf, off, len));
  const syncDir = hooks.syncDir ?? realSyncDir;

  function writeFully(fd: number, text: string): void {
    const buf = Buffer.from(text, "utf8");
    let off = 0;
    while (off < buf.length) {
      const n = write(fd, buf, off, buf.length - off);
      if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes written`);
      off += n;
    }
  }

  return {
    readText(path) {
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    },
    appendDurable(path, data) {
      mkdirSync(dirname(path), { recursive: true });
      const created = !existsSync(path);
      const fd = openSync(path, "a", 0o600);
      try {
        writeFully(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (created) syncDir(dirname(path));
    },
    writeAtomic(path, data) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      const fd = openSync(tmp, "w", 0o600);
      try {
        writeFully(fd, data);
        fsyncSync(fd);
      } catch (err) {
        closeSync(fd);
        unlinkSync(tmp);
        throw err;
      }
      closeSync(fd);
      renameSync(tmp, path);
      try {
        syncDir(dirname(path));
      } catch (err) {
        throw new PostRenameError(`directory fsync after rename failed: ${(err as Error).message}`);
      }
    },
    truncate(path, size) {
      if (!existsSync(path)) return;
      const fd = openSync(path, "r+");
      try {
        ftruncateSync(fd, size);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    syncFile(path) {
      const fd = openSync(path, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    syncDir(path) {
      syncDir(path);
    },
    remove(path) {
      try {
        unlinkSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },
  };
}

export const nodeFileIo: FileIo = createNodeFileIo();
