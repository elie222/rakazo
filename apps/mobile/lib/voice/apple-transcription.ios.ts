import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { File } from "expo-file-system";

/**
 * iOS 26's on-device SpeechAnalyzer, which transcribes a finished recording in one pass, so
 * pauses never cut a message short. Null where the device or its language lacks it.
 */
export async function appleTranscriber(
  lang: string,
): Promise<((uri: string) => Promise<string>) | null> {
  if (!AppleTranscription.isAvailable(lang)) return null;
  // isAvailable ignores the language. prepare rejects one SpeechAnalyzer lacks, so the live
  // recognizer takes it, and otherwise names the locale whose model it installed. Builds from
  // before patches/@react-native-ai__apple@0.12.0.patch name none, so the tag stands in.
  const locale = await AppleTranscription.prepare(lang).then(
    (supported: string | null | undefined) => supported || lang,
    () => null,
  );
  if (!locale) return null;
  return async (uri) => {
    const result = await AppleTranscription.transcribe(await new File(uri).arrayBuffer(), locale);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  };
}
