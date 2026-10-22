/** Apply edits immediately, saving one at a time and retaining only the latest edit. */
export function createQueuedSave<T>(
  initial: T,
  {
    save,
    onChange,
    onError,
    onSaved,
    onSavingChange,
    equals = Object.is,
  }: {
    save: (value: T) => Promise<void>;
    onChange: (value: T) => void;
    onError: (error: unknown) => void;
    onSaved?: (value: T) => Promise<void>;
    onSavingChange?: (saving: boolean) => void;
    equals?: (a: T, b: T) => boolean;
  },
) {
  let confirmed = initial;
  let latest = initial;
  let saving = false;
  let revision = 0;
  let inFlight: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;

  async function drain() {
    saving = true;
    onSavingChange?.(true);
    try {
      while (!equals(latest, confirmed)) {
        const next = latest;
        const requestRevision = revision;
        try {
          await save(next);
        } catch (error) {
          if (requestRevision !== revision) continue;
          failure = { error };
          latest = confirmed;
          onChange(confirmed);
          onError(error);
          break;
        }
        confirmed = next;
        try {
          await onSaved?.(next);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      saving = false;
      onSavingChange?.(false);
    }
  }

  return {
    // A fresh read can replace the baseline when it did not overlap a save.
    reset(value: T) {
      if (!saving) {
        confirmed = latest = value;
        failure = undefined;
      }
    },
    // Wait for all queued edits; a failed write remains an error until the next edit or reset.
    async flush() {
      while (inFlight) {
        const current = inFlight;
        await current;
        if (inFlight === current) inFlight = undefined;
      }
      if (failure) throw failure.error;
    },
    update(value: T) {
      revision += 1;
      latest = value;
      onChange(value);
      if (!saving) {
        failure = undefined;
        inFlight = drain();
      }
    },
  };
}
