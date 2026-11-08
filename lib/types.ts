/** Shared types for the Brian voice assistant. */

export type Speaker = "user" | "assistant";

export type ActionType =
  | "call"
  | "open-app"
  | "alarm"
  | "reminder"
  | "notifications"
  | "settings"
  | "web"
  | "none";

/** A concrete thing the assistant wants the phone to do. */
export interface AssistantAction {
  type: ActionType;
  /** Human readable label, e.g. "Call Mom". */
  label: string;
  /** Link the UI can open (tel:, intent:, https:). */
  href?: string;
  /** Extra context for the UI (e.g. why it needs a permission). */
  detail?: string;
  /** Android intent URI, when the web fallback differs. */
  androidIntent?: string;
}

export interface ChatTurn {
  role: Speaker;
  content: string;
}

export interface ChatMessage extends ChatTurn {
  id: string;
  at: number;
  mode?: "ai" | "offline";
  action?: AssistantAction;
  source?: "voice" | "typed";
}

export interface AssistantReply {
  reply: string;
  mode: "ai" | "offline";
  action?: AssistantAction;
  model?: string;
  note?: string;
}

export type Personality = "friendly" | "concise" | "warm";

export interface AssistantSettings {
  assistantName: string;
  wakeWord: string;
  personality: Personality;
  voiceURI: string;
  rate: number;
  pitch: number;
  volume: number;
  language: string;
  continuousListening: boolean;
  ownerOnly: boolean;
}

export const DEFAULT_SETTINGS: AssistantSettings = {
  assistantName: "Brian",
  wakeWord: "Hey Brian",
  personality: "friendly",
  voiceURI: "",
  rate: 1.02,
  pitch: 1.0,
  volume: 1,
  language: "en-US",
  continuousListening: false,
  ownerOnly: false,
};
