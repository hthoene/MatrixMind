export interface LLMQueryParams {
  prompt: string;
  workspacePath: string;
  allowedTools?: string[];
}

export interface LLMResponse {
  text: string;
  toolsUsed: string[];
  tokenUsage: { input: number; output: number };
}

export interface LLMProvider {
  query(params: LLMQueryParams): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}
