import { APP_TEXT, MESSAGES_PER_PAGE, TEXT_LAYOUT } from "../config/constants";
import { htmlToPlainText } from "../domain/htmlToText";
import { paginate, wrapLines } from "../domain/paginate";
import { GmailStateMachine } from "./state";
import type {
  GestureEvent,
  GlassAdapter,
  GmailAdapter,
  StatusBar,
  Unsubscribe,
} from "../types/contracts";
import type { GmailAuthService } from "../services/gmailAuthService";
import type { WakeLockService } from "../services/wakeLockService";

export interface ControllerOptions {
  glass: GlassAdapter;
  gmail: GmailAdapter;
  auth: GmailAuthService;
  wakeLock?: WakeLockService;
}

export class Controller {
  private readonly glass: GlassAdapter;
  private readonly gmail: GmailAdapter;
  private readonly auth: GmailAuthService;
  private readonly wakeLock: WakeLockService | null;
  private readonly state = new GmailStateMachine();

  private unsubscribeGesture: Unsubscribe | null = null;
  private gestureQueue: Promise<void> = Promise.resolve();
  private started = false;

  constructor(options: ControllerOptions) {
    this.glass = options.glass;
    this.gmail = options.gmail;
    this.auth = options.auth;
    this.wakeLock = options.wakeLock ?? null;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.glass.connect();

    this.unsubscribeGesture = this.glass.onGesture((gesture) => {
      this.gestureQueue = this.gestureQueue
        .then(() => this.handleGesture(gesture))
        .catch((err: unknown) => {
          console.error("Gesture handling failed:", err);
        });
    });

    await this.bootstrap();
  }

  /** Refresh the glasses display after auth completes from phone UI. */
  async refreshAfterAuth(): Promise<void> {
    await this.loadLabels();
  }

  get currentMode() {
    return this.state.mode;
  }

  // --- Bootstrap ---

  private async bootstrap(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      this.state.setAuthRequired();
      await this.glass.showMessage(APP_TEXT.authRequired);
      return;
    }

