import "@jappyjan/even-realities-ui/styles.css";
import { Controller } from "./app/controller";
import { GlassAdapterImpl } from "./adapters/glassAdapter";
import { GmailAdapterImpl } from "./adapters/gmailAdapter";
import { GmailAuthService } from "./services/gmailAuthService";
import { WakeLockServiceImpl } from "./services/wakeLockService";
import { PhoneUI, setPhoneState } from "./phone/phoneUI";
import { GMAIL_CONFIG } from "./config/gmailConfig";
import { STORAGE_KEYS } from "./config/constants";

const RELAY_AUTH_KEY = "g2_gmail.relay_auth";

async function bootstrap(): Promise<void> {
  setPhoneState("connecting", "Starting...");

  const auth = new GmailAuthService();

  // --- Relay auth: system browser was opened with ?startauth=1 ---
  const startUrl = new URL(window.location.href);
  if (startUrl.searchParams.has("startauth")) {
    sessionStorage.setItem(RELAY_AUTH_KEY, "1");
    startUrl.searchParams.delete("startauth");
    window.history.replaceState({}, "", startUrl.pathname + startUrl.hash);
    await auth.startAuth(); // Normal redirect (we're in a real browser now)
    return; // Page navigates away to Google
  }

  // --- Gmail OAuth: handle redirect before anything else ---
  let wasOAuthRedirect = false;
  try {
    wasOAuthRedirect = await auth.handleRedirectIfPresent();
  } catch (err: unknown) {
    console.error("[main] OAuth redirect handling failed:", err);
    setPhoneState("error", `Sign-in failed: ${String(err)}`);
    // Continue — still create PhoneUI so user can retry
  }

  // --- Relay auth completion: show token for user to copy back to WebView ---
  if (wasOAuthRedirect && sessionStorage.getItem(RELAY_AUTH_KEY)) {
    sessionStorage.removeItem(RELAY_AUTH_KEY);
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken) ?? "";
    const phoneUI = new PhoneUI({
      onSignIn: async () => {},
      onSignOut: () => {},
      onImportToken: () => {},
      isAuthenticated: () => false,
      getEmail: async () => "",
    });
    phoneUI.showRelayTokenScreen(refreshToken);
    return; // Don't start glasses controller — this is the system browser
  }

  const glass = new GlassAdapterImpl();
  const gmail = new GmailAdapterImpl(auth);
  const wakeLock = new WakeLockServiceImpl();
  const controller = new Controller({ glass, gmail, auth, wakeLock });

  // --- Initialize phone UI immediately ---
  const phoneUI = new PhoneUI({
    onSignIn: async () => {
      const mode = await auth.startAuth();
      if (mode === "relay") {
        // WebView: show URL to copy + token paste screen
        const relayUrl = `${GMAIL_CONFIG.REDIRECT_URI}?startauth=1`;
        phoneUI.showTokenPasteScreen(relayUrl);
      }
      // mode === "redirect": page navigates away
    },
    onSignOut: () => {
      auth.signOut();
      window.location.reload();
    },
    onImportToken: (token: string) => {
      auth.importRefreshToken(token);
      window.location.reload();
    },
    isAuthenticated: () => auth.isAuthenticated(),
    getEmail: async () => gmail.getProfile(),
  });

  // If authenticated, show authenticated state on phone
  if (wasOAuthRedirect || auth.isAuthenticated()) {
    try {
      await phoneUI.showAuthenticated();
      setPhoneState("connected", "Signed in — connecting glasses...");
    } catch (err: unknown) {
      console.error("[main] Post-auth setup failed:", err);
      setPhoneState("error", `Failed to load Gmail: ${String(err)}`);
      return;
    }
  }

  // Connect glasses in background — don't block the phone UI
  controller.start()
    .then(async () => {
      setPhoneState("connected", "Connected");
      if (auth.isAuthenticated()) {
        try {
          await controller.refreshAfterAuth();
        } catch (err: unknown) {
          console.error("[main] Post-auth glasses refresh failed:", err);
        }
      }
    })
    .catch((err: unknown) => {
      console.error("[main] Glass bridge failed:", err);
      setPhoneState(
        auth.isAuthenticated() ? "connected" : "error",
        auth.isAuthenticated() ? "Signed in — glasses offline" : "Glasses not connected",
      );
    });
}

void bootstrap().catch((error: unknown) => {
  setPhoneState("error", "Failed to start", String(error));
  console.error("G2-mail failed to start", error);
});
