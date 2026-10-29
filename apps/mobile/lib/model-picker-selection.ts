import type { ChatModelChoice } from "@rakazo/core";
import type { Href } from "expo-router";

export type ModelPickerRequest = {
  title?: string;
  emptyMessage?: string;
  choices: ChatModelChoice[];
  /** Providers that need a connection first, listed after the models. */
  connectChoices?: ChatModelChoice[];
  selectedKey: string;
  providerLabel?: string;
  onSelect: (choice: ChatModelChoice) => void;
  /** A choice that continues elsewhere replaces the picker with that screen. */
  continueTo?: (choice: ChatModelChoice) => Href | undefined;
};

let nextId = 0;
const requests = new Map<string, ModelPickerRequest>();

/** Ephemeral, owner-scoped picker requests; never serialized into links or storage. */
export function openModelPicker(request: ModelPickerRequest): string {
  const id = String(++nextId);
  requests.set(id, request);
  return id;
}

export function modelPickerRequest(id: string): ModelPickerRequest | undefined {
  return requests.get(id);
}

export function closeModelPicker(id: string): void {
  requests.delete(id);
}

export function selectPickerModel(id: string, key: string): Href | boolean {
  const request = requests.get(id);
  const choice = [...(request?.choices ?? []), ...(request?.connectChoices ?? [])].find(
    (entry) => entry.key === key,
  );
  if (!request || !choice) return false;
  requests.delete(id);
  const next = request.continueTo?.(choice);
  if (next) return next;
  request.onSelect(choice);
  return true;
}
