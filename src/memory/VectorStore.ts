import { ChromaClient, Collection } from "chromadb";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { ParsedMessage } from "../matrix/EventRouter.js";

const log = getLogger("VectorStore");

export interface ChunkMetadata {
  roomHash: string;
  sender?: string;
  timestamp?: number;
  eventId?: string;
  type: "message" | "document" | "skill";
}

export interface SearchResult {
  content: string;
  metadata: ChunkMetadata;
  distance: number;
}

/**
 * Room-scoped vector store – has no cross-room access methods.
 */
export class RoomVectorStore {
  constructor(
    private readonly collection: Collection,
    private readonly roomHash: string
  ) {}

  async add(content: string, metadata: ChunkMetadata): Promise<void> {
    const id = `${this.roomHash}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await this.collection.add({
      ids: [id],
      documents: [content],
      metadatas: [metadata as unknown as Record<string, string | number | boolean>],
    });
  }

  async search(query: string, limit = 4): Promise<SearchResult[]> {
    const result = await this.collection.query({
      queryTexts: [query],
      nResults: limit,
    });

    const results: SearchResult[] = [];
    const docs = result.documents[0] ?? [];
    const metas = result.metadatas[0] ?? [];
    const dists = result.distances?.[0] ?? [];

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const meta = metas[i];
      if (!doc || !meta) continue;
      results.push({
        content: doc,
        metadata: meta as unknown as ChunkMetadata,
        distance: dists[i] ?? 0,
      });
    }

    return results;
  }

  async addMessage(msg: ParsedMessage): Promise<void> {
    await this.add(msg.body, {
      roomHash: this.roomHash,
      sender: msg.sender,
      timestamp: msg.timestamp,
      eventId: msg.eventId,
      type: "message",
    });
  }
}

/**
 * Top-level store. Only exposes per-room access – no cross-room reads.
 */
export class VectorStore {
  private readonly client: ChromaClient;
  private readonly collections = new Map<string, RoomVectorStore>();

  constructor() {
    const config = getConfig();
    const url = new URL(config.CHROMADB_URL);
    this.client = new ChromaClient({
      host: url.hostname,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      ssl: url.protocol === "https:",
    });
  }

  forRoom(roomHash: string): RoomVectorStore {
    const existing = this.collections.get(roomHash);
    if (existing) return existing;

    // Collection is created lazily when first used
    const store = new LazyRoomVectorStore(this.client, roomHash);
    this.collections.set(roomHash, store as unknown as RoomVectorStore);
    return store as unknown as RoomVectorStore;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.client.heartbeat();
      return true;
    } catch (err) {
      log.warn({ err }, "ChromaDB health check failed");
      return false;
    }
  }
}

/**
 * Lazily initialises the ChromaDB collection on first use.
 */
class LazyRoomVectorStore {
  private inner: RoomVectorStore | null = null;

  constructor(
    private readonly client: ChromaClient,
    private readonly roomHash: string
  ) {}

  private async resolve(): Promise<RoomVectorStore> {
    if (this.inner) return this.inner;
    const collection = await this.client.getOrCreateCollection({
      name: `room_${this.roomHash}`,
    });
    this.inner = new RoomVectorStore(collection, this.roomHash);
    return this.inner;
  }

  async add(content: string, metadata: ChunkMetadata): Promise<void> {
    const store = await this.resolve();
    return store.add(content, metadata);
  }

  async search(query: string, limit?: number): Promise<SearchResult[]> {
    const store = await this.resolve();
    return store.search(query, limit);
  }

  async addMessage(msg: ParsedMessage): Promise<void> {
    const store = await this.resolve();
    return store.addMessage(msg);
  }
}
