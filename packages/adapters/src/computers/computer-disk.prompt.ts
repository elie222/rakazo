// No live figures: the note sits in the system prompt, so a changing number would invalidate
// the model's cached prefix on every run while the disk stays full.
export const DISK_NOTE_INSTRUCTION =
  "The computer's disk is almost full. Free space by removing build output and caches you no longer need, or tell the user.";
