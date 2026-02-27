import { SYSTEM_LABELS, TEXT_LAYOUT } from "../config/constants";
import type {
  AppMode,
  GmailLabel,
  GmailMessageHeader,
} from "../types/contracts";

export interface AppState {
  mode: AppMode;
  labels: GmailLabel[];
  labelDisplayItems: string[];
  currentLabelId: string;
  currentLabelName: string;
  messages: GmailMessageHeader[];
  messageDisplayItems: string[];
  nextPageToken?: string;
  currentMessageId: string;
  currentSubject: string;
  pages: string[][];
  currentPage: number;
  errorMessage: string | null;
}

export class GmailStateMachine {
  private state: AppState;

  constructor() {
    this.state = {
      mode: "BOOT",
      labels: [],
      labelDisplayItems: [],
      currentLabelId: "",
      currentLabelName: "",
      messages: [],
      messageDisplayItems: [],
      nextPageToken: undefined,
      currentMessageId: "",
      currentSubject: "",
      pages: [[""]],
      currentPage: 0,
      errorMessage: null,
    };
  }

  get mode(): AppMode {
    return this.state.mode;
  }

  get snapshot(): Readonly<AppState> {
    return this.state;
  }

  // --- Mode transitions ---

  setAuthRequired(): void {
    this.state.mode = "AUTH_REQUIRED";
    this.state.errorMessage = null;
  }

  setError(message: string): void {
    this.state.mode = "ERROR";
    this.state.errorMessage = message;
  }

  // --- Labels ---

  /**
   * Set labels and transition to LABELS mode.
   * System labels appear first (in SYSTEM_LABELS order), then user labels alphabetically.
   */
  setLabels(labels: GmailLabel[]): void {
    this.state.mode = "LABELS";
    this.state.errorMessage = null;

    // Sort: system labels first in defined order, then user labels alphabetically
    const systemOrder = new Map<string, number>(SYSTEM_LABELS.map((s, i) => [s.id, i]));
    const systemLabels: GmailLabel[] = [];
    const userLabels: GmailLabel[] = [];

    for (const label of labels) {
      if (systemOrder.has(label.id)) {
        systemLabels.push(label);
      } else if (label.type === "user") {
        userLabels.push(label);
      }
    }

    // Sort system labels by defined order
    systemLabels.sort((a, b) => {
      const aOrder = systemOrder.get(a.id) ?? 999;
      const bOrder = systemOrder.get(b.id) ?? 999;
      return aOrder - bOrder;
    });

    // Sort user labels alphabetically
    userLabels.sort((a, b) => a.name.localeCompare(b.name));

    // Use friendly names for system labels
    const systemNameMap = new Map<string, string>(SYSTEM_LABELS.map((s) => [s.id, s.name]));
    const friendlySystemLabels = systemLabels.map((l) => ({
      ...l,
      name: systemNameMap.get(l.id) ?? l.name,
    }));

    this.state.labels = [...friendlySystemLabels, ...userLabels];
    this.state.labelDisplayItems = this.state.labels.map((l) => {
      const unread = l.messagesUnread && l.messagesUnread > 0
        ? ` (${l.messagesUnread})`
        : "";
      const display = `${l.name}${unread}`;
      return display.length > TEXT_LAYOUT.CHARS_PER_LINE
        ? display.slice(0, TEXT_LAYOUT.CHARS_PER_LINE - 3) + "..."
        : display;
    });
  }

  /**
   * Get the label at a display index (used when firmware reports a list tap).
   */
  getLabelAtIndex(displayIndex: number): GmailLabel | null {
    return this.state.labels[displayIndex] ?? null;
  }

  getLabelDisplayItems(): string[] {
    return this.state.labelDisplayItems;
  }

  // --- Message List ---

  /**
   * Set messages for a label and transition to MESSAGE_LIST mode.
   * Display format: "* From · Subject..." (middle dot separator, * for unread)
   */
  setMessages(
    labelId: string,
    labelName: string,
    messages: GmailMessageHeader[],
    nextPageToken?: string,
  ): void {
    this.state.mode = "MESSAGE_LIST";
    this.state.currentLabelId = labelId;
    this.state.currentLabelName = labelName;
    this.state.messages = [...messages];
    this.state.nextPageToken = nextPageToken;
    this.state.errorMessage = null;

    this.state.messageDisplayItems = messages.map((msg) => {
      return this.formatMessageLine(msg);
    });
  }

  /**
   * Format a message as a single line for the list display.
   * Format: "* From · Subject..." — middle dot separator, no extra padding.
   */
  private formatMessageLine(msg: GmailMessageHeader): string {
    const maxLen = TEXT_LAYOUT.CHARS_PER_LINE;
    const unreadMarker = msg.isUnread ? "[u]" : "[r]";
    const from = msg.from.slice(0, 14);
    const prefix = `${unreadMarker} ${from} · `;
    const remaining = maxLen - prefix.length;
    const subject = msg.subject.length > remaining
      ? msg.subject.slice(0, remaining - 3) + "..."
      : msg.subject;
    return `${prefix}${subject}`;
  }

  /**
   * Get the message at a display index.
   */
  getMessageAtIndex(displayIndex: number): GmailMessageHeader | null {
    return this.state.messages[displayIndex] ?? null;
  }

  getMessageDisplayItems(): string[] {
    return this.state.messageDisplayItems;
  }

  // --- Reader ---

  /**
   * Enter reader mode with paginated content.
   * Prepends From/Subject/Date header lines.
   */
  enterReader(
    messageId: string,
    subject: string,
    pages: string[][],
  ): void {
    this.state.mode = "READER";
    this.state.currentMessageId = messageId;
    this.state.currentSubject = subject;
    this.state.pages = pages;
    this.state.currentPage = 0;
    this.state.errorMessage = null;
  }

  nextPage(): boolean {
    if (this.state.currentPage >= this.state.pages.length - 1) {
      return false;
    }
    this.state.currentPage++;
    return true;
  }

  prevPage(): boolean {
    if (this.state.currentPage <= 0) {
      return false;
    }
    this.state.currentPage--;
    return true;
  }

  getReaderView(linesPerPage: number): {
    currentPage: number;
    totalPages: number;
    pageText: string;
    subject: string;
  } {
    const page = this.state.pages[this.state.currentPage] ?? [""];
    const padded = [...page];
    while (padded.length < linesPerPage) {
      padded.push("");
    }

    return {
      currentPage: this.state.currentPage,
      totalPages: this.state.pages.length,
      pageText: padded.join("\n"),
      subject: this.state.currentSubject,
    };
  }

  // --- Navigation ---

  markMessageRead(messageId: string): void {
    const idx = this.state.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const msg = this.state.messages[idx]!;
    const updated = { ...msg, isUnread: false };
    this.state.messages[idx] = updated;
    this.state.messageDisplayItems[idx] = this.formatMessageLine(updated);
  }

  backToLabels(): void {
    this.state.mode = "LABELS";
    this.state.messages = [];
    this.state.messageDisplayItems = [];
    this.state.currentLabelId = "";
    this.state.currentLabelName = "";
  }

  backToMessageList(): void {
    this.state.mode = "MESSAGE_LIST";
    this.state.currentMessageId = "";
    this.state.currentSubject = "";
    this.state.pages = [[""]];
    this.state.currentPage = 0;
  }
}
