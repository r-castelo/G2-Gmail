import "@jappyjan/even-realities-ui/styles.css";
import { waitForEvenAppBridge } from "@evenrealities/even_hub_sdk";
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

// Wait for the Even App bridge with a hard ceiling so browser/sim dev
// (where the bridge never appears) doesn't hang the launch UI.
async function waitForBridgeWithTimeout(ms: number) {
  return Promise.race([
    waitForEvenAppBridge(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

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

  // --- Hydrate auth state from host storage BEFORE anything reads it ---
  //
  // The Even App WebView wipes browser localStorage between sessions, so
  // a previously-saved refresh token only lives in the host store. We
  // have to copy it back into localStorage before constructing the phone
  // UI or starting the glasses controller — otherwise both make their
  // auth decision against an empty localStorage and the user sees "Sign
  // in from phone" even though the token is sitting right there.
  const earlyBridge = await waitForBridgeWithTimeout(4000);
  if (earlyBridge) {
    auth.setHostStorage(new BridgeHostStorage(earlyBridge));
    try {
      await auth.hydrateFromHostStorage();
    } catch (err: unknown) {
      console.error("[main] early hydrate failed:", err);
    }
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
      // Make sure host storage is wired up BEFORE writing the token; otherwise
      // a fast-paste user races the bridge connection and the token only
      // lands in localStorage (which the WebView wipes between Even App
      // sessions). Awaiting the start promise here is idempotent — if it's
      // already resolved we proceed immediately.
      try {
        await startPromise;
      } catch {
        // bridge unavailable — fall through and write what we can
      }
      const bridge = glass.getBridge();
      if (bridge) {
        auth.setHostStorage(new BridgeHostStorage(bridge));
      }

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

      // Confirm the token reached host storage too — otherwise the next
      // Even App restart will lose it and force the user to relay-auth again.
      if (bridge) {
        const stored = await new BridgeHostStorage(bridge)
          .get(STORAGE_KEYS.refreshToken)
          .catch(() => null);
        if (stored !== token) {
          setPhoneState(
            "connected",
            "Signed in — host storage unavailable",
            "Token will be lost when Even App restarts.",
          );
        }
      } else {
        setPhoneState(
          "connected",
          "Signed in — bridge unavailable",
          "Token will be lost when Even App restarts.",
        );
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

  // If we launched already authenticated (host-storage hydrate or a
  // just-completed OAuth redirect), kick off the email-address fetch so
  // the phone UI shows the actual address instead of a bare "Signed in"
  // label. Fire-and-forget — the constructor snapshot already has the
  // correct auth flag, and a failed profile fetch shouldn't block boot.
  if (wasOAuthRedirect || auth.isAuthenticated()) {
    void phoneUI.showAuthenticated().catch((err: unknown) => {
      console.error("[main] showAuthenticated on launch failed:", err);
    });
  }

  // Connect glasses in background — don't block the phone UI. We capture
  // the promise so onImportToken can await it and avoid a race where the
  // token is written before host storage is wired up. Hydration already
  // ran above, so this .then only needs to refresh after sign-ins that
  // happen mid-session (relay paste, etc.).
  const startPromise = controller.start();
  startPromise
    .then(async () => {
      setPhoneState("connected", "Connected");

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
