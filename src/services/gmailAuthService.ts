/**
 * Gmail Auth service — handles OAuth 2.0 (redirect + PKCE) for Gmail API.
 *
 * Design:
 * - No popups — uses full-page redirect to Google's consent screen
 * - PKCE (S256) for public client security (no client secret in browser)
 * - Refresh token persisted in localStorage for cross-session auth
 * - Access token kept in memory only (short-lived, ~1 hour)
 * - Uses the gmail.readonly scope
 */

import { GMAIL_CONFIG } from "../config/gmailConfig";
import { STORAGE_KEYS } from "../config/constants";

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  token_type: string;
}

export class GmailAuthService {
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

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

    // Verify CSRF state
    const savedState = localStorage.getItem(STORAGE_KEYS.preAuthState);
    if (state !== savedState) {
      console.error("[gmail-auth] State mismatch — possible CSRF attack");
      this.cleanupRedirectParams();
      return false;
    }

    // Get code verifier for PKCE
    const codeVerifier = localStorage.getItem(STORAGE_KEYS.codeVerifier);
    if (!codeVerifier) {
      console.error("[gmail-auth] No code_verifier found");
      this.cleanupRedirectParams();
      return false;
    }

    try {
      await this.exchangeCodeForTokens(code, codeVerifier);
      console.log("[gmail-auth] OAuth completed successfully");
    } catch (err) {
      console.error("[gmail-auth] Token exchange failed:", err);
      this.cleanupRedirectParams();
      return false;
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
      localStorage.setItem(STORAGE_KEYS.refreshToken, data.refresh_token);
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
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      // Refresh token revoked or expired — clear it
      localStorage.removeItem(STORAGE_KEYS.refreshToken);
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
   * Sign out: clear all tokens.
   */
  signOut(): void {
    this.accessToken = null;
    this.tokenExpiresAt = 0;
    localStorage.removeItem(STORAGE_KEYS.refreshToken);
    localStorage.removeItem(STORAGE_KEYS.codeVerifier);
    localStorage.removeItem(STORAGE_KEYS.preAuthState);
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
