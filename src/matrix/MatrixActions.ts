import fs from "fs";
import { EventType, MsgType, RelationType } from "matrix-js-sdk";
import { MatrixClient } from "./MatrixClient.js";
import { getLogger } from "../logger.js";

const log = getLogger("MatrixActions");

export class MatrixActions {
  constructor(private readonly matrix: MatrixClient) {}

  async sendText(roomId: string, text: string): Promise<void> {
    try {
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: text,
      });
    } catch (err) {
      log.error({ err, roomId }, "sendText failed");
    }
  }

  async sendMarkdown(roomId: string, markdown: string): Promise<void> {
    try {
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: markdown,
        format: "org.matrix.custom.html",
        formatted_body: markdownToHtml(markdown),
      });
    } catch (err) {
      log.error({ err, roomId }, "sendMarkdown failed");
    }
  }

  async sendFile(
    roomId: string,
    filePath: string,
    mimeType: string
  ): Promise<void> {
    try {
      const content = fs.readFileSync(filePath);
      const filename = filePath.split("/").pop() ?? "file";
      const response = await this.matrix
        .getSDKClient()
        .uploadContent(content, { type: mimeType, name: filename });
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.File,
        body: filename,
        url: response.content_uri,
        info: { mimetype: mimeType, size: content.length },
      });
    } catch (err) {
      log.error({ err, roomId, filePath }, "sendFile failed");
    }
  }

  async sendImage(roomId: string, imagePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(imagePath);
      const filename = imagePath.split("/").pop() ?? "image";
      const mimeType = guessMimeType(filename);
      const response = await this.matrix
        .getSDKClient()
        .uploadContent(content, { type: mimeType, name: filename });
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.Image,
        body: filename,
        url: response.content_uri,
        info: { mimetype: mimeType, size: content.length },
      });
    } catch (err) {
      log.error({ err, roomId, imagePath }, "sendImage failed");
    }
  }

  async setTyping(roomId: string, isTyping: boolean): Promise<void> {
    try {
      await this.matrix
        .getSDKClient()
        .sendTyping(roomId, isTyping, isTyping ? 30000 : 0);
    } catch (err) {
      log.warn({ err, roomId }, "setTyping failed");
    }
  }

  async sendReaction(
    roomId: string,
    eventId: string,
    emoji: string
  ): Promise<void> {
    try {
      await this.matrix.getSDKClient().sendEvent(roomId, EventType.Reaction, {
        "m.relates_to": {
          rel_type: RelationType.Annotation,
          event_id: eventId,
          key: emoji,
        },
      });
    } catch (err) {
      log.error({ err, roomId, eventId }, "sendReaction failed");
    }
  }

  async editMessage(
    roomId: string,
    eventId: string,
    newText: string
  ): Promise<void> {
    try {
      await this.matrix.getSDKClient().sendEvent(roomId, EventType.RoomMessage, {
        msgtype: MsgType.Text,
        body: `* ${newText}`,
        "m.new_content": {
          msgtype: MsgType.Text,
          body: newText,
        },
        "m.relates_to": {
          rel_type: RelationType.Replace,
          event_id: eventId,
        },
      });
    } catch (err) {
      log.error({ err, roomId, eventId }, "editMessage failed");
    }
  }

  async markRead(roomId: string, eventId: string): Promise<void> {
    try {
      await this.matrix.getSDKClient().sendReadReceipt(
        // matrix-js-sdk expects a MatrixEvent; using low-level API
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { getId: () => eventId, getRoomId: () => roomId } as any
      );
    } catch (err) {
      log.warn({ err, roomId, eventId }, "markRead failed");
    }
  }
}

function markdownToHtml(md: string): string {
  // Minimal conversion – bold, italic, code blocks, newlines.
  return md
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/```[\w]*\n([\s\S]*?)```/g, "<pre><code>$1</code></pre>")
    .replace(/\n/g, "<br/>");
}

function guessMimeType(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return map[ext ?? ""] ?? "application/octet-stream";
}
