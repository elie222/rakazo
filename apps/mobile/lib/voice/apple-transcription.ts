/** SpeechAnalyzer exists only on iOS; see apple-transcription.ios.ts. */
export async function appleTranscriber(
  _lang: string,
): Promise<((uri: string) => Promise<string>) | null> {
  return null;
}
