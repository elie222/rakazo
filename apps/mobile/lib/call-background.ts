import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

type RakazoCallNative = {
  startCall(title: string): Promise<boolean>;
  stopCall(): Promise<void>;
};

const nativeCall =
  Platform.OS === "android"
    ? requireOptionalNativeModule<RakazoCallNative>("RakazoNotifications")
    : null;

/** The native start answers from the service itself, which can take a moment. */
const START_TIMEOUT_MS = 5000;

// Start and stop reach one service, so they run in the order they were asked for:
// a stop issued while a start is in flight must not be overtaken by it.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Keep the microphone call alive while the screen is off. */
export async function startCallBackground(title: string): Promise<boolean> {
  if (!nativeCall) return false;
  return serialized(async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        nativeCall.startCall(title).catch(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), START_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
}

export async function stopCallBackground(): Promise<void> {
  if (!nativeCall) return;
  await serialized(async () => {
    await nativeCall.stopCall().catch(() => undefined);
  });
}
