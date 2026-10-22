import type { ChatModelChoice } from "@rakazo/core";

export type ModelPickerRequest = {
  title?: string;
  emptyMessage?: string;
  choices: ChatModelChoice[];
  selectedKey: string;
  providerLabel?: string;
  onSelect: (choice: ChatModelChoice) => void;
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

export function selectPickerModel(id: string, key: string): boolean {
  const request = requests.get(id);
  const choice = request?.choices.find((entry) => entry.key === key);
  if (!request || !choice) return false;
  requests.delete(id);
  request.onSelect(choice);
  return true;
}
