/**
 * Gmail OAuth 2.0 and API configuration.
 *
 * Before using Gmail, the developer must:
 * 1. Create a project at https://console.cloud.google.com/
 * 2. Enable the Gmail API
 * 3. Create an OAuth 2.0 Client ID (type: Web application)
 * 4. Add the redirect URI below to authorized redirect URIs
 * 5. Set VITE_GOOGLE_CLIENT_ID in your .env file (see .env.example)
 */

export const GMAIL_CONFIG = {
  /** Read from VITE_GOOGLE_CLIENT_ID environment variable (.env file). */
  CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",

  /** Must exactly match the authorized redirect URI in Google Cloud Console. */
  REDIRECT_URI: import.meta.env.DEV
    ? "http://localhost:5173/"
    : "https://r-castelo.github.io/G2-Gmail/",

  SCOPES: "https://www.googleapis.com/auth/gmail.modify",

  AUTH_ENDPOINT: "https://accounts.google.com/o/oauth2/v2/auth",
  TOKEN_ENDPOINT: "https://oauth2.googleapis.com/token",

  API_BASE: "https://gmail.googleapis.com/gmail/v1",
} as const;

if (!GMAIL_CONFIG.CLIENT_ID) {
  console.warn(
    "VITE_GOOGLE_CLIENT_ID is not set. Add it to your .env file. See .env.example.",
  );
}
