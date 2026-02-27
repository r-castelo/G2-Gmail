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
      console.error("[controller] Failed to load labels:", err);
      this.state.setError(APP_TEXT.errorGeneric);
      await this.glass.showMessage(`${APP_TEXT.errorGeneric}\n${APP_TEXT.tapToRetry}`);
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
    // List scroll is handled by firmware
    if (gesture.kind === "SCROLL_FWD" || gesture.kind === "SCROLL_BACK") {
      return;
    }

    if (gesture.kind === "TAP") {
      await this.handleLabelTap(gesture.listIndex);
    }
  }

  private async handleLabelTap(listIndex?: number): Promise<void> {
    const idx = listIndex ?? 0;
    const label = this.state.getLabelAtIndex(idx);
    if (!label) return;

    await this.loadMessages(label.id, label.name);
  }

  private async loadMessages(labelId: string, labelName: string): Promise<void> {
    try {
      await this.glass.showMessage(APP_TEXT.loadingMessages);
      const result = await this.gmail.listMessages(labelId, MESSAGES_PER_PAGE);

      if (result.messages.length === 0) {
        this.state.setMessages(labelId, labelName, [], undefined);
        await this.glass.showMessage(APP_TEXT.emptyLabel);
        // Still set mode to MESSAGE_LIST so DOUBLE_TAP goes back to labels
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
      console.error("[controller] Failed to load messages:", err);
      this.state.setError(APP_TEXT.errorGeneric);
      await this.glass.showMessage(`${APP_TEXT.errorGeneric}\n${APP_TEXT.tapToRetry}`);
    }
  }

  // --- Message list mode ---

  private async handleMessageList(gesture: GestureEvent): Promise<void> {
    // List scroll is handled by firmware
    if (gesture.kind === "SCROLL_FWD" || gesture.kind === "SCROLL_BACK") {
      return;
    }

    if (gesture.kind === "DOUBLE_TAP") {
      // Go back to labels
      this.state.backToLabels();
      await this.renderLabels();
      return;
    }

    if (gesture.kind === "TAP") {
      await this.handleMessageTap(gesture.listIndex);
    }
  }

  private async handleMessageTap(listIndex?: number): Promise<void> {
    const idx = listIndex ?? 0;
    const msg = this.state.getMessageAtIndex(idx);
    if (!msg) return;

    await this.openMessage(msg.id);
  }

  private async openMessage(messageId: string): Promise<void> {
    try {
      await this.glass.showMessage(APP_TEXT.loadingMessage);
      const full = await this.gmail.getMessage(messageId);

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
      console.error("[controller] Failed to open message:", err);
      // Go back to message list
      await this.renderMessageList();
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

  private async renderLabels(): Promise<void> {
    const items = this.state.getLabelDisplayItems();
    const count = this.state.snapshot.labels.length;
    await this.glass.showLabels(items, `${count} labels`);
  }

  private async renderMessageList(): Promise<void> {
    const items = this.state.getMessageDisplayItems();
    const labelName = this.state.snapshot.currentLabelName;
    const count = items.length;
    const status = `${labelName} (${count})`;
    await this.glass.showMessageList(items, status);
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
