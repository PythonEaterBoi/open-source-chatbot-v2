export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  reasoning?: string;
  model?: string;
  error?: string;
  /** ms timestamp when the message was created */
  at: number;
}

export interface Conversation {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  blurb: string;
  tier: "free" | "key";
  tags: string[];
  available: boolean;
  listed: boolean;
}

export interface ModelCatalog {
  models: ModelInfo[];
  source: "live" | "fallback";
  defaultModel: string;
}
