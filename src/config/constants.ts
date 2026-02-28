export const DISPLAY = {
  WIDTH: 576,
  HEIGHT: 288,
} as const;

export const GLASS_LAYOUT = {
  x: 8,
  y: 4,
  width: 560,
  height: 248,
  statusY: 256,
  statusHeight: 28,
} as const;

export const TEXT_LAYOUT = {
  /** Characters per display line. ~64 chars fills a 560px container at SDK default font. */
  CHARS_PER_LINE: 64,
  /** Lines per page. Aim for ~320-400 chars per page for comfortable reading. */
  LINES_PER_PAGE: 8,
} as const;

export const TIMING = {
  /** Scroll cooldown to prevent duplicate events (ms). Per Nick Ustinov notes. */
  SCROLL_COOLDOWN_MS: 300,
  /** Timeout waiting for EvenAppBridge connection (ms). */
  BRIDGE_TIMEOUT_MS: 15_000,
} as const;

export const CONTAINER_IDS = {
  content: 1,
  status: 2,
  statusRight: 3,
} as const;

export const CONTAINER_NAMES = {
  content: "content",
  status: "status",
  statusRight: "statusR",
} as const;

/** System labels shown first, in this order. */
export const SYSTEM_LABELS = [
  { id: "INBOX", name: "Inbox" },
  { id: "STARRED", name: "Starred" },
  { id: "SENT", name: "Sent" },
  { id: "DRAFT", name: "Drafts" },
  { id: "SPAM", name: "Spam" },
  { id: "TRASH", name: "Trash" },
  { id: "IMPORTANT", name: "Important" },
  { id: "UNREAD", name: "Unread" },
] as const;

/** Number of messages fetched per batch (matches LINES_PER_PAGE for lazy loading). */
export const MESSAGES_PER_PAGE = 8;

export const APP_TEXT = {
  booting: "Loading...",
  authRequired: "Sign in from phone",
  loadingLabels: "Loading labels...",
  loadingMessages: "Loading messages...",
  loadingMessage: "Loading email...",
  emptyLabel: "No messages",
  errorGeneric: "Something went wrong",
  tapToRetry: "Tap to retry",
} as const;

export const STORAGE_KEYS = {
  refreshToken: "g2_gmail.refresh_token",
  codeVerifier: "g2_gmail.code_verifier",
  preAuthState: "g2_gmail.pre_auth_state",
} as const;
