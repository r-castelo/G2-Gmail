/**
 * Gmail REST API adapter — fetch-based wrapper for Gmail API calls.
 *
 * Handles:
 * - Label listing
 * - Message listing (two-step: list IDs then batch-fetch metadata)
 * - Full message retrieval with MIME body parsing
 * - Base64url decoding for Gmail payloads
 * - Automatic 401 retry with forced token refresh
 */

import { GMAIL_CONFIG } from "../config/gmailConfig";
import { MESSAGES_PER_PAGE } from "../config/constants";
import type { GmailAuthService } from "../services/gmailAuthService";
import type {
  GmailAdapter,
  GmailLabel,
  GmailMessageFull,
  GmailMessageHeader,
} from "../types/contracts";

// --- Gmail API response types ---

interface GmailLabelResource {
  id?: string;
  name?: string;
  type?: string;
  messagesTotal?: number;
  messagesUnread?: number;
}

interface GmailLabelsResponse {
  labels?: GmailLabelResource[];
}

interface GmailMessageRef {
  id?: string;
  threadId?: string;
}

interface GmailMessagesListResponse {
  messages?: GmailMessageRef[];
  nextPageToken?: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number };
  parts?: GmailMessagePart[];
}

interface GmailMessageResource {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailMessagePart;
}

interface GmailProfileResponse {
  emailAddress?: string;
}

// --- Implementation ---

export class GmailAdapterImpl implements GmailAdapter {
  constructor(private readonly auth: GmailAuthService) {}

  /**
   * Get the authenticated user's email address.
   */
  async getProfile(): Promise<string> {
    const data = await this.apiFetch<GmailProfileResponse>(
      "/users/me/profile",
    );
    return data.emailAddress ?? "unknown";
  }

  /**
   * List all Gmail labels for the authenticated user.
   */
  async listLabels(): Promise<GmailLabel[]> {
    const data = await this.apiFetch<GmailLabelsResponse>(
      "/users/me/labels",
    );

    if (!data.labels) return [];

    return data.labels
      .filter((l) => l.id && l.name)
      .map((l) => ({
        id: l.id!,
        name: l.name!,
        type: l.type === "system" ? ("system" as const) : ("user" as const),
        messagesTotal: l.messagesTotal,
        messagesUnread: l.messagesUnread,
      }));
  }

  /**
   * List messages in a label. Two-step process:
   * 1. List message IDs from the label
   * 2. Batch-fetch metadata headers for each message
   */
  async listMessages(
    labelId: string,
    maxResults: number = MESSAGES_PER_PAGE,
    pageToken?: string,
  ): Promise<{ messages: GmailMessageHeader[]; nextPageToken?: string }> {
    // Step 1: List message IDs
    const params = new URLSearchParams({
      labelIds: labelId,
      maxResults: String(maxResults),
    });
    if (pageToken) params.set("pageToken", pageToken);

    const listData = await this.apiFetch<GmailMessagesListResponse>(
      `/users/me/messages?${params.toString()}`,
    );

    if (!listData.messages || listData.messages.length === 0) {
      return { messages: [] };
    }

    // Step 2: Fetch metadata for each message
    const headers = await Promise.all(
      listData.messages
        .filter((m) => m.id)
        .map((m) => this.fetchMessageHeader(m.id!)),
    );

    return {
      messages: headers.filter((h): h is GmailMessageHeader => h !== null),
      nextPageToken: listData.nextPageToken,
    };
  }

