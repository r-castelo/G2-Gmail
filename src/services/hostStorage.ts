import type { EvenAppBridge } from "@evenrealities/even_hub_sdk";

/**
 * Persistent key/value store backed by the Even App's host storage.
 *
 * Browser localStorage inside the Even App WebView is not durable across
 * full app restarts, but the host's setLocalStorage/getLocalStorage APIs
 * are. The auth service writes the refresh token to both: localStorage
 * for fast in-memory reads during a session, host storage as the source
 * of truth across restarts.
 */
export interface HostStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export class BridgeHostStorage implements HostStorage {
  constructor(private readonly bridge: EvenAppBridge) {}

  async get(key: string): Promise<string | null> {
    const value = await this.bridge.getLocalStorage(key);
    return value && value.length > 0 ? value : null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.bridge.setLocalStorage(key, value);
  }

  async remove(key: string): Promise<void> {
    // Host SDK has no removeLocalStorage; clearing to empty string is the
    // closest equivalent and what `get` already treats as absent.
    await this.bridge.setLocalStorage(key, "");
  }
}
