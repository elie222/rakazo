/** Private fanout scope for the calendar connection of one member in a Space. */
export function meetingCalendarScope(spaceId: string, userId: string) {
  return `meeting-calendar:${JSON.stringify([spaceId, userId])}`;
}
