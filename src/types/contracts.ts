export type Unsubscribe = () => void;

export type AppMode =
  | "BOOT"
  | "AUTH_REQUIRED"
  | "LABELS"
  | "MESSAGE_LIST"
  | "READER"
  | "ERROR";

export type GestureKind =
  | "SCROLL_FWD"
  | "SCROLL_BACK"
  | "TAP"
  | "DOUBLE_TAP"
  | "FOREGROUND_ENTER"
  | "FOREGROUND_EXIT";

export interface GestureEvent {
  kind: GestureKind;
  /** Firmware-reported list selection index (from listEvent on TAP). */
  listIndex?: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface GmailMessageHeader {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  isUnread: boolean;
}

export interface GmailMessageFull {
  id: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  bodyText: string;
  bodyHtml: string;
}

export interface StatusBar {
  left: string;
  right: string;
}

export interface GlassAdapter {
  connect(): Promise<void>;
  onGesture(handler: (event: GestureEvent) => void): Unsubscribe;
  showLabels(items: string[], statusText: string): Promise<void>;
  showMessageList(items: string[], statusText: string): Promise<void>;
  showReader(pageText: string, status: StatusBar): Promise<void>;
  updateReaderText(pageText: string, status: StatusBar): Promise<void>;
  showMessage(text: string): Promise<void>;
}

export interface GmailAdapter {
  getProfile(): Promise<string>;
  listLabels(): Promise<GmailLabel[]>;
  listMessages(
    labelId: string,
    maxResults?: number,
    pageToken?: string,
  ): Promise<{ messages: GmailMessageHeader[]; nextPageToken?: string }>;
  getMessage(messageId: string): Promise<GmailMessageFull>;
}
