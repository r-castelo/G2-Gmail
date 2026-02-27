import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GmailStateMachine } from "../src/app/state";
import type { GmailLabel, GmailMessageHeader } from "../src/types/contracts";

function makeLabel(id: string, name: string, type: "system" | "user" = "system"): GmailLabel {
  return { id, name, type, messagesTotal: 10, messagesUnread: 2 };
}

function makeMessage(id: string, subject: string, isUnread = false): GmailMessageHeader {
  return {
    id,
    threadId: `thread_${id}`,
    subject,
    from: "Sender Name",
    date: "Jan 1",
    snippet: "Preview text...",
    isUnread,
  };
}

describe("GmailStateMachine", () => {
  it("starts in BOOT mode", () => {
    const sm = new GmailStateMachine();
    assert.equal(sm.mode, "BOOT");
  });

  it("transitions to AUTH_REQUIRED", () => {
    const sm = new GmailStateMachine();
    sm.setAuthRequired();
    assert.equal(sm.mode, "AUTH_REQUIRED");
  });

  it("transitions to LABELS when labels are set", () => {
    const sm = new GmailStateMachine();
    sm.setLabels([
      makeLabel("INBOX", "INBOX"),
      makeLabel("SENT", "SENT"),
    ]);
    assert.equal(sm.mode, "LABELS");
    assert.equal(sm.snapshot.labels.length, 2);
  });

  it("sorts system labels in defined order", () => {
    const sm = new GmailStateMachine();
    sm.setLabels([
      makeLabel("SENT", "SENT"),
      makeLabel("INBOX", "INBOX"),
      makeLabel("TRASH", "TRASH"),
    ]);

    const names = sm.snapshot.labels.map((l) => l.name);
    assert.deepEqual(names, ["Inbox", "Sent", "Trash"]);
  });

  it("puts user labels after system labels alphabetically", () => {
    const sm = new GmailStateMachine();
    sm.setLabels([
      makeLabel("Label_2", "Zeta", "user"),
      makeLabel("INBOX", "INBOX"),
      makeLabel("Label_1", "Alpha", "user"),
    ]);

    const names = sm.snapshot.labels.map((l) => l.name);
    assert.deepEqual(names, ["Inbox", "Alpha", "Zeta"]);
  });

  it("returns label by index", () => {
    const sm = new GmailStateMachine();
    sm.setLabels([makeLabel("INBOX", "INBOX")]);
    const label = sm.getLabelAtIndex(0);
    assert.equal(label?.id, "INBOX");
    assert.equal(sm.getLabelAtIndex(99), null);
  });

  it("transitions to MESSAGE_LIST", () => {
    const sm = new GmailStateMachine();
    sm.setMessages("INBOX", "Inbox", [
      makeMessage("1", "Hello"),
      makeMessage("2", "World", true),
    ]);
    assert.equal(sm.mode, "MESSAGE_LIST");
    assert.equal(sm.snapshot.messages.length, 2);
  });

  it("returns message by index", () => {
    const sm = new GmailStateMachine();
    sm.setMessages("INBOX", "Inbox", [makeMessage("1", "Test")]);
    const msg = sm.getMessageAtIndex(0);
    assert.equal(msg?.id, "1");
    assert.equal(sm.getMessageAtIndex(99), null);
  });

  it("formats message display items with unread marker", () => {
    const sm = new GmailStateMachine();
    sm.setMessages("INBOX", "Inbox", [
      makeMessage("1", "Important Email", true),
      makeMessage("2", "Read Email", false),
    ]);
    const items = sm.getMessageDisplayItems();
    assert.ok(items[0]?.startsWith("*"), "Unread should start with *");
    assert.ok(items[1]?.startsWith(" "), "Read should start with space");
  });

  it("transitions to READER", () => {
    const sm = new GmailStateMachine();
    sm.enterReader("msg1", "Test Subject", [["line1"], ["line2"]]);
    assert.equal(sm.mode, "READER");
    assert.equal(sm.snapshot.currentPage, 0);
  });

  it("pages forward and backward", () => {
    const sm = new GmailStateMachine();
    sm.enterReader("msg1", "Test", [["p1"], ["p2"], ["p3"]]);
    assert.equal(sm.nextPage(), true);
    assert.equal(sm.snapshot.currentPage, 1);
    assert.equal(sm.nextPage(), true);
    assert.equal(sm.snapshot.currentPage, 2);
    assert.equal(sm.nextPage(), false); // at last page
    assert.equal(sm.prevPage(), true);
    assert.equal(sm.snapshot.currentPage, 1);
  });

  it("navigates back to labels", () => {
    const sm = new GmailStateMachine();
    sm.setMessages("INBOX", "Inbox", [makeMessage("1", "Test")]);
    assert.equal(sm.mode, "MESSAGE_LIST");
    sm.backToLabels();
    assert.equal(sm.mode, "LABELS");
  });

  it("navigates back to message list", () => {
    const sm = new GmailStateMachine();
    sm.enterReader("msg1", "Test", [["p1"]]);
    assert.equal(sm.mode, "READER");
    sm.backToMessageList();
    assert.equal(sm.mode, "MESSAGE_LIST");
  });

  it("handles ERROR mode", () => {
    const sm = new GmailStateMachine();
    sm.setError("Something broke");
    assert.equal(sm.mode, "ERROR");
    assert.equal(sm.snapshot.errorMessage, "Something broke");
  });
});
