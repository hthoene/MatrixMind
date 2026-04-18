import fs from "fs";
import path from "node:path";
import { marked } from "marked";
import { EventType, MsgType, RelationType } from "matrix-js-sdk";
import { MatrixClient } from "./MatrixClient.js";
import { getLogger } from "../logger.js";
import { guessMimeType } from "../utils/media.js";

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
      const html = await Promise.resolve(marked.parse(markdown));
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.Text,
        body: markdown,
        format: "org.matrix.custom.html",
        formatted_body: html,
      });
    } catch (err) {
      log.error({ err, roomId }, "sendMarkdown failed");
    }
  }

  async sendFile(
    roomId: string,
    filePath: string,
    mimeType?: string
  ): Promise<void> {
    try {
      const content = fs.readFileSync(filePath);
      const filename = path.basename(filePath) || "file";
      const resolvedMimeType = mimeType ?? guessMimeType(filePath);
      const response = await this.matrix
        .getSDKClient()
        .uploadContent(content, { type: resolvedMimeType, name: filename });
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.File,
        body: filename,
        url: response.content_uri,
        info: { mimetype: resolvedMimeType, size: content.length },
      });
    } catch (err) {
      log.error({ err, roomId, filePath }, "sendFile failed");
    }
  }

  async sendImage(roomId: string, imagePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(imagePath);
      const filename = path.basename(imagePath) || "image";
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

  async sendVideo(roomId: string, videoPath: string): Promise<void> {
    try {
      const content = fs.readFileSync(videoPath);
      const filename = path.basename(videoPath) || "video";
      const mimeType = guessMimeType(filename);
      const response = await this.matrix
        .getSDKClient()
        .uploadContent(content, { type: mimeType, name: filename });
      await this.matrix.getSDKClient().sendMessage(roomId, {
        msgtype: MsgType.Video,
        body: filename,
        url: response.content_uri,
        info: { mimetype: mimeType, size: content.length },
      });
    } catch (err) {
      log.error({ err, roomId, videoPath }, "sendVideo failed");
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

  async fetchRecentMessages(
    roomId: string,
    limit: number
  ): Promise<Array<{ eventId: string; sender: string; body: string; timestamp: number }>> {
    const sdkClient = this.matrix.getSDKClient();
    const room = sdkClient.getRoom(roomId);
    if (!room) return [];

    try {
      await sdkClient.scrollback(room, limit);
    } catch (err) {
      log.warn({ err, roomId }, "scrollback failed, using cached timeline");
    }

    const events = room.getLiveTimeline().getEvents();
    const results: Array<{ eventId: string; sender: string; body: string; timestamp: number }> = [];

    for (const event of events.slice(-limit)) {
      if (event.getType() !== "m.room.message") continue;
      const content = event.getContent();
      if (content["msgtype"] !== "m.text") continue;
      const body = content["body"] as string | undefined;
      const sender = event.getSender();
      const eventId = event.getId();
      if (!body || !sender || !eventId) continue;
      results.push({ eventId, sender, body, timestamp: event.getTs() });
    }

    return results;
  }

  async markRead(roomId: string, eventId: string): Promise<void> {
    try {
      await this.matrix.getSDKClient().setRoomReadMarkers(roomId, eventId);
    } catch (err) {
      log.warn({ err, roomId, eventId }, "markRead failed");
    }
  }
}

