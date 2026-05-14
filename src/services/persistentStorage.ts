import type { HostStorage } from "./hostStorage";

/**
 * "Throw everything at the wall" persistent key/value store.
 *
 * The Even App WebView wipes browser localStorage between sessions and the
 * host's setLocalStorage has also been observed to not always survive a
 * full Even App restart. We don't know which store actually persists on a
 * given device — so we fan writes out to every store we can reach
 * (localStorage, host storage, IndexedDB, cookies) and, on read, return
 * the first one that still has the value.
 *
 * If even one backend persists, the token survives.
 *
 * `readFirst` also opportunistically copies the recovered value into the
 * faster front-of-list stores (localStorage, host) so subsequent reads in
 * the same session don't hit the slower paths.
 */

const IDB_NAME = "g2_gmail";
const IDB_STORE = "kv";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 year

export interface PersistWriteResult {
  /** Map of backend name to whether the write succeeded. */
  backends: Record<string, boolean>;
  /** Convenience: at least one persistent (non-localStorage) backend wrote. */
  durable: boolean;
}

export interface PersistReadResult {
  value: string | null;
  /** Name of the backend that supplied the value, or null if not found. */
  source: string | null;
}

interface Backend {
  readonly name: string;
  /** True if this backend survives a WebView/Even-App restart in principle. */
  readonly durable: boolean;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

class LocalStorageBackend implements Backend {
  readonly name = "localStorage";
  readonly durable = false; // wiped between Even App sessions in this WebView

  async get(key: string): Promise<string | null> {
    return localStorage.getItem(key);
  }
  async set(key: string, value: string): Promise<void> {
    localStorage.setItem(key, value);
  }
  async remove(key: string): Promise<void> {
    localStorage.removeItem(key);
  }
}

class HostStorageBackend implements Backend {
  readonly name = "host";
  readonly durable = true;
  constructor(private readonly inner: HostStorage) {}

  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }
  set(key: string, value: string): Promise<void> {
    return this.inner.set(key, value);
  }
  remove(key: string): Promise<void> {
    return this.inner.remove(key);
  }
}

class IndexedDBBackend implements Backend {
  readonly name = "indexedDB";
  readonly durable = true;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(IDB_STORE)) {
            req.result.createObjectStore(IDB_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
      });
    }
    return this.dbPromise;
  }

  async get(key: string): Promise<string | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => {
        const v = req.result;
        resolve(typeof v === "string" && v.length > 0 ? v : null);
      };
      req.onerror = () => reject(req.error ?? new Error("IDB get failed"));
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB set failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IDB set aborted"));
    });
  }

  async remove(key: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IDB delete failed"));
      tx.onabort = () => reject(tx.error ?? new Error("IDB delete aborted"));
    });
  }
}

class CookieBackend implements Backend {
  readonly name = "cookie";
  readonly durable = true;

  async get(key: string): Promise<string | null> {
    const prefix = `${encodeURIComponent(key)}=`;
    for (const raw of document.cookie.split(";")) {
      const c = raw.trim();
      if (c.startsWith(prefix)) {
        return decodeURIComponent(c.slice(prefix.length));
      }
    }
    return null;
  }

  async set(key: string, value: string): Promise<void> {
    const k = encodeURIComponent(key);
    const v = encodeURIComponent(value);
    document.cookie = `${k}=${v}; max-age=${COOKIE_MAX_AGE_SECONDS}; path=/; SameSite=Lax`;
  }

  async remove(key: string): Promise<void> {
    const k = encodeURIComponent(key);
    document.cookie = `${k}=; max-age=0; path=/`;
  }
}

export class PersistentStorage {
  private backends: Backend[];

  constructor(hostStorage: HostStorage | null) {
    const backends: Backend[] = [new LocalStorageBackend()];
    if (hostStorage) {
      backends.push(new HostStorageBackend(hostStorage));
    }
    if (typeof indexedDB !== "undefined") {
      backends.push(new IndexedDBBackend());
    }
    if (typeof document !== "undefined" && this.cookiesEnabled()) {
      backends.push(new CookieBackend());
    }
    this.backends = backends;
  }

  /** Update the host-backed backend after the bridge becomes available. */
  setHostStorage(hostStorage: HostStorage): void {
    const without = this.backends.filter((b) => b.name !== "host");
    // Keep localStorage first for fast in-session reads; insert host just
    // after it so the durable backends come right after.
    const ls = without.find((b) => b.name === "localStorage");
    const rest = without.filter((b) => b.name !== "localStorage");
    const host = new HostStorageBackend(hostStorage);
    this.backends = ls ? [ls, host, ...rest] : [host, ...without];
  }

  /** Fan a write out to every backend in parallel. */
  async writeAll(key: string, value: string): Promise<PersistWriteResult> {
    const results: Record<string, boolean> = {};
    let durable = false;
    await Promise.all(
      this.backends.map(async (b) => {
        try {
          await b.set(key, value);
          results[b.name] = true;
          if (b.durable) durable = true;
        } catch (err) {
          console.error(`[persist] ${b.name} write failed:`, err);
          results[b.name] = false;
        }
      }),
    );
    return { backends: results, durable };
  }

  /**
   * Read from each backend in order; return the first non-null hit.
   * Also forward-copies the recovered value into earlier (faster)
   * backends so subsequent reads stay fast.
   */
  async readFirst(key: string): Promise<PersistReadResult> {
    for (let i = 0; i < this.backends.length; i++) {
      const backend = this.backends[i]!;
      try {
        const v = await backend.get(key);
        if (v) {
          // Hydrate earlier backends so the next isAuthenticated() (which
          // looks at localStorage synchronously) sees the value too.
          for (let j = 0; j < i; j++) {
            try {
              await this.backends[j]!.set(key, v);
            } catch {
              // best-effort
            }
          }
          return { value: v, source: backend.name };
        }
      } catch (err) {
        console.error(`[persist] ${backend.name} read failed:`, err);
      }
    }
    return { value: null, source: null };
  }

  /** Best-effort clear from every backend. */
  async clearAll(key: string): Promise<void> {
    await Promise.all(
      this.backends.map(async (b) => {
        try {
          await b.remove(key);
        } catch (err) {
          console.error(`[persist] ${b.name} remove failed:`, err);
        }
      }),
    );
  }

  /** Names of every backend currently registered (for diagnostics). */
  backendNames(): string[] {
    return this.backends.map((b) => b.name);
  }

  private cookiesEnabled(): boolean {
    try {
      return navigator.cookieEnabled !== false;
    } catch {
      return true;
    }
  }
}
