import { MatrixEvent, Room } from "matrix-js-sdk";
import { MatrixClient } from "./MatrixClient.js";
import { getLogger } from "../logger.js";

const log = getLogger("EventRouter");

export interface ParsedMessage {
  roomId: string;
  eventId: string;
  sender: string;
  body: string;
  timestamp: number;
  isDM: boolean;
  isReply: boolean;
  replyToEventId: string | undefined;
}

export type MessageHandler = (msg: ParsedMessage) => Promise<void>;

export class EventRouter {
  private messageHandlers: MessageHandler[] = [];
  private processedEvents = new Set<string>();

  constructor(private readonly matrix: MatrixClient) {
    this.matrix.onTimelineEvent(this.handleEvent.bind(this));
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  private handleEvent(event: MatrixEvent, room: Room | undefined): void {
    if (event.getType() !== "m.room.message") return;

    const eventId = event.getId();
    if (!eventId) return;
    if (this.processedEvents.has(eventId)) return;
    this.processedEvents.add(eventId);

    // Deduplicate; keep set bounded
    if (this.processedEvents.size > 10_000) {
      const first = this.processedEvents.values().next().value;
      if (first) this.processedEvents.delete(first);
    }

    const content = event.getContent();
    if (content["msgtype"] !== "m.text") return;

    const body = content["body"] as string | undefined;
    if (!body || typeof body !== "string") return;

    const sender = event.getSender();
    if (!sender) return;

    // Skip messages from before bot started (old history)
    const age = event.getAge();
    if (age !== null && age !== undefined && age > 10_000) {
      log.debug({ eventId, age }, "Skipping old event");
      return;
    }

    const roomId = event.getRoomId();
    if (!roomId) return;

    const isDM = room ? isDMRoom(room) : false;
    const relatesTo = content["m.relates_to"];
    const isReply = relatesTo?.["m.in_reply_to"] != null;
    const replyToEventId = relatesTo?.["m.in_reply_to"]?.["event_id"] as
      | string
      | undefined;

    const parsed: ParsedMessage = {
      roomId,
      eventId,
      sender,
      body,
      timestamp: event.getTs(),
      isDM,
      isReply,
      replyToEventId,
    };

    for (const handler of this.messageHandlers) {
      handler(parsed).catch((err) => {
        log.error({ err, roomId, eventId }, "Message handler threw");
      });
    }
  }
}

function isDMRoom(room: Room): boolean {
  const members = room.getMembers();
  return members.length <= 2;
}
