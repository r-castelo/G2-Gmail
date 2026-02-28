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
    onProgress?: (step: string) => Promise<void> | void,
  ): Promise<{ messages: GmailMessageHeader[]; nextPageToken?: string }> {
    // Step 1: List message IDs
    await onProgress?.("Fetching message IDs...");
    const params = new URLSearchParams({
      labelIds: labelId,
      maxResults: String(maxResults),
    });
    if (pageToken) params.set("pageToken", pageToken);

    console.log(`[gmail] listMessages: fetching IDs for ${labelId}`);
    const listData = await this.apiFetch<GmailMessagesListResponse>(
      `/users/me/messages?${params.toString()}`,
    );

    if (!listData.messages || listData.messages.length === 0) {
      console.log("[gmail] listMessages: no messages found");
      return { messages: [] };
    }

    // Step 2: Fetch all message headers in parallel.
    const ids = listData.messages.map((m) => m.id).filter((id): id is string => !!id);
    await onProgress?.(`Loading ${ids.length} messages...`);
    console.log(`[gmail] listMessages: fetching ${ids.length} headers in parallel`);
    const results = await Promise.all(ids.map((id) => this.fetchMessageHeader(id)));
    const headers = results.filter((h): h is GmailMessageHeader => h !== null);
    console.log(`[gmail] fetched ${headers.length}/${ids.length} headers`);

    return {
      messages: headers,
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
   * Batch-fetch metadata headers for multiple messages in a single HTTP request
   * using the Gmail Batch API. This avoids sequential fetches that stall in WebView.
   * Uses Promise.race for timeout since AbortController may not work in all WebViews.
   */
  private async batchFetchMessageHeaders(
    ids: string[],
  ): Promise<GmailMessageHeader[]> {
    if (ids.length === 0) return [];

    const boundary = "batch_gmail_headers";
    const parts = ids.map(
      (id) =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <msg-${id}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date\r\n`,
    );
    const body = parts.join("\r\n") + `\r\n--${boundary}--`;

    const token = await this.auth.getAccessToken();

    const doFetch = async (authToken: string): Promise<GmailMessageHeader[]> => {
      const response = await this.fetchWithTimeout(
        "https://www.googleapis.com/batch/gmail/v1",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${authToken}`,
            "Content-Type": `multipart/mixed; boundary=${boundary}`,
          },
          body,
        },
        15_000,
        "Batch fetch",
      );

      if (!response.ok) {
        throw new Error(`Batch API ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }

      const contentType = response.headers.get("Content-Type") ?? "";
      const responseText = await response.text();
      console.log(`[gmail] batch response: status=${response.status}, ct=${contentType.slice(0, 60)}, len=${responseText.length}`);
      return this.parseBatchResponse(responseText, contentType, ids.length);
    };

    try {
      return await doFetch(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Retry once on 401
      if (msg.includes("Batch API 401")) {
        console.log("[gmail] batch 401 — forcing token refresh");
        const newToken = await this.auth.forceRefresh();
        return await doFetch(newToken);
      }
      throw err;
    }
  }

  /**
   * fetch() wrapped in Promise.race so it always rejects after timeoutMs,
   * even if AbortController doesn't work in the current WebView.
   */
  private fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    label: string,
  ): Promise<Response> {
    return Promise.race([
      fetch(url, init),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs),
      ),
    ]);
  }

  /**
   * Parse a multipart/mixed batch response into GmailMessageHeader[].
   * Throws if parsing yields 0 results from a non-empty request.
   */
  private parseBatchResponse(
    responseText: string,
    contentType: string,
    expectedCount: number,
  ): GmailMessageHeader[] {
    // Extract boundary from Content-Type header
    const boundaryMatch = /boundary=([^\s;]+)/.exec(contentType);
    if (!boundaryMatch) {
      throw new Error(`Batch parse: no boundary in Content-Type: ${contentType.slice(0, 100)}`);
    }
    const boundary = boundaryMatch[1];

    // Split by boundary and drop first (preamble) and last (epilogue) parts
    const rawParts = responseText.split(`--${boundary}`);
    const results: GmailMessageHeader[] = [];
    let partsProcessed = 0;
    let parseErrors = 0;

    for (const rawPart of rawParts) {
      const trimmed = rawPart.trim();
      if (!trimmed || trimmed === "--") continue;
      partsProcessed++;

      // Each part has: MIME headers, blank line, HTTP response line, HTTP headers, blank line, JSON body
      // Find the JSON body: look for the first '{' that starts a line
      const jsonStart = trimmed.indexOf("\r\n{");
      const jsonStartAlt = trimmed.indexOf("\n{");
      const idx = jsonStart >= 0 ? jsonStart + 2 : jsonStartAlt >= 0 ? jsonStartAlt + 1 : -1;
      if (idx < 0) {
        parseErrors++;
        console.warn(`[gmail] batch part ${partsProcessed}: no JSON found. Preview: ${trimmed.slice(0, 200)}`);
        continue;
      }

      // Find end of JSON — it should end with }
      const jsonEnd = trimmed.lastIndexOf("}");
      if (jsonEnd < idx) {
        parseErrors++;
        console.warn(`[gmail] batch part ${partsProcessed}: malformed JSON bounds`);
        continue;
      }

      try {
        const data: GmailMessageResource = JSON.parse(trimmed.slice(idx, jsonEnd + 1));
        const header = this.messageResourceToHeader(data);
        if (header) results.push(header);
      } catch (err) {
        parseErrors++;
        console.warn(`[gmail] batch part ${partsProcessed}: JSON parse failed:`, err);
      }
    }

    console.log(`[gmail] batch parsed: ${results.length} ok, ${parseErrors} errors, ${partsProcessed} parts from ${expectedCount} expected`);

    if (results.length === 0 && expectedCount > 0) {
      throw new Error(
        `Batch parse: 0/${expectedCount} messages parsed (${partsProcessed} parts, ${parseErrors} errors). Body preview: ${responseText.slice(0, 300)}`,
      );
    }

    return results;
  }

  /**
   * Convert a GmailMessageResource (metadata format) to a GmailMessageHeader.
   */
  private messageResourceToHeader(
    data: GmailMessageResource,
  ): GmailMessageHeader | null {
    if (!data.id) return null;

    const headers = data.payload?.headers ?? [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    const isUnread = data.labelIds?.includes("UNREAD") ?? false;

    return {
      id: data.id,
      threadId: data.threadId ?? "",
      subject: getHeader("Subject") || "(no subject)",
      from: this.extractSenderName(getHeader("From")),
      date: this.formatDateShort(getHeader("Date")),
      snippet: data.snippet ?? "",
      isUnread,
    };
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
    console.log(`[gmail] apiFetch: ${path.slice(0, 60)}`);
    const token = await this.auth.getAccessToken();
    const url = path.startsWith("http")
      ? path
      : `${GMAIL_CONFIG.API_BASE}${path}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });

      if (response.status === 401 && retry) {
        console.log("[gmail] 401 — forcing token refresh");
        const newToken = await this.auth.forceRefresh();
        const retryController = new AbortController();
        const retryTimeout = setTimeout(() => retryController.abort(), 15_000);
        try {
          const retryResponse = await fetch(url, {
            ...init,
            headers: { ...init?.headers, Authorization: `Bearer ${newToken}` },
            signal: retryController.signal,
          });
          if (!retryResponse.ok) {
            throw new Error(`Gmail API error: ${retryResponse.status}`);
          }
          return (await retryResponse.json()) as T;
        } finally {
          clearTimeout(retryTimeout);
        }
      }

      if (!response.ok) {
        throw new Error(`Gmail API error: ${response.status}`);
      }

      return (await response.json()) as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
