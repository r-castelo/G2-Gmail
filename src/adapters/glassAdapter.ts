import {
  CreateStartUpPageContainer,
  EvenAppBridge,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenHubEvent,
} from "@evenrealities/even_hub_sdk";
import {
  CONTAINER_IDS,
  CONTAINER_NAMES,
  GLASS_LAYOUT,
  TIMING,
} from "../config/constants";
import type { GestureEvent, GlassAdapter, StatusBar, Unsubscribe } from "../types/contracts";

type RenderMode = "labels" | "messageList" | "reader" | null;

/**
 * GlassAdapter implementation for Gmail reader.
 *
 * Key design decisions:
 * - createStartUpPageContainer called exactly once (first render)
 * - rebuildPageContainer only for mode changes (labels <-> messageList <-> reader)
 * - textContainerUpgrade for in-place page flips (no flash)
 * - 300ms scroll cooldown to prevent duplicate events
 * - CLICK_EVENT=0->undefined quirk handled
 * - DOUBLE_CLICK_EVENT mapped to DOUBLE_TAP for back navigation
 */
export class GlassAdapterImpl implements GlassAdapter {
  private bridge: EvenAppBridge | null = null;
  private unsubscribeHub: Unsubscribe | null = null;
  private startupDone = false;
  private currentMode: RenderMode = null;
  private readonly gestureHandlers = new Set<(e: GestureEvent) => void>();
  private lastScrollTime = 0;

  async connect(): Promise<void> {
    if (this.bridge) return;

    this.bridge = await this.waitForBridge();
    this.bindEvents();
  }

  onGesture(handler: (event: GestureEvent) => void): Unsubscribe {
    this.gestureHandlers.add(handler);
    return () => {
      this.gestureHandlers.delete(handler);
    };
  }

