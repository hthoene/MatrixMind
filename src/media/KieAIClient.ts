import fs from "node:fs";
import path from "node:path";
import { getConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { ensureDir, safePath } from "../utils/safePath.js";
import {
  extensionFromMimeType,
  extensionFromUrl,
  guessMimeType,
} from "../utils/media.js";

const log = getLogger("KieAIClient");

const DEFAULT_BASE_URL = "https://api.kie.ai";

interface KieEnvelope<T> {
  code?: number;
  msg?: string;
  data?: T;
}

interface KieTaskCreateResponse {
  taskId?: string;
}

interface KieTaskRecord {
  taskId?: string;
  successFlag?: number | string;
  status?: string;
  errorCode?: number | string | null;
  errorMessage?: string | null;
  progress?: string | null;
  response?: Record<string, unknown> | null;
}

export interface GeneratedMedia {
  taskId: string;
  localPath: string;
  relativePath: string;
  remoteUrl: string;
  mimeType: string;
}

export class KieAIClient {
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;

  constructor() {
    const config = getConfig();
    this.apiKey = config.KIE_AI_API_KEY?.trim() || undefined;
    this.baseUrl = DEFAULT_BASE_URL;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async generateImage(
    workspacePath: string,
    prompt: string
  ): Promise<GeneratedMedia> {
    this.assertConfigured();

    const taskId = await this.createTask("/api/v1/gpt4o-image/generate", {
      prompt,
      size: "1:1",
      nVariants: 1,
      isEnhance: false,
    });

    const record = await this.pollTask(
      `/api/v1/gpt4o-image/record-info?taskId=${encodeURIComponent(taskId)}`,
      taskId,
      4_000,
      5 * 60_000
    );

    const url = this.extractResultUrl(record);
    return this.downloadResult(workspacePath, url, "files/generated/images", "kie-image");
  }

  async generateVideo(
    workspacePath: string,
    prompt: string
  ): Promise<GeneratedMedia> {
    this.assertConfigured();

    const taskId = await this.createTask("/api/v1/veo/generate", {
      prompt,
      model: "veo3",
      aspect_ratio: "16:9",
    });

    const record = await this.pollTask(
      `/api/v1/veo/record-info?taskId=${encodeURIComponent(taskId)}`,
      taskId,
      7_500,
      15 * 60_000
    );

    const url = this.extractResultUrl(record);
    return this.downloadResult(workspacePath, url, "files/generated/videos", "kie-video");
  }

  private async createTask(endpoint: string, payload: Record<string, unknown>): Promise<string> {
    const response = await this.fetchJson<KieTaskCreateResponse>(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const taskId = response.data?.taskId;
    if (!taskId) {
      throw new Error(`Kie.ai returned no taskId for ${endpoint}`);
    }

    return taskId;
  }

  private async pollTask(
    endpoint: string,
    taskId: string,
    intervalMs: number,
    timeoutMs: number
  ): Promise<KieTaskRecord> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const response = await this.fetchJson<KieTaskRecord>(endpoint, {
        method: "GET",
      });
      const record = response.data ?? {};
      const successFlag = Number(record.successFlag);
      const status = String(record.status ?? "").toLowerCase();

      if (successFlag === 1 || status === "success") {
        return record;
      }

      if (
        successFlag === 2 ||
        successFlag === 3 ||
        status === "fail" ||
        status.includes("failed")
      ) {
        throw new Error(
          record.errorMessage ||
            response.msg ||
            `Kie.ai task ${taskId} failed without an error message`
        );
      }

      log.debug(
        { taskId, successFlag, status, progress: record.progress },
        "Kie.ai task still running"
      );
      await sleep(intervalMs);
    }

    throw new Error(`Kie.ai task ${taskId} timed out after ${timeoutMs}ms`);
  }

  private extractResultUrl(record: KieTaskRecord): string {
    const response = record.response ?? {};
    const candidates = [
      response["resultUrls"],
      response["result_urls"],
      response["resultUrl"],
      response["result_url"],
      response["videoUrl"],
      response["resultImageUrl"],
    ];

    for (const candidate of candidates) {
      const urls = normalizeUrls(candidate);
      const firstUrl = urls[0];
      if (firstUrl) return firstUrl;
    }

    throw new Error(`Kie.ai task ${record.taskId ?? "unknown"} finished without a result URL`);
  }

  private async downloadResult(
    workspacePath: string,
    remoteUrl: string,
    subdir: string,
    basenamePrefix: string
  ): Promise<GeneratedMedia> {
    const response = await fetch(remoteUrl);
    if (!response.ok) {
      throw new Error(`Failed to download Kie.ai result: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const mimeType = response.headers.get("content-type") || guessMimeType(remoteUrl);
    const ext =
      extensionFromUrl(remoteUrl) ||
      extensionFromMimeType(mimeType) ||
      (mimeType.startsWith("video/") ? ".mp4" : ".png");
    const filename = `${basenamePrefix}-${Date.now()}${ext}`;
    const relativePath = path.posix.join(subdir.replace(/\\/g, "/"), filename);
    const localPath = safePath(workspacePath, relativePath);

    ensureDir(path.dirname(localPath));
    fs.writeFileSync(localPath, buffer);

    return {
      taskId: filename,
      localPath,
      relativePath,
      remoteUrl,
      mimeType,
    };
  }

  private async fetchJson<T>(
    endpoint: string,
    init: RequestInit
  ): Promise<KieEnvelope<T>> {
    const response = await fetch(new URL(endpoint, this.baseUrl), {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(init.method === "POST" ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    const json = (await response.json()) as KieEnvelope<T>;
    if (!response.ok || json.code !== 200) {
      throw new Error(json.msg || `Kie.ai request failed with HTTP ${response.status}`);
    }

    return json;
  }

  private assertConfigured(): void {
    if (!this.apiKey) {
      throw new Error("KIE_AI_API_KEY is not configured");
    }
  }
}

function normalizeUrls(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }

  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return normalizeUrls(parsed);
    } catch {
      return [value];
    }
  }

  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
