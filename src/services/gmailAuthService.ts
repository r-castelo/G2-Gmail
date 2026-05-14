/**
 * Gmail Auth service — handles OAuth 2.0 (redirect + PKCE) for Gmail API.
 *
 * Design:
 * - No popups — uses full-page redirect to Google's consent screen
 * - PKCE (S256) for public client security (no client secret in browser)
 * - Refresh token persisted to a multi-backend store (localStorage,
 *   host storage, IndexedDB, cookie) so the token survives whichever
 *   storage area the Even App WebView clears between sessions
 * - Access token kept in memory only (short-lived, ~1 hour)
 * - Uses the gmail.readonly scope
 */

import { GMAIL_CONFIG } from "../config/gmailConfig";
import { STORAGE_KEYS } from "../config/constants";
import type { HostStorage } from "./hostStorage";
import {
  PersistentStorage,
  type PersistReadResult,
  type PersistWriteResult,
} from "./persistentStorage";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

export class GmailAuthService {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;
  private persistence: PersistentStorage = new PersistentStorage(null);
  private lastWriteResult: PersistWriteResult | null = null;
  private lastReadResult: PersistReadResult | null = null;

  /**
   * Attach a host-backed storage so future writes/clears mirror to it.
   * Safe to call multiple times; the most recent store wins.
   */
  setHostStorage(hostStorage: HostStorage): void {
    this.persistence.setHostStorage(hostStorage);
  }

  /** Diagnostic: which backends accepted the last token write. */
  getLastWriteResult(): PersistWriteResult | null {
    return this.lastWriteResult;
  }

  /** Diagnostic: which backend the token was recovered from on hydrate. */
  getLastReadResult(): PersistReadResult | null {
    return this.lastReadResult;
  }

  /** Diagnostic: every backend name currently registered. */
  getBackendNames(): string[] {
    return this.persistence.backendNames();
  }

  // --- PKCE ---

