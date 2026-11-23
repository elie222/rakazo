export function mobileBackupScopeIsCurrent(input: {
  expectedUserId: string;
  expectedSpaceId: string;
  currentUserId: string;
  currentSpaceId: string;
  selectedSpaceId: string | null;
  requestGeneration: number;
  currentGeneration: number;
}): boolean {
  return (
    input.expectedUserId === input.currentUserId &&
    input.expectedSpaceId === input.currentSpaceId &&
    (input.selectedSpaceId === null || input.selectedSpaceId === input.expectedSpaceId) &&
    input.requestGeneration === input.currentGeneration
  );
}

type MobileBackupScope = { userId: string; spaceId: string };
type MobileBackupSaveQueue = { tail: Promise<void>; failures: number };

// Lives outside the screen so an accepted edit still saves after the user leaves Models.
const backupSaveQueues = new Map<string, MobileBackupSaveQueue>();

function backupScopeKey(scope: MobileBackupScope): string {
  return JSON.stringify([scope.userId, scope.spaceId]);
}

/**
 * Runs one scope's backup saves in order. Resolves true once saved, or false when an earlier
 * save failed and this one was dropped so the screen can fall back to the server's list.
 */
export function queueMobileBackupSave(
  scope: MobileBackupScope,
  save: () => Promise<void>,
): Promise<boolean> {
  const key = backupScopeKey(scope);
  const queue = backupSaveQueues.get(key) ?? { tail: Promise.resolve(), failures: 0 };
  backupSaveQueues.set(key, queue);
  const failures = queue.failures;
  const run = queue.tail.then(async () => {
    if (failures !== queue.failures) return false;
    try {
      await save();
      return true;
    } catch (err) {
      queue.failures += 1;
      throw err;
    }
  });
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queue.tail = tail;
  void tail.then(() => {
    if (queue.tail === tail) backupSaveQueues.delete(key);
  });
  return run;
}

/** Settles once every save queued for the scope so far has finished. */
export function pendingMobileBackupSaves(scope: MobileBackupScope): Promise<void> {
  return backupSaveQueues.get(backupScopeKey(scope))?.tail ?? Promise.resolve();
}
