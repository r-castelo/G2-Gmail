import "@jappyjan/even-realities-ui/styles.css";
import { Controller } from "./app/controller";
import { GlassAdapterImpl } from "./adapters/glassAdapter";
import { GmailAdapterImpl } from "./adapters/gmailAdapter";
import { GmailAuthService } from "./services/gmailAuthService";
import { WakeLockServiceImpl } from "./services/wakeLockService";
import { PhoneUI, setPhoneState } from "./phone/phoneUI";

async function bootstrap(): Promise<void> {
  setPhoneState("connecting", "Connecting to glasses...", "Open this page from Even App dev mode");

  // --- Gmail OAuth: handle redirect before anything else ---
  const auth = new GmailAuthService();
  const wasOAuthRedirect = await auth.handleRedirectIfPresent();

  const glass = new GlassAdapterImpl();
  const gmail = new GmailAdapterImpl(auth);
  const wakeLock = new WakeLockServiceImpl();
  const controller = new Controller({ glass, gmail, auth, wakeLock });

  // Start controller (connects bridge, checks auth, loads labels)
  await controller.start();
  setPhoneState("connected", "Connected");

  // --- Initialize phone UI ---
  const phoneUI = new PhoneUI({
    onSignIn: async () => {
      await auth.startAuth();
      // startAuth() redirects — we only reach here if something failed
    },
    onSignOut: () => {
      auth.signOut();
      window.location.reload();
    },
    onLabelSelect: (label) => {
      // Label selection from phone just shows it on the glasses
      console.log("[main] Phone selected label:", label.name);
    },
    isAuthenticated: () => auth.isAuthenticated(),
    getEmail: async () => gmail.getProfile(),
  });

  // If we just came back from OAuth, refresh the controller and show authenticated state
  if (wasOAuthRedirect || auth.isAuthenticated()) {
    try {
      if (wasOAuthRedirect) {
        console.log("[main] Returned from Google OAuth redirect");
        await controller.refreshAfterAuth();
      }

      const labels = await gmail.listLabels();
      await phoneUI.showAuthenticated(labels);
    } catch (err: unknown) {
      console.error("[main] Post-auth setup failed:", err);
      setPhoneState("error", "Failed to load Gmail", String(err));
    }
  }
}

void bootstrap().catch((error: unknown) => {
  setPhoneState("error", "Failed to start", String(error));
  console.error("G2 Gmail failed to start", error);
});
