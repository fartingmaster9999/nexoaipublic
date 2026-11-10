import test from "node:test";
import assert from "node:assert/strict";
import { imageFileToBase64, MAX_IMAGE_BYTES, prepareImageFile, validateImageFile } from "../src/lib/image-attachment.ts";
import { parseConversation } from "../src/lib/conversation-storage.ts";

const file = (type, size, bytes = [0, 1, 255]) => ({
  type,
  size,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
});

test("image picker accepts only supported non-empty images up to 3 MB", () => {
  assert.equal(validateImageFile(file("image/jpeg", 10)), null);
  assert.equal(validateImageFile(file("image/png", MAX_IMAGE_BYTES)), null);
  assert.match(validateImageFile(file("image/svg+xml", 10)), /JPEG, PNG, or WebP/);
  assert.match(validateImageFile(file("image/webp", 0)), /empty/);
  assert.match(validateImageFile(file("image/png", MAX_IMAGE_BYTES + 1)), /3 MB/);
});

test("transient image encoding preserves exact bytes", async () => {
  assert.equal(await imageFileToBase64(file("image/png", 3)), "AAH/");
  await assert.rejects(imageFileToBase64(file("image/gif", 3)), /JPEG, PNG, or WebP/);
});

test("image preparation leaves small files unchanged and rejects unsupported oversized files", async () => {
  const small = new File([new Uint8Array([1, 2, 3])], "small.png", { type: "image/png" });
  assert.equal(await prepareImageFile(small), small);
  await assert.rejects(
    prepareImageFile({ ...file("image/gif", MAX_IMAGE_BYTES + 1), name: "large.gif" }),
    /JPEG, PNG, or WebP/,
  );
});

test("conversation history keeps only the image-attached marker, never image bytes", () => {
  const conversation = parseConversation({
    id: "chat", title: "chart", createdAt: 1, updatedAt: 2,
    messages: [{ role: "user", content: "Read this", imageAttached: true, imageData: "private-base64" }],
  });
  assert.equal(conversation.messages[0].imageAttached, true);
  assert.equal(conversation.messages[0].imageData, undefined);
  assert.equal(JSON.stringify(conversation).includes("private-base64"), false);
});

test("conversation history preserves retrieval times, labels, and legacy source links", () => {
  const conversation = parseConversation({
    id: "chat", title: "search", createdAt: 1, updatedAt: 2,
    messages: [{
      role: "assistant",
      content: "Here is the latest.",
      sources: [
        { title: "Read page", url: "https://example.com/read", retrieval: "page", retrievedAt: "2026-11-06T18:30:00.000Z" },
        { title: "Search result", url: "https://example.com/snippet", retrieval: "search_excerpt" },
        { title: "Invalid date", url: "https://example.com/invalid-date", retrievedAt: "not a date" },
        { title: "Legacy source", url: "https://example.com/legacy" },
        { title: "Invalid label", url: "https://example.com/invalid", retrieval: "unknown" },
      ],
    }],
  });
  assert.deepEqual(conversation.messages[0].sources, [
    { title: "Read page", url: "https://example.com/read", retrieval: "page", retrievedAt: "2026-11-06T18:30:00.000Z" },
    { title: "Search result", url: "https://example.com/snippet", retrieval: "search_excerpt" },
    { title: "Invalid date", url: "https://example.com/invalid-date" },
    { title: "Legacy source", url: "https://example.com/legacy" },
    { title: "Invalid label", url: "https://example.com/invalid" },
  ]);
});
