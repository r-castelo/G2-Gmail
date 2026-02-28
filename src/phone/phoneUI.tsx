import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Chip,
  Text,
} from "@jappyjan/even-realities-ui";
import {
  IconBase,
  LogOutIcon,
  LoginIcon,
} from "@jappyjan/even-realities-ui/icons";
import { useCallback, useState, useSyncExternalStore, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import "./phoneUI.css";

// ── Public API ─────────────────────────────────────────────────

export interface PhoneUIOptions {
  onSignIn: () => Promise<void>;
  onSignOut: () => void;
  onImportToken: (token: string) => void;
  isAuthenticated: () => boolean;
  getEmail: () => Promise<string>;
}

// ── Phone status (module-level, shared with main.ts) ───────────

type PhoneState = "connecting" | "connected" | "error";

interface PhoneStatusSnapshot {
  state: PhoneState;
  text: string;
  detail: string;
}

let currentPhoneStatus: PhoneStatusSnapshot = {
  state: "connecting",
  text: "Connecting to glasses...",
  detail: "",
};

const statusListeners = new Set<() => void>();

function subscribeStatus(listener: () => void): () => void {
  statusListeners.add(listener);
  return () => {
    statusListeners.delete(listener);
  };
}

function emitStatus(): void {
  for (const listener of statusListeners) {
    listener();
  }
}

export function setPhoneState(state: PhoneState, text: string, detail?: string): void {
  currentPhoneStatus = {
    state,
    text,
    detail: detail ?? "",
  };
  emitStatus();
}

// ── Snapshot type ──────────────────────────────────────────────

type ViewMode = "normal" | "token-paste" | "token-relay";

interface PhoneUISnapshot {
  status: PhoneStatusSnapshot;
  isAuthenticated: boolean;
  email: string;
  viewMode: ViewMode;
  relayToken: string;
}

// ── PhoneUI controller ────────────────────────────────────────

export class PhoneUI {
  private readonly onSignIn: () => Promise<void>;
  private readonly onSignOut: () => void;
  private readonly onImportTokenFn: (token: string) => void;
  private readonly isAuthenticatedFn: () => boolean;
  private readonly getEmailFn: () => Promise<string>;

  private readonly root: Root;
  private readonly listeners = new Set<() => void>();

  private email = "";
  private viewMode: ViewMode = "normal";
  private relayToken = "";
  private cachedSnapshot!: PhoneUISnapshot;

  constructor(options: PhoneUIOptions) {
    this.onSignIn = options.onSignIn;
    this.onSignOut = options.onSignOut;
    this.onImportTokenFn = options.onImportToken;
    this.isAuthenticatedFn = options.isAuthenticated;
    this.getEmailFn = options.getEmail;

    this.cachedSnapshot = this.buildSnapshot();

    subscribeStatus(() => {
      this.emit();
    });

    const appElement = document.getElementById("app");
    if (!appElement) {
      throw new Error("Missing #app mount element");
    }

    this.root = createRoot(appElement);
    this.root.render(<PhoneUIApp ui={this} />);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): PhoneUISnapshot {
    return this.cachedSnapshot;
  }

  private buildSnapshot(): PhoneUISnapshot {
    return {
      status: currentPhoneStatus,
      isAuthenticated: this.isAuthenticatedFn(),
      email: this.email,
      viewMode: this.viewMode,
      relayToken: this.relayToken,
    };
  }

  /** Called after successful auth to show authenticated state. */
  async showAuthenticated(): Promise<void> {
    try {
      this.email = await this.getEmailFn();
    } catch {
      this.email = "Signed in";
    }

    this.emit();
  }

  async handleSignIn(): Promise<void> {
    try {
      await this.onSignIn();
    } catch (err: unknown) {
      const msg = String(err);
      if (!msg.includes("Redirecting")) {
        setPhoneState("error", "Sign in failed", msg);
      }
    }
  }

  handleSignOut(): void {
    this.onSignOut();
    this.email = "";
    this.viewMode = "normal";
    this.emit();
  }

  handleImportToken(token: string): void {
    this.onImportTokenFn(token);
    this.viewMode = "normal";
    this.emit();
  }

  /** Show the "paste token" screen (WebView side of relay flow). */
  showTokenPasteScreen(): void {
    this.viewMode = "token-paste";
    this.emit();
  }

  /** Show the "copy token" screen (system browser side of relay flow). */
  showRelayTokenScreen(token: string): void {
    this.relayToken = token;
    this.viewMode = "token-relay";
    this.emit();
  }

  private emit(): void {
    this.cachedSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ── React hooks ───────────────────────────────────────────────

function usePhoneUISnapshot(ui: PhoneUI): PhoneUISnapshot {
  const subscribe = useCallback((cb: () => void) => ui.subscribe(cb), [ui]);
  const getSnapshot = useCallback(() => ui.getSnapshot(), [ui]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

// ── Root app component ────────────────────────────────────────

interface PhoneUIAppProps {
  ui: PhoneUI;
}

function PhoneUIApp({ ui }: PhoneUIAppProps): JSX.Element {
  const snapshot = usePhoneUISnapshot(ui);

  return (
    <div className="er-phone-app">
      {snapshot.viewMode === "token-paste" && (
        <TokenPasteView
          onSubmit={(token) => {
            ui.handleImportToken(token);
          }}
        />
      )}
      {snapshot.viewMode === "token-relay" && (
        <TokenRelayView token={snapshot.relayToken} />
      )}
      {snapshot.viewMode === "normal" && (
        <AuthenticatedView
          snapshot={snapshot}
          onSignIn={() => {
            void ui.handleSignIn();
          }}
          onSignOut={() => {
            ui.handleSignOut();
          }}
        />
      )}
    </div>
  );
}

// ── Authenticated view (sign-in / account + status) ───────────

interface AuthenticatedViewProps {
  snapshot: PhoneUISnapshot;
  onSignIn: () => void;
  onSignOut: () => void;
}

function AuthenticatedView({
  snapshot,
  onSignIn,
  onSignOut,
}: AuthenticatedViewProps): JSX.Element {
  return (
    <div className="er-status-view">
      <Card>
        <CardHeader>
          <Text as="h1" variant="title-lg">G2-mail</Text>
          <Text as="p" variant="subtitle" className="er-muted-text">
            Gmail reader for Even Realities G2
          </Text>
        </CardHeader>

        <CardContent className="er-auth-content">
          {!snapshot.isAuthenticated && (
            <Button variant="accent" size="lg" onClick={onSignIn}>
              <LoginIcon size={16} />
              Sign in with Google
            </Button>
          )}

          {snapshot.isAuthenticated && (
            <div className="er-account-info">
              <Chip size="sm">{snapshot.email || "Signed in"}</Chip>
              <Button variant="default" size="sm" onClick={onSignOut}>
                <LogOutIcon size={14} />
                Sign out
              </Button>
            </div>
          )}
        </CardContent>

        <CardFooter>
          <Chip size="sm" className="er-status-chip">
            <StatusDot state={snapshot.status.state} />
            {snapshot.status.text}
          </Chip>
        </CardFooter>
      </Card>
    </div>
  );
}

// ── Token paste view (WebView side of relay auth) ─────────────

interface TokenPasteViewProps {
  onSubmit: (token: string) => void;
}

function TokenPasteView({ onSubmit }: TokenPasteViewProps): JSX.Element {
  const [token, setToken] = useState("");

  return (
    <div className="er-status-view">
      <Card>
        <CardHeader>
          <Text as="h1" variant="title-lg">G2-mail</Text>
          <Text as="p" variant="subtitle" className="er-muted-text">
            Paste sign-in token
          </Text>
        </CardHeader>
        <CardContent className="er-auth-content">
          <Text as="p">
            Complete sign-in in the browser that just opened,
            then copy the token and paste it here.
          </Text>
          <textarea
            className="er-token-textarea"
            placeholder="Paste token here..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            rows={4}
          />
          <Button
            variant="accent"
            size="lg"
            onClick={() => {
              const trimmed = token.trim();
              if (trimmed) onSubmit(trimmed);
            }}
          >
            Submit
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Token relay view (system browser side of relay auth) ───────

interface TokenRelayViewProps {
  token: string;
}

function TokenRelayView({ token }: TokenRelayViewProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(token).then(() => setCopied(true));
  };

  return (
    <div className="er-status-view">
      <Card>
        <CardHeader>
          <Text as="h1" variant="title-lg">G2-mail</Text>
          <Text as="p" variant="subtitle" className="er-muted-text">
            Sign-in complete
          </Text>
        </CardHeader>
        <CardContent className="er-auth-content">
          <Text as="p">
            Copy the token below and paste it in the G2-mail app.
          </Text>
          <textarea
            className="er-token-textarea"
            readOnly
            value={token}
            rows={4}
            onFocus={(e) => e.target.select()}
          />
          <Button variant="accent" size="lg" onClick={handleCopy}>
            {copied ? "Copied!" : "Copy token"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Status dot ────────────────────────────────────────────────

interface StatusDotProps {
  state: PhoneState;
}

function StatusDot({ state }: StatusDotProps): JSX.Element {
  return (
    <IconBase
      viewBox="0 0 12 12"
      size={12}
      className={`er-status-dot-${state}`}
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="5" fill="currentColor" />
    </IconBase>
  );
}
