import "@jappyjan/even-realities-ui/styles.css";
import { Controller } from "./app/controller";
import { GlassAdapterImpl } from "./adapters/glassAdapter";
import { GmailAdapterImpl } from "./adapters/gmailAdapter";
import { GmailAuthService } from "./services/gmailAuthService";
import { WakeLockServiceImpl } from "./services/wakeLockService";
import { PhoneUI, setPhoneState } from "./phone/phoneUI";

async function bootstrap(): Promise<void> {
  setPhoneState("connecting", "Starting...");

  // --- Gmail OAuth: handle redirect before anything else ---
  const auth = new GmailAuthService();
  let wasOAuthRedirect = false;
  try {
    wasOAuthRedirect = await auth.handleRedirectIfPresent();
  } catch (err: unknown) {
    console.error("[main] OAuth redirect handling failed:", err);
    setPhoneState("error", `Sign-in failed: ${String(err)}`);
    // Continue — still create PhoneUI so user can retry
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
    onSignOut: () => {
      auth.signOut();
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
