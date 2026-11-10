export type MessageActionSheet = {
  actions: { text: string; onPress: () => void }[];
  title?: string;
  selected?: number;
  colorScheme: "light" | "dark";
};

let current: MessageActionSheet | null = null;
let mounted = false;
let selecting = false;
const listeners = new Set<() => void>();

function setSheet(sheet: MessageActionSheet | null) {
  current = sheet;
  selecting = false;
  for (const listener of listeners) listener();
}

export const getMessageActionSheet = () => current;

export function subscribeMessageActionSheet(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mountMessageActionSheetHost() {
  mounted = true;
  return () => {
    mounted = false;
    setSheet(null);
  };
}

export function showMessageActionSheet(sheet: MessageActionSheet): boolean {
  if (!mounted) return false;
  setSheet(sheet);
  return true;
}

export function dismissMessageActionSheet(sheet: MessageActionSheet) {
  if (current === sheet) setSheet(null);
}

export async function selectMessageActionSheet(
  sheet: MessageActionSheet,
  index: number,
  hide: () => Promise<void>,
) {
  const action = sheet.actions[index];
  if (current !== sheet || selecting || !action) return;
  selecting = true;
  try {
    await hide();
  } catch {
    dismissMessageActionSheet(sheet);
    return;
  }
  if (current !== sheet) return;
  dismissMessageActionSheet(sheet);
  action.onPress();
}