    await this.loadLabels();
  }

  private async loadLabels(): Promise<void> {
    try {
      await this.glass.showMessage(APP_TEXT.loadingLabels);
      const labels = await this.gmail.listLabels();
      this.state.setLabels(labels);
      await this.renderLabels();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[controller] Failed to load labels:", msg);
      this.state.setError(msg);
      await this.glass.showMessage(`Labels error:\n${msg.slice(0, 200)}\n\nTap to retry`);
    }
  }

  // --- Gesture dispatch ---

  private async handleGesture(gesture: GestureEvent): Promise<void> {
    // Foreground lifecycle events
    if (gesture.kind === "FOREGROUND_ENTER") {
      await this.handleForegroundEnter();
      return;
    }
    if (gesture.kind === "FOREGROUND_EXIT") {
      await this.handleForegroundExit();
      return;
    }

    const mode = this.state.mode;

    if (mode === "LABELS") {
      await this.handleLabels(gesture);
      return;
    }

    if (mode === "MESSAGE_LIST") {
      await this.handleMessageList(gesture);
      return;
    }

    if (mode === "READER") {
      await this.handleReader(gesture);
      return;
    }

    if (mode === "AUTH_REQUIRED" && gesture.kind === "TAP") {
      // Re-check auth (user may have signed in from phone)
      if (this.auth.isAuthenticated()) {
        await this.loadLabels();
      }
      return;
    }

    if (mode === "ERROR" && gesture.kind === "TAP") {
      await this.loadLabels();
    }
  }

  // --- Labels mode ---

  private async handleLabels(gesture: GestureEvent): Promise<void> {
    if (gesture.kind === "SCROLL_FWD") {
      if (this.state.moveLabelCursor(1)) {
        await this.renderLabelListUpdate();
      }
      return;
    }

    if (gesture.kind === "SCROLL_BACK") {
      if (this.state.moveLabelCursor(-1)) {
        await this.renderLabelListUpdate();
      }
      return;
    }

    if (gesture.kind === "TAP") {
      const label = this.state.getLabelAtCursor();
      if (label) await this.loadMessages(label.id, label.name);
    }
  }

  private async loadMessages(labelId: string, labelName: string): Promise<void> {
    try {
      await this.glass.showMessage(`Loading ${labelName}...`);
      console.log(`[controller] loadMessages: labelId=${labelId}`);

      const result = await this.gmail.listMessages(
        labelId,
        MESSAGES_PER_PAGE,
        undefined,
        (step) => this.glass.showMessage(`Loading ${labelName}...\n${step}`),
      );
      console.log(`[controller] got ${result.messages.length} messages`);

      if (result.messages.length === 0) {
        this.state.setMessages(labelId, labelName, [], undefined);
        await this.glass.showMessage(APP_TEXT.emptyLabel);
        return;
      }

      this.state.setMessages(
        labelId,
        labelName,
        result.messages,
        result.nextPageToken,
      );

      await this.renderMessageList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[controller] Failed to load messages:", msg);
      this.state.setError(msg);
      await this.glass.showMessage(`Error: ${msg}\n\nTap to retry`);
    }
  }

  // --- Message list mode ---

  private async handleMessageList(gesture: GestureEvent): Promise<void> {
    if (gesture.kind === "SCROLL_FWD") {
      if (this.state.moveMessageCursor(1)) {
        await this.renderMessageListUpdate();
      } else if (this.state.cursorAtEnd && this.state.hasMoreMessages) {
        await this.loadMoreMessages();
      }
      return;
    }

    if (gesture.kind === "SCROLL_BACK") {
      if (this.state.moveMessageCursor(-1)) {
        await this.renderMessageListUpdate();
      }
      return;
    }

    if (gesture.kind === "DOUBLE_TAP") {
      // Go back to labels
      this.state.backToLabels();
      await this.renderLabels();
      return;
    }

    if (gesture.kind === "TAP") {
      const msg = this.state.getMessageAtCursor();
      if (msg) await this.openMessage(msg.id);
    }
  }

  /**
   * Lazy-load next page of messages when cursor reaches the end.
   */
  private async loadMoreMessages(): Promise<void> {
    const { currentLabelId, currentLabelName, nextPageToken } = this.state.snapshot;
    if (!nextPageToken) return;

    try {
      await this.glass.updateMessageListText(
        this.state.getMessageListText().replace(/\n*$/, "\n  Loading..."),
        this.messageListStatus(),
      );

      const result = await this.gmail.listMessages(
        currentLabelId,
        MESSAGES_PER_PAGE,
        nextPageToken,
      );

      this.state.appendMessages(result.messages, result.nextPageToken);
      // Move cursor to first message of newly loaded page
      this.state.moveMessageCursor(1);
      await this.renderMessageListUpdate();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[controller] Failed to load more messages:", msg);
      // Show error briefly then restore list
      await this.renderMessageListUpdate();
    }
  }

  private async openMessage(messageId: string): Promise<void> {
    try {
      await this.glass.showMessage(APP_TEXT.loadingMessage);
      const full = await this.gmail.getMessage(messageId);

      // Mark as read (fire-and-forget, don't block reader)
      this.gmail.markAsRead(messageId).catch((err) =>
        console.error("[controller] Failed to mark as read:", err),
      );
      this.state.markMessageRead(messageId);

      // Convert body to plain text lines
      const bodyLines = htmlToPlainText(full.bodyHtml, full.bodyText);

      // Prepend email header
      const headerLines = [
        `From: ${full.from}`,
        `To: ${full.to}`,
        `Date: ${full.date}`,
        `Subject: ${full.subject}`,
        "",
      ];

      const allLines = [...headerLines, ...bodyLines];
      const wrapped = wrapLines(allLines, TEXT_LAYOUT.CHARS_PER_LINE);
      const pages = paginate(wrapped, TEXT_LAYOUT.LINES_PER_PAGE);

      this.state.enterReader(messageId, full.subject, pages);
      await this.renderReaderFull();
      await this.wakeLock?.acquire();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[controller] Failed to open message:", msg);
      this.state.setError(msg);
      await this.glass.showMessage(`Read error:\n${msg.slice(0, 200)}\n\nTap to retry`);
    }
  }

  // --- Reader mode ---

  private async handleReader(gesture: GestureEvent): Promise<void> {
    if (gesture.kind === "SCROLL_FWD") {
      if (this.state.nextPage()) {
        await this.renderReaderUpdate();
      }
      return;
    }

    if (gesture.kind === "SCROLL_BACK") {
      if (this.state.prevPage()) {
        await this.renderReaderUpdate();
      }
      return;
    }

    if (gesture.kind === "TAP" || gesture.kind === "DOUBLE_TAP") {
      // Go back to message list
      this.state.backToMessageList();
      await this.wakeLock?.release();
      await this.renderMessageList();
    }
  }

  // --- Rendering ---

  private labelListStatus(): string {
    return `${this.state.snapshot.labels.length} labels`;
  }

  private async renderLabels(): Promise<void> {
    const text = this.state.getLabelListText();
    await this.glass.showLabels([text], this.labelListStatus());
  }

  private async renderLabelListUpdate(): Promise<void> {
    const text = this.state.getLabelListText();
    await this.glass.updateLabelListText(text, this.labelListStatus());
  }

  private messageListStatus(): string {
    const labelName = this.state.snapshot.currentLabelName;
    const count = this.state.snapshot.messages.length;
    const more = this.state.hasMoreMessages ? "+" : "";
    return `${labelName} (${count}${more})`;
  }

  private async renderMessageList(): Promise<void> {
    const text = this.state.getMessageListText();
    await this.glass.showMessageList([text], this.messageListStatus());
  }

  private async renderMessageListUpdate(): Promise<void> {
    const text = this.state.getMessageListText();
    await this.glass.updateMessageListText(text, this.messageListStatus());
  }

  private async renderReaderFull(): Promise<void> {
    const view = this.state.getReaderView(TEXT_LAYOUT.LINES_PER_PAGE);
    const status = this.formatReaderStatus(
      view.currentPage,
      view.totalPages,
      view.subject,
    );
    await this.glass.showReader(view.pageText, status);
  }

  private async renderReaderUpdate(): Promise<void> {
    const view = this.state.getReaderView(TEXT_LAYOUT.LINES_PER_PAGE);
    const status = this.formatReaderStatus(
      view.currentPage,
      view.totalPages,
      view.subject,
    );
    await this.glass.updateReaderText(view.pageText, status);
  }

  private formatReaderStatus(
    page: number,
    total: number,
    subject: string,
  ): StatusBar {
    const name =
      subject.length > 36 ? `${subject.slice(0, 33)}...` : subject;
    return {
      left: name,
      right: `${page + 1}/${total}`,
    };
  }

  // --- Foreground lifecycle ---

  private async handleForegroundEnter(): Promise<void> {
    console.log("[controller] Foreground enter");
    const mode = this.state.mode;

    if (mode === "READER") {
      await this.wakeLock?.acquire();
      await this.renderReaderFull();
    } else if (mode === "MESSAGE_LIST") {
      await this.renderMessageList();
    } else if (mode === "LABELS") {
      await this.renderLabels();
    }
  }

  private async handleForegroundExit(): Promise<void> {
    console.log("[controller] Foreground exit");
    await this.wakeLock?.release();
  }
}
