/**
 * Screen Wake Lock service — prevents the phone from sleeping
 * while the user is reading on the glasses.
 *
 * Uses the W3C Screen Wake Lock API (navigator.wakeLock).
 * Best-effort: silently no-ops if the API is unavailable.
 * Re-acquires automatically when the page regains visibility
 * (browser releases wake locks on visibility loss).
 */

export interface WakeLockService {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

export class WakeLockServiceImpl implements WakeLockService {
  private sentinel: WakeLockSentinel | null = null;
  private wantLock = false;
  private boundVisibilityHandler: (() => void) | null = null;

  async acquire(): Promise<void> {
    this.wantLock = true;
    this.ensureVisibilityListener();
    await this.requestLock();
  }

  async release(): Promise<void> {
    this.wantLock = false;
    await this.releaseLock();
  }

  private async requestLock(): Promise<void> {
    if (this.sentinel) return; // Already held

    if (!("wakeLock" in navigator)) {
      console.log("[wakelock] API not available");
      return;
    }

    try {
      this.sentinel = await navigator.wakeLock.request("screen");
      this.sentinel.addEventListener("release", () => {
        this.sentinel = null;
      });
      console.log("[wakelock] Acquired");
    } catch (err) {
      console.warn("[wakelock] Failed to acquire:", err);
    }
  }

  private async releaseLock(): Promise<void> {
    if (!this.sentinel) return;

    try {
      await this.sentinel.release();
      console.log("[wakelock] Released");
    } catch {
      // Best effort
    }
    this.sentinel = null;
  }

  /**
   * Browser auto-releases wake locks when the page loses visibility.
   * Re-acquire when it becomes visible again, if we still want the lock.
   */
  private ensureVisibilityListener(): void {
    if (this.boundVisibilityHandler) return;

    this.boundVisibilityHandler = () => {
      if (document.visibilityState === "visible" && this.wantLock) {
        void this.requestLock();
      }
    };

    document.addEventListener("visibilitychange", this.boundVisibilityHandler);
  }
}
