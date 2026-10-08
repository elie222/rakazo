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