  /**
   * Generate a cryptographically random code_verifier (43-128 chars, URL-safe).
   */
  private generateCodeVerifier(): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return this.base64urlEncode(bytes);
  }

  /**
   * Derive code_challenge from code_verifier using SHA-256.
   */
  private async generateCodeChallenge(verifier: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await crypto.subtle.digest("SHA-256", data);
    return this.base64urlEncode(new Uint8Array(digest));
  }

  private base64urlEncode(bytes: Uint8Array): string {
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  // --- OAuth Redirect Flow ---

  /**
   * Initiate OAuth: build auth URL, save state to localStorage, redirect.
   * This does a full-page navigation — the function never returns normally.
   */
  async startAuth(): Promise<void> {
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = await this.generateCodeChallenge(codeVerifier);
    const state = crypto.randomUUID();

    localStorage.setItem(STORAGE_KEYS.codeVerifier, codeVerifier);
    localStorage.setItem(STORAGE_KEYS.preAuthState, state);

    const params = new URLSearchParams({
      client_id: GMAIL_CONFIG.CLIENT_ID,
      redirect_uri: GMAIL_CONFIG.REDIRECT_URI,
      response_type: "code",
      scope: GMAIL_CONFIG.SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      access_type: "offline",
      prompt: "consent",
    });

    window.location.href = `${GMAIL_CONFIG.AUTH_ENDPOINT}?${params.toString()}`;
  }

  /**
   * Check if the current URL contains an OAuth authorization code.
   * Call once at app startup. Returns true if a code was found and tokens were exchanged.
   */
  async handleRedirectIfPresent(): Promise<boolean> {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) return false;

    // From here on, we HAVE an OAuth callback — failures should throw,
    // not silently return false, so the UI can show what went wrong.

    // Verify CSRF state
    const savedState = localStorage.getItem(STORAGE_KEYS.preAuthState);
    if (state !== savedState) {
      this.cleanupRedirectParams();
      throw new Error("OAuth state mismatch — please sign in again");
    }

    // Get code verifier for PKCE
    const codeVerifier = localStorage.getItem(STORAGE_KEYS.codeVerifier);
    if (!codeVerifier) {
      this.cleanupRedirectParams();
      throw new Error("Missing PKCE verifier — please sign in again");
    }

    try {
      await this.exchangeCodeForTokens(code, codeVerifier);
      console.log("[gmail-auth] OAuth completed successfully");
    } catch (err) {
      this.cleanupRedirectParams();
      throw new Error(`Token exchange failed: ${String(err)}`);
    }

    this.cleanupRedirectParams();
    return true;
  }

  /**
   * Exchange authorization code for access + refresh tokens.
   */
  private async exchangeCodeForTokens(
    code: string,
    codeVerifier: string,
  ): Promise<void> {
    const response = await fetch(GMAIL_CONFIG.TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GMAIL_CONFIG.CLIENT_ID,
        client_secret: GMAIL_CONFIG.CLIENT_SECRET,
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: GMAIL_CONFIG.REDIRECT_URI,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;

    if (data.refresh_token) {
      this.lastWriteResult = await this.persistence.writeAll(
        STORAGE_KEYS.refreshToken,
        data.refresh_token,
      );
    }
  }

  /**
   * Refresh the access token using the stored refresh token.
   */
  private async refreshAccessToken(): Promise<void> {
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken);
    if (!refreshToken) {
      throw new Error("No refresh token available. Please sign in again.");
    }

    const response = await fetch(GMAIL_CONFIG.TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GMAIL_CONFIG.CLIENT_ID,
        client_secret: GMAIL_CONFIG.CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      // Refresh token revoked or expired — wipe it from every backend so
      // the user gets a clean relay-auth on the next launch.
      await this.persistence.clearAll(STORAGE_KEYS.refreshToken);
      throw new Error("Session expired. Please sign in again.");
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + data.expires_in * 1000 - 60_000;
  }

  /**
   * Get a valid access token, refreshing if expired.
   */
  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken;
    }
    await this.refreshAccessToken();
    return this.accessToken!;
  }

  /**
   * Force a token refresh regardless of expiry time.
   * Used for retry after 401 responses.
   */
  async forceRefresh(): Promise<string> {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    await this.refreshAccessToken();
    return this.accessToken!;
  }

  /**
   * Whether the user has a stored refresh token (previously authenticated).
   */
  isAuthenticated(): boolean {
    return !!localStorage.getItem(STORAGE_KEYS.refreshToken);
  }

  /**
   * Import a refresh token obtained via the browser-relay flow. Writes
   * to every backend in parallel; we don't know which one will survive
   * the next Even App restart, so we cast a wide net.
   */
  async importRefreshToken(token: string): Promise<void> {
    this.lastWriteResult = await this.persistence.writeAll(
      STORAGE_KEYS.refreshToken,
      token,
    );
  }

  /**
   * Recover a previously stored refresh token from whichever backend
   * still has it (host storage, IndexedDB, cookie) and copy it back
   * into localStorage so the rest of the app can use the fast sync
   * accessors. Idempotent — does nothing if localStorage already has
   * the token.
   */
  async hydrateFromHostStorage(): Promise<PersistReadResult> {
    if (localStorage.getItem(STORAGE_KEYS.refreshToken)) {
      this.lastReadResult = { value: "<cached>", source: "localStorage" };
      return this.lastReadResult;
    }
    const result = await this.persistence.readFirst(STORAGE_KEYS.refreshToken);
    this.lastReadResult = result;
    return result;
  }

  /**
   * Sign out: clear the refresh token from every backend so the user
   * cannot be re-hydrated from a forgotten store on next launch.
   */
  async signOut(): Promise<void> {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    localStorage.removeItem(STORAGE_KEYS.codeVerifier);
    localStorage.removeItem(STORAGE_KEYS.preAuthState);
    await this.persistence.clearAll(STORAGE_KEYS.refreshToken);
    this.lastReadResult = null;
    this.lastWriteResult = null;
  }

  // --- Helpers ---

  private cleanupRedirectParams(): void {
    // Remove OAuth params from URL without page reload
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    url.searchParams.delete("scope");
    window.history.replaceState({}, "", url.pathname + url.hash);

    localStorage.removeItem(STORAGE_KEYS.codeVerifier);
    localStorage.removeItem(STORAGE_KEYS.preAuthState);
  }
}
