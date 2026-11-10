import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { delay, waitFor, withFixture } from "./browser-harness.mjs";

const temp = await mkdtemp(path.join(tmpdir(), "nexo-image-chat-"));
const imagePath = path.join(temp, "chart.png");
const largeImagePath = path.join(temp, "large-chart.png");
const unsupportedPath = path.join(temp, "unsupported.svg");
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLKrQAAAABJRU5ErkJggg==";
await writeFile(imagePath, Buffer.from(imageBase64, "base64"));
await writeFile(unsupportedPath, "<svg xmlns=\"http://www.w3.org/2000/svg\"/>");

function createLargePng(width, height) {
  const crcTable = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    return crc >>> 0;
  });
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const name = Buffer.from(type);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let seed = 0x12345678;
  for (let index = 0; index < pixels.length; index++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    pixels[index] = index % (width * 3 + 1) === 0 ? 0 : seed & 0xff;
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const largeImageBytes = createLargePng(1250, 1250);
assert.ok(largeImageBytes.length > 3 * 1024 * 1024, "large-image fixture exceeds the server's 3 MB limit");
await writeFile(largeImagePath, largeImageBytes);

try {
  await withFixture("tests/image-chat.html", async ({ cdp, evaluate }) => {
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="input-message"]'))`), "chat composer");
    await evaluate(`(() => {
      const originalFetch = window.fetch.bind(window);
      window.__imageRequests = [];
      window.__textRequests = 0;
      window.fetch = async (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.endsWith("/api/chat/image")) {
          window.__imageRequests.push({ url, body: JSON.parse(init.body) });
          const events = [
            { model: "gemini-3.8-flash" },
            { activity: { id: "image-analysis", label: "Analyzing the attached image", kind: "thinking", status: "running" } },
            { content: "The image contains a small chart." },
            { done: true }
          ];
          return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\\n\\n").join(""), {
            headers: { "Content-Type": "text/event-stream" }
          });
        }
        if (url.endsWith("/api/chat")) {
          window.__textRequests++;
          return new Response('data: {"content":"Text-only route remains active."}\\n\\ndata: {"done":true}\\n\\n', {
            headers: { "Content-Type": "text/event-stream" }
          });
        }
        return originalFetch(input, init);
      };
    })()`);

    const root = (await cdp("DOM.getDocument")).root.nodeId;
    const input = (await cdp("DOM.querySelector", { nodeId: root, selector: '[data-testid="input-image-file"]' })).nodeId;
    assert.ok(input);

    await cdp("DOM.setFileInputFiles", { nodeId: input, files: [unsupportedPath] });
    await waitFor(() => evaluate(`document.querySelector('[data-testid="status-request-error"]')?.textContent.includes("JPEG, PNG, or WebP")`), "unsupported image error");
    await evaluate(`document.querySelector('[data-testid="button-dismiss-error"]').click()`);

    await cdp("DOM.setFileInputFiles", { nodeId: input, files: [imagePath] });
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="image-attachment-preview"] img')?.src.startsWith("blob:"))`), "image preview");
    const previewText = await evaluate(`document.querySelector('[data-testid="image-attachment-preview"]').textContent`);
    assert.equal(previewText.trim(), "");

    await evaluate(`document.querySelector('[data-testid="button-remove-image"]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="image-attachment-preview"]')`), "image removal");
    await cdp("DOM.setFileInputFiles", { nodeId: input, files: [imagePath] });
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="image-attachment-preview"]'))`), "reattached image");

    await evaluate(`document.querySelector('[data-testid="input-message"]').focus()`);
    await cdp("Input.insertText", { text: "What is shown in this image?" });
    await evaluate(`document.querySelector('[data-testid="button-send-message"]').click()`);
    await waitFor(() => evaluate(`window.__imageRequests.length === 1`), "Gemini image request", 10000);
    await waitFor(() => evaluate(`document.body.textContent.includes("The image contains a small chart.")`), "streamed image answer", 10000);
    const request = await evaluate(`window.__imageRequests[0]`);
    assert.ok(request.url.endsWith("/api/chat/image"));
    assert.equal(request.body.messages.at(-1).content, "What is shown in this image?");
    assert.equal(request.body.image.mimeType, "image/png");
    assert.equal(request.body.image.data, imageBase64);
    assert.equal(await evaluate(`document.body.textContent.includes("Image sent to Gemini. The image file is not saved in chat history.")`), true);
    assert.equal(await evaluate(`Object.keys(localStorage).map(key => localStorage.getItem(key) || "").join("").includes(${JSON.stringify(imageBase64)})`), false);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="image-attachment-preview"]')`), "sent preview cleared");

    await cdp("DOM.setFileInputFiles", { nodeId: input, files: [largeImagePath] });
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="image-attachment-preview"] img')?.src.startsWith("blob:"))`), "compressed oversized image preview", 15000);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="image-preparing-status"]')`), "large image preparation complete", 15000);
    await evaluate(`document.querySelector('[data-testid="button-remove-image"]').click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="image-attachment-preview"]')`), "oversized image removal");
    await cdp("DOM.setFileInputFiles", { nodeId: input, files: [largeImagePath] });
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-testid="image-attachment-preview"] img')?.src.startsWith("blob:"))`), "reattached compressed oversized image", 15000);
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="image-preparing-status"]')`), "reattached large image preparation complete", 15000);
    await evaluate(`document.querySelector('[data-testid="input-message"]').focus()`);
    await cdp("Input.insertText", { text: "What is shown in this large image?" });
    await evaluate(`document.querySelector('[data-testid="button-send-message"]').click()`);
    await waitFor(() => evaluate(`window.__imageRequests.length === 2`), "compressed image request", 15000);
    const compressedRequest = await evaluate(`window.__imageRequests[1]`);
    assert.equal(compressedRequest.body.image.mimeType, "image/jpeg");
    const compressedBytes = Buffer.from(compressedRequest.body.image.data, "base64");
    assert.ok(compressedBytes.length > 0 && compressedBytes.length <= 3 * 1024 * 1024, "prepared image is within the server limit");
    assert.ok(compressedBytes.length < largeImageBytes.length, "prepared image is smaller than its original");
    assert.equal(await evaluate(`Object.keys(localStorage).map(key => localStorage.getItem(key) || "").join("").includes(${JSON.stringify(compressedRequest.body.image.data)})`), false, "compressed image bytes are not saved in browser history");
    await waitFor(() => evaluate(`!document.querySelector('[data-testid="image-attachment-preview"]')`), "large image preview cleared after sending");

    await evaluate(`document.querySelector('[data-testid="input-message"]').focus()`);
    await cdp("Input.insertText", { text: "What is 2 + 2?" });
    await evaluate(`document.querySelector('[data-testid="button-send-message"]').click()`);
    await waitFor(() => evaluate(`window.__textRequests === 1`), "text-only Groq route", 10000);
    await waitFor(() => evaluate(`document.body.textContent.includes("Text-only route remains active.")`), "text-only response", 10000);
    assert.equal(await evaluate(`window.__imageRequests.length`), 2);
    console.log("Image-chat browser checks passed: validation, oversized-image compression, preview/remove, ephemeral image bytes, Gemini routing, and unchanged text routing.");
    await delay(50);
  });
} finally {
  await rm(temp, { recursive: true, force: true });
}