  /**
   * Get a full message by ID, including parsed body text.
   */
  async getMessage(messageId: string): Promise<GmailMessageFull> {
    const data = await this.apiFetch<GmailMessageResource>(
      `/users/me/messages/${messageId}?format=full`,
    );

    const headers = data.payload?.headers ?? [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    const { text, html } = this.extractBody(data.payload);

    return {
      id: data.id ?? messageId,
      subject: getHeader("Subject") || "(no subject)",
      from: getHeader("From"),
      to: getHeader("To"),
      date: getHeader("Date"),
      bodyText: text,
      bodyHtml: html,
    };
  }

  /**
   * Mark a message as read by removing the UNREAD label.
   */
  async markAsRead(messageId: string): Promise<void> {
    await this.apiFetch(
      `/users/me/messages/${messageId}/modify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
      },
    );
  }

  // --- Private helpers ---

  /**
   * Fetch a single message's metadata headers (subject, from, date, snippet).
   */
  private async fetchMessageHeader(
    messageId: string,
  ): Promise<GmailMessageHeader | null> {
    try {
      const params = new URLSearchParams({
        format: "metadata",
        metadataHeaders: "Subject",
      });
      // Gmail API allows multiple metadataHeaders params
      const url = `/users/me/messages/${messageId}?${params.toString()}&metadataHeaders=From&metadataHeaders=Date`;

      const data = await this.apiFetch<GmailMessageResource>(url);

      const headers = data.payload?.headers ?? [];
      const getHeader = (name: string): string =>
        headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

      const isUnread = data.labelIds?.includes("UNREAD") ?? false;

      return {
        id: data.id ?? messageId,
        threadId: data.threadId ?? "",
        subject: getHeader("Subject") || "(no subject)",
        from: this.extractSenderName(getHeader("From")),
        date: this.formatDateShort(getHeader("Date")),
        snippet: data.snippet ?? "",
        isUnread,
      };
    } catch (err) {
      console.warn(`[gmail] Failed to fetch message ${messageId}:`, err);
      return null;
    }
  }

  /**
   * Recursively extract text/plain and text/html bodies from MIME parts.
   */
  private extractBody(
    part?: GmailMessagePart,
  ): { text: string; html: string } {
    if (!part) return { text: "", html: "" };

    let text = "";
    let html = "";

    // Direct body
    if (part.body?.data) {
      const decoded = this.decodeBase64Url(part.body.data);
      if (part.mimeType === "text/plain") {
        text = decoded;
      } else if (part.mimeType === "text/html") {
        html = decoded;
      }
    }

    // Recurse into multipart
    if (part.parts) {
      for (const subPart of part.parts) {
        const sub = this.extractBody(subPart);
        if (!text && sub.text) text = sub.text;
        if (!html && sub.html) html = sub.html;
      }
    }

    return { text, html };
  }

  /**
   * Decode Gmail's web-safe base64 encoding.
   * Gmail uses URL-safe base64 (RFC 4648 §5): - instead of +, _ instead of /.
   */
  private decodeBase64Url(data: string): string {
    const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
    // Pad with = if needed
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    try {
      return decodeURIComponent(
        atob(padded)
          .split("")
          .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join(""),
      );
    } catch {
      // Fallback: try simple atob
      try {
        return atob(padded);
      } catch {
        return "";
      }
    }
  }

  /**
   * Extract just the sender name from a "Name <email>" From header.
   */
  private extractSenderName(from: string): string {
    // "John Doe <john@example.com>" → "John Doe"
    const match = /^"?([^"<]+)"?\s*</.exec(from);
    if (match?.[1]) {
      return match[1].trim();
    }
    // Bare email
    const emailMatch = /<([^>]+)>/.exec(from);
    if (emailMatch?.[1]) {
      return emailMatch[1];
    }
    return from;
  }

  /**
   * Format a date string to a short display format.
   * "Wed, 15 Jan 2025 10:30:00 +0000" → "Jan 15" or "10:30" if today
   */
  private formatDateShort(dateStr: string): string {
    if (!dateStr) return "";
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const isToday =
        date.getFullYear() === now.getFullYear() &&
        date.getMonth() === now.getMonth() &&
        date.getDate() === now.getDate();

      if (isToday) {
        return date.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
      }

      return date.toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });
    } catch {
      return dateStr.slice(0, 10);
    }
  }

  /**
   * Make an authenticated fetch to the Gmail API.
   * Auto-retries once with a forced token refresh on 401.
   */
  private async apiFetch<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
    const token = await this.auth.getAccessToken();
    const url = path.startsWith("http")
      ? path
      : `${GMAIL_CONFIG.API_BASE}${path}`;

    const response = await fetch(url, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${token}` },
    });

    if (response.status === 401 && retry) {
      console.log("[gmail] 401 — forcing token refresh");
      const newToken = await this.auth.forceRefresh();
      const retryResponse = await fetch(url, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${newToken}` },
      });

      if (!retryResponse.ok) {
        throw new Error(`Gmail API error: ${retryResponse.status}`);
      }

      return (await retryResponse.json()) as T;
    }

    if (!response.ok) {
      throw new Error(`Gmail API error: ${response.status}`);
    }

    return (await response.json()) as T;
  }
}