  /**
   * Show the label list on glasses.
   * Always rebuilds because list items can't be updated in-place.
   */
  async showLabels(items: string[], statusText: string): Promise<void> {
    const listContainer = new ListContainerProperty({
      xPosition: GLASS_LAYOUT.x,
      yPosition: GLASS_LAYOUT.y,
      width: GLASS_LAYOUT.width,
      height: GLASS_LAYOUT.height,
      containerID: CONTAINER_IDS.content,
      containerName: CONTAINER_NAMES.content,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemName: items,
        isItemSelectBorderEn: 1,
      }),
    });

    const statusContainer = this.makeStatusContainer(statusText);

    await this.renderContainers({
      listObject: [listContainer],
      textObject: [statusContainer],
    });
    this.currentMode = "labels";
  }

  /**
   * Show the message list on glasses.
   * Always rebuilds because list items can't be updated in-place.
   */
  async showMessageList(items: string[], statusText: string): Promise<void> {
    const listContainer = new ListContainerProperty({
      xPosition: GLASS_LAYOUT.x,
      yPosition: GLASS_LAYOUT.y,
      width: GLASS_LAYOUT.width,
      height: GLASS_LAYOUT.height,
      containerID: CONTAINER_IDS.content,
      containerName: CONTAINER_NAMES.content,
      isEventCapture: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length,
        itemName: items,
        isItemSelectBorderEn: 1,
      }),
    });

    const statusContainer = this.makeStatusContainer(statusText);

    await this.renderContainers({
      listObject: [listContainer],
      textObject: [statusContainer],
    });
    this.currentMode = "messageList";
  }

  /**
   * Show reader mode — full rebuild for mode change.
   * Uses 3 containers: content + left status (subject) + right status (page).
   */
  async showReader(pageText: string, status: StatusBar): Promise<void> {
    const readerContainer = new TextContainerProperty({
      xPosition: GLASS_LAYOUT.x,
      yPosition: GLASS_LAYOUT.y,
      width: GLASS_LAYOUT.width,
      height: GLASS_LAYOUT.height,
      containerID: CONTAINER_IDS.content,
      containerName: CONTAINER_NAMES.content,
      isEventCapture: 0,
      content: pageText.slice(0, 1000), // startup/rebuild limit: 1000 chars
    });

    const [statusLeft, statusRight] = this.makeSplitStatus(status);

    await this.renderContainers({
      textObject: [readerContainer, statusLeft, statusRight],
    });
    this.currentMode = "reader";
  }

  /**
   * Lightweight in-place text update for page flips.
   * Uses textContainerUpgrade — NO rebuild, NO flash.
   * Max 2000 chars per Nick Ustinov notes.
   */
  async updateReaderText(
    pageText: string,
    status: StatusBar,
  ): Promise<void> {
    if (!this.bridge) {
      throw new Error("Not connected");
    }

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_IDS.content,
        containerName: CONTAINER_NAMES.content,
        contentOffset: 0,
        contentLength: pageText.length,
        content: pageText.slice(0, 2000),
      }),
    );

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_IDS.status,
        containerName: CONTAINER_NAMES.status,
        contentOffset: 0,
        contentLength: status.left.length,
        content: status.left.slice(0, 2000),
      }),
    );

    await this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: CONTAINER_IDS.statusRight,
        containerName: CONTAINER_NAMES.statusRight,
        contentOffset: 0,
        contentLength: status.right.length,
        content: status.right.slice(0, 2000),
      }),
    );
  }

  /**
   * Show a simple text message with an empty status bar.
   * Always uses 2 containers to keep layout consistent.
   */
  async showMessage(text: string): Promise<void> {
    const msgContainer = new TextContainerProperty({
      xPosition: GLASS_LAYOUT.x,
      yPosition: GLASS_LAYOUT.y,
      width: GLASS_LAYOUT.width,
      height: GLASS_LAYOUT.height,
      containerID: CONTAINER_IDS.content,
      containerName: CONTAINER_NAMES.content,
      isEventCapture: 1,
      content: text.slice(0, 1000),
    });

    const statusContainer = this.makeStatusContainer("");

    await this.renderContainers({
      textObject: [msgContainer, statusContainer],
    });
    this.currentMode = null;
  }

  // --- Private ---

  private makeStatusContainer(text: string): TextContainerProperty {
    return new TextContainerProperty({
      xPosition: GLASS_LAYOUT.x,
      yPosition: GLASS_LAYOUT.statusY,
      width: GLASS_LAYOUT.width,
      height: GLASS_LAYOUT.statusHeight,
      containerID: CONTAINER_IDS.status,
      containerName: CONTAINER_NAMES.status,
      isEventCapture: 0,
      content: text.slice(0, 1000),
    });
  }

  /**
   * Create two status containers for reader mode:
   * - Left container: subject line, positioned at left edge
   * - Right container: page info, positioned so text ends at right edge
   *
   * Uses ~8.75px per character (560px / 64 chars) to calculate width.
   */
  private makeSplitStatus(status: StatusBar): [TextContainerProperty, TextContainerProperty] {
    const charWidth = GLASS_LAYOUT.width / 64;
    const rightWidth = Math.ceil(status.right.length * charWidth) + 16; // +padding
    const rightX = GLASS_LAYOUT.x + GLASS_LAYOUT.width - rightWidth;
    const leftWidth = rightX - GLASS_LAYOUT.x;

    const left = new TextContainerProperty({
      xPosition: GLASS_LAYOUT.x,
      yPosition: GLASS_LAYOUT.statusY,
      width: Math.max(leftWidth, 40),
      height: GLASS_LAYOUT.statusHeight,
      containerID: CONTAINER_IDS.status,
      containerName: CONTAINER_NAMES.status,
      isEventCapture: 0,
      content: status.left.slice(0, 1000),
    });

    const right = new TextContainerProperty({
      xPosition: rightX,
      yPosition: GLASS_LAYOUT.statusY,
      width: rightWidth,
      height: GLASS_LAYOUT.statusHeight,
      containerID: CONTAINER_IDS.statusRight,
      containerName: CONTAINER_NAMES.statusRight,
      isEventCapture: 1,
      content: status.right.slice(0, 1000),
    });

    return [left, right];
  }

  private async renderContainers(payload: {
    listObject?: ListContainerProperty[];
    textObject?: TextContainerProperty[];
  }): Promise<void> {
    if (!this.bridge) {
      throw new Error("Not connected. Call connect() first.");
    }

    const containerTotalNum =
      (payload.listObject?.length ?? 0) + (payload.textObject?.length ?? 0);

    const config = {
      containerTotalNum,
      ...(payload.listObject ? { listObject: payload.listObject } : {}),
      ...(payload.textObject ? { textObject: payload.textObject } : {}),
    };

    if (!this.startupDone) {
      console.log("[glass] createStartUpPageContainer", containerTotalNum);
      const result = await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer(config),
      );
      console.log("[glass] createStartUpPageContainer result:", result);

      if (result !== StartUpPageCreateResult.success) {
        throw new Error(
          `createStartUpPageContainer failed with code: ${String(result)}`,
        );
      }

      this.startupDone = true;
      return;
    }

    console.log("[glass] rebuildPageContainer", containerTotalNum);
    let ok = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer(config),
    );
    console.log("[glass] rebuildPageContainer result:", ok);

    if (!ok) {
      // Retry once after a short delay — firmware may need time after startup
      await this.delay(300);
      console.log("[glass] rebuildPageContainer retry");
      ok = await this.bridge.rebuildPageContainer(
        new RebuildPageContainer(config),
      );
      console.log("[glass] rebuildPageContainer retry result:", ok);
    }

    if (!ok) {
      console.warn("[glass] rebuildPageContainer failed after retry");
    }
  }

  private bindEvents(): void {
    if (!this.bridge) return;

    this.unsubscribeHub?.();
    this.unsubscribeHub = this.bridge.onEvenHubEvent((event) => {
      const gesture = this.mapEventToGesture(event);
      if (!gesture) return;

      // 300ms scroll cooldown per Nick Ustinov notes
      if (gesture.kind === "SCROLL_FWD" || gesture.kind === "SCROLL_BACK") {
        const now = Date.now();
        if (now - this.lastScrollTime < TIMING.SCROLL_COOLDOWN_MS) {
          return;
        }
        this.lastScrollTime = now;
      }

      for (const handler of this.gestureHandlers) {
        handler(gesture);
      }
    });
  }

  /**
   * Map SDK events to gesture events.
   * Handles all Nick Ustinov quirks:
   * - CLICK_EVENT=0 normalizes to undefined
   * - Simulator sends sysEvent for clicks
   * - Hardware sends listEvent/textEvent depending on container
   * - DOUBLE_CLICK_EVENT maps to DOUBLE_TAP for back navigation
   */
  private mapEventToGesture(event: EvenHubEvent): GestureEvent | null {
    const eventType =
      event.listEvent?.eventType ??
      event.textEvent?.eventType ??
      event.sysEvent?.eventType;

    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      return { kind: "SCROLL_BACK" };
    }

    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      return { kind: "SCROLL_FWD" };
    }

    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      return { kind: "DOUBLE_TAP", listIndex: event.listEvent?.currentSelectItemIndex };
    }

    // CLICK_EVENT = 0 becomes undefined during SDK deserialization
    if (
      eventType === OsEventTypeList.CLICK_EVENT ||
      eventType === undefined
    ) {
      return { kind: "TAP", listIndex: event.listEvent?.currentSelectItemIndex };
    }

    if (eventType === OsEventTypeList.FOREGROUND_ENTER_EVENT) {
      return { kind: "FOREGROUND_ENTER" };
    }

    if (eventType === OsEventTypeList.FOREGROUND_EXIT_EVENT) {
      return { kind: "FOREGROUND_EXIT" };
    }

    return null;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async waitForBridge(): Promise<EvenAppBridge> {
    let timer: ReturnType<typeof setTimeout> | null = null;

    try {
      const bridge = await Promise.race([
        waitForEvenAppBridge(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                "Timed out waiting for Even bridge. Open this URL from Even app dev mode.",
              ),
            );
          }, TIMING.BRIDGE_TIMEOUT_MS);
        }),
      ]);

      return bridge;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
