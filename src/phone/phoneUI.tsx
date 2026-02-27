import {
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  Chip,
  Divider,
  Text,
} from "@jappyjan/even-realities-ui";
import {
  EditIcon,
  EmailIcon,
  IconBase,
  InBoxIcon,
  LogOutIcon,
  LoginIcon,
  PinIcon,
  SavedIcon,
  ShareIcon,
  TrashIcon,
} from "@jappyjan/even-realities-ui/icons";
import React, { useEffect, useState, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { GmailLabel } from "../types/contracts";
import "./phoneUI.css";

// ── Public API ─────────────────────────────────────────────────

export interface PhoneUIOptions {
  onSignIn: () => Promise<void>;
  onSignOut: () => void;
  onLabelSelect: (label: GmailLabel) => void;
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

interface PhoneUISnapshot {
  status: PhoneStatusSnapshot;
  isAuthenticated: boolean;
  email: string;
  labels: GmailLabel[];
}

// ── PhoneUI controller ────────────────────────────────────────

export class PhoneUI {
  private readonly onSignIn: () => Promise<void>;
  private readonly onSignOut: () => void;
  private readonly onLabelSelect: (label: GmailLabel) => void;
  private readonly isAuthenticatedFn: () => boolean;
  private readonly getEmailFn: () => Promise<string>;

  private readonly root: Root;
  private readonly listeners = new Set<() => void>();

  private email = "";
  private labels: GmailLabel[] = [];

  constructor(options: PhoneUIOptions) {
    this.onSignIn = options.onSignIn;
    this.onSignOut = options.onSignOut;
    this.onLabelSelect = options.onLabelSelect;
    this.isAuthenticatedFn = options.isAuthenticated;
    this.getEmailFn = options.getEmail;

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
    return {
      status: currentPhoneStatus,
      isAuthenticated: this.isAuthenticatedFn(),
      email: this.email,
      labels: [...this.labels],
    };
  }

  /** Called after successful auth to show authenticated state. */
  async showAuthenticated(labels: GmailLabel[]): Promise<void> {
    this.labels = labels;

    try {
      this.email = await this.getEmailFn();
    } catch {
      this.email = "Signed in";
    }

    this.emit();
  }

  /** Update labels list (e.g., after refresh). */
  setLabels(labels: GmailLabel[]): void {
    this.labels = labels;
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
    this.labels = [];
    this.emit();
  }

  handleLabelSelect(label: GmailLabel): void {
    this.onLabelSelect(label);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

// ── React hooks ───────────────────────────────────────────────

function usePhoneUISnapshot(ui: PhoneUI): PhoneUISnapshot {
  const [snapshot, setSnapshot] = useState<PhoneUISnapshot>(() => ui.getSnapshot());

  useEffect(() => {
    return ui.subscribe(() => {
      setSnapshot(ui.getSnapshot());
    });
  }, [ui]);

  return snapshot;
}

// ── Root app component ────────────────────────────────────────

interface PhoneUIAppProps {
  ui: PhoneUI;
}

function PhoneUIApp({ ui }: PhoneUIAppProps): JSX.Element {
  const snapshot = usePhoneUISnapshot(ui);

  return (
    <div className="er-phone-app">
      <AuthenticatedView
        snapshot={snapshot}
        onSignIn={() => {
          void ui.handleSignIn();
        }}
        onSignOut={() => {
          ui.handleSignOut();
        }}
        onLabelSelect={(label) => {
          ui.handleLabelSelect(label);
        }}
      />
    </div>
  );
}

// ── Status-only view (pre-auth) ───────────────────────────────

interface StatusOnlyViewProps {
  status: PhoneStatusSnapshot;
}

function StatusOnlyView({ status }: StatusOnlyViewProps): JSX.Element {
  return (
    <div className="er-status-view">
      <Card>
        <CardHeader>
          <Text as="h1" variant="title-lg">G2 Gmail</Text>
          <Text as="p" variant="subtitle" className="er-muted-text">
            Gmail reader for Even Realities G2
          </Text>
        </CardHeader>
        <CardContent className="er-status-content">
          <Chip size="lg" className="er-status-chip">
            <StatusDot state={status.state} />
            {status.text}
          </Chip>
          {status.detail.length > 0 && (
            <Text as="p" variant="detail" className="er-muted-text">
              {status.detail}
            </Text>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Authenticated view (sign-in / account / labels) ───────────

interface AuthenticatedViewProps {
  snapshot: PhoneUISnapshot;
  onSignIn: () => void;
  onSignOut: () => void;
  onLabelSelect: (label: GmailLabel) => void;
}

function AuthenticatedView({
  snapshot,
  onSignIn,
  onSignOut,
  onLabelSelect,
}: AuthenticatedViewProps): JSX.Element {
  return (
    <div className="er-status-view">
      <Card>
        <CardHeader>
          <Text as="h1" variant="title-lg">G2 Gmail</Text>
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
            <>
              <div className="er-account-info">
                <Chip size="sm">{snapshot.email || "Signed in"}</Chip>
                <Button variant="default" size="sm" onClick={onSignOut}>
                  <LogOutIcon size={14} />
                  Sign out
                </Button>
              </div>

              {snapshot.labels.length > 0 && (
                <>
                  <Divider />
                  <LabelList
                    labels={snapshot.labels}
                    onLabelSelect={onLabelSelect}
                  />
                </>
              )}
            </>
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

// ── Label list ────────────────────────────────────────────────

interface LabelListProps {
  labels: GmailLabel[];
  onLabelSelect: (label: GmailLabel) => void;
}

function LabelList({ labels, onLabelSelect }: LabelListProps): JSX.Element {
  return (
    <div className="er-label-list">
      <Text as="h2" variant="title-2">Labels</Text>
      {labels.map((label) => (
        <Button
          key={label.id}
          variant="default"
          size="md"
          className="er-label-entry"
          onClick={() => {
            onLabelSelect(label);
          }}
        >
          <span className="er-label-icon">
            <LabelIcon labelId={label.id} />
          </span>
          <span className="er-label-text">
            <Text variant="body-2">{label.name}</Text>
          </span>
          {label.messagesUnread != null && label.messagesUnread > 0 && (
            <Badge>{label.messagesUnread}</Badge>
          )}
        </Button>
      ))}
    </div>
  );
}

// ── Label icon mapping ────────────────────────────────────────

const LABEL_ICON_MAP: Record<string, React.ComponentType<{ size: number }>> = {
  INBOX: InBoxIcon,
  STARRED: SavedIcon,
  SENT: ShareIcon,
  DRAFT: EditIcon,
  SPAM: EmailIcon,
  TRASH: TrashIcon,
  IMPORTANT: PinIcon,
  UNREAD: EmailIcon,
};

interface LabelIconProps {
  labelId: string;
}

function LabelIcon({ labelId }: LabelIconProps): JSX.Element {
  const Icon = LABEL_ICON_MAP[labelId] ?? EmailIcon;
  return <Icon size={16} />;
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
