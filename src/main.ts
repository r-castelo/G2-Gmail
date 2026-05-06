import "@jappyjan/even-realities-ui/styles.css";
import { Controller } from "./app/controller";
import { GlassAdapterImpl } from "./adapters/glassAdapter";
import { GmailAdapterImpl } from "./adapters/gmailAdapter";
import { GmailAuthService } from "./services/gmailAuthService";
import { BridgeHostStorage } from "./services/hostStorage";
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
    localStorage.setItem(RELAY_AUTH_KEY, "1");
    startUrl.searchParams.delete("startauth");
    window.history.replaceState({}, "", startUrl.pathname + startUrl.hash);
    await auth.startAuth(); // Normal redirect (we're in a real browser now)
    return; // Page navigates away to Google
  }

  // --- Gmail OAuth: handle redirect before anything else ---
  const isRelayAuth = !!localStorage.getItem(RELAY_AUTH_KEY);
  let wasOAuthRedirect = false;
  let oauthError: string | null = null;
  try {
    wasOAuthRedirect = await auth.handleRedirectIfPresent();
  } catch (err: unknown) {
    console.error("[main] OAuth redirect handling failed:", err);
    oauthError = String(err);
    setPhoneState("error", `Sign-in failed: ${oauthError}`);
  }

  // --- Relay auth completion: show token (or error) for user to copy back ---
  if (isRelayAuth && (wasOAuthRedirect || oauthError)) {
    localStorage.removeItem(RELAY_AUTH_KEY);
    const refreshToken = localStorage.getItem(STORAGE_KEYS.refreshToken) ?? "";
    const phoneUI = new PhoneUI({
      onSignIn: async () => {},
      onSignInRelay: () => {},
      onSignOut: () => {},
      onImportToken: () => {},
      isAuthenticated: () => false,
      getEmail: async () => "",
    });
    if (oauthError) {
      phoneUI.showRelayTokenScreen(`ERROR: ${oauthError}`);
    } else {
      phoneUI.showRelayTokenScreen(refreshToken);
    }
    return; // Don't start glasses controller — this is the system browser
  }

  const glass = new GlassAdapterImpl();
  const gmail = new GmailAdapterImpl(auth);
  const wakeLock = new WakeLockServiceImpl();
  const controller = new Controller({ glass, gmail, auth, wakeLock });

  // --- Initialize phone UI immediately ---
  const phoneUI = new PhoneUI({
    onSignIn: async () => {
      await auth.startAuth();
      // startAuth() redirects — we only reach here if something failed
    },
    onSignInRelay: () => {
      const relayUrl = `${GMAIL_CONFIG.REDIRECT_URI}?startauth=1`;
      phoneUI.showTokenPasteScreen(relayUrl);
    },
    onSignOut: async () => {
      await auth.signOut();
      try {
        await phoneUI.showAuthenticated();
      } catch {
        // ignore — getEmail will fail when unauthenticated
      }
      setPhoneState("connected", "Signed out");
    },
    onImportToken: async (token: string) => {
      await auth.importRefreshToken(token);

      // Verify the WebView actually persisted the token. Some hosts return a
      // working localStorage object whose values evaporate on the next read,
      // which is what causes the relay-auth loop the user reported.
      if (localStorage.getItem(STORAGE_KEYS.refreshToken) !== token) {
        setPhoneState(
          "error",
          "Could not save token",
          "Storage unavailable in this WebView",
        );
        return;
      }

      try {
        await phoneUI.showAuthenticated();
      } catch (err: unknown) {
        console.error("[main] Post-import setup failed:", err);
      }
      setPhoneState("connected", "Signed in — loading labels...");

      try {
        await controller.refreshAfterAuth();
        setPhoneState("connected", "Connected");
      } catch (err: unknown) {
        console.error("[main] Post-import glasses refresh failed:", err);
        setPhoneState(
          "connected",
          "Signed in — glasses offline",
          String(err).slice(0, 300),
        );
      }
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
      // Bridge is now ready. Wire host-backed storage and recover any
      // refresh token from a previous Even App session that the WebView's
      // localStorage may have dropped.
      const bridge = glass.getBridge();
      let hydrated = false;
      if (bridge) {
        auth.setHostStorage(new BridgeHostStorage(bridge));
        try {
          const wasAuthed = auth.isAuthenticated();
          await auth.hydrateFromHostStorage();
          hydrated = !wasAuthed && auth.isAuthenticated();
        } catch (err: unknown) {
          console.error("[main] Host-storage hydrate failed:", err);
        }
      }

      setPhoneState("connected", "Connected");

      if (hydrated) {
        try {
          await phoneUI.showAuthenticated();
        } catch (err: unknown) {
          console.error("[main] showAuthenticated after hydrate failed:", err);
        }
      }

      if (auth.isAuthenticated()) {
        try {
          await controller.refreshAfterAuth();
        } catch (err: unknown) {
          console.error("[main] Post-auth glasses refresh failed:", err);
          setPhoneState(
            "connected",
            "Signed in — glasses offline",
            String(err).slice(0, 300),
          );
        }
      }
    })
    .catch((err: unknown) => {
      console.error("[main] Glass bridge failed:", err);
      setPhoneState(
        auth.isAuthenticated() ? "connected" : "error",
        auth.isAuthenticated() ? "Signed in — glasses offline" : "Glasses not connected",
        String(err).slice(0, 300),
      );
    });
}

void bootstrap().catch((error: unknown) => {
  setPhoneState("error", "Failed to start", String(error));
  console.error("G2-mail failed to start", error);
});
