/**
 * On-device speech: recognition and read-aloud that run entirely on the phone,
 * with no server and no system speech service. This is the only module that
 * touches the speech engine SDK; everything outside it speaks the
 * provider-neutral interface below (available / listen / speak), so the
 * engine can be swapped without touching callers, settings, or UI copy.
 *
 * The engine loads on first use, not with every screen that imports this.
 * Models are downloaded once, on demand, into the app's document directory;
 * nothing is bundled with the app.
 */

import { toUtterances } from "@rakazo/core";
import type { DictationGiveUp } from "./dictation";
import { ENDPOINT_SILENCE_MS } from "./dictation";
import { t } from "./i18n";
import { loadVerifiedIntegrationsScope } from "./session";

/**
 * The speech models, from the engine's official releases. The ids are the
 * release asset names without the archive suffix; the download manager
 * resolves them to the release download URLs itself, so no URL is hardcoded
 * here. Sizes are the release tarball sizes, shown before downloading.
 *
 * STT is a pure-Chinese streaming transducer (70.6 MB). The streaming
 * Paraformer is the same family but ships as a ~1 GB tarball, which is not
 * a reasonable first download on a phone, so it is not the default.
 * TTS is a multilingual voice model with Chinese voices (140.2 MB, int8).
 */
const STT_MODEL_ID = "sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23";
const TTS_MODEL_ID = "kokoro-int8-multi-lang-v1_1";
const STT_MODEL_MB = 71;
const TTS_MODEL_MB = 141;
/** The Chinese female voice used for read-aloud. */
const TTS_VOICE_SID = 3;
/** Microphone and recognition sample rate. */
const STT_SAMPLE_RATE = 16_000;

/** Download sizes, for the settings screen to show before downloading. */
export function onDeviceSpeechModelSizes(): { sttMb: number; ttsMb: number; totalMb: number } {
  return { sttMb: STT_MODEL_MB, ttsMb: TTS_MODEL_MB, totalMb: STT_MODEL_MB + TTS_MODEL_MB };
}

/** The slice of the engine SDK this module needs, so tests can drive it. */
export type OnDeviceSpeechNative = {
  createStreamingStt: (options: {
    modelPath: { type: "file"; path: string };
    modelType: string;
    enableEndpoint: boolean;
    endpointConfig: {
      rule1: {
        mustContainNonSilence: boolean;
        minTrailingSilence: number;
        minUtteranceLength: number;
      };
      rule2: {
        mustContainNonSilence: boolean;
        minTrailingSilence: number;
        minUtteranceLength: number;
      };
      rule3: {
        mustContainNonSilence: boolean;
        minTrailingSilence: number;
        minUtteranceLength: number;
      };
    };
  }) => Promise<{
    createStream: () => Promise<{
      processAudioChunk: (
        samples: Float32Array,
        sampleRate: number,
      ) => Promise<{ result: { text: string }; isEndpoint: boolean }>;
      inputFinished: () => Promise<void>;
      release: () => Promise<void>;
    }>;
    destroy: () => Promise<void>;
  }>;
  createPcmLiveStream: (options: { sampleRate: number }) => {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    onData: (callback: (samples: Float32Array, sampleRate: number) => void) => () => void;
    onError: (callback: (message: string) => void) => () => void;
  };
  createTts: (options: {
    modelPath: { type: "file"; path: string };
    modelType: string;
  }) => Promise<{
    generateSpeech: (
      text: string,
      options?: { sid?: number },
    ) => Promise<{ samples: number[]; sampleRate: number }>;
    destroy: () => Promise<void>;
  }>;
  ensureModel: (
    category: string,
    id: string,
    opts?: { onProgress?: (progress: { percent: number; phase: string }) => void },
  ) => Promise<{ localPath: string }>;
  /**
   * Extracts a model whose archive is already at the download manager's
   * fixed archive path. `verifyChecksum` defaults to on; import passes
   * false for TTS, whose checksum.txt is stale upstream (see
   * extractPlacedModel). The default download path never passes it.
   */
  extractModel: (
    category: string,
    id: string,
    opts?: {
      onProgress?: (progress: { percent: number; phase: string }) => void;
      verifyChecksum?: boolean;
    },
  ) => Promise<{ localPath: string }>;
  /** The document directory the download manager stores models under. */
  getStorageBasePath: () => Promise<string>;
  isModelDownloaded: (category: string, id: string) => Promise<boolean>;
  getModelPath: (category: string, id: string) => Promise<string | null>;
  deleteModel: (category: string, id: string) => Promise<void>;
  /**
   * Fetches a category's release list into the download manager's local
   * cache. ensureModel looks a model id up in that cache, and the cache
   * starts empty, so a download must refresh first; the manager returns the
   * cached list when it is under a day old.
   */
  refreshModels: (category: string) => Promise<unknown[]>;
};

let injected: OnDeviceSpeechNative | null = null;
/** Test seam: an injected engine replaces the native module. */
export function setOnDeviceSpeechNative(native: OnDeviceSpeechNative | null): void {
  injected = native;
  nativePromise = null;
  // A replaced engine must not keep a TTS engine built from the old one.
  ttsEngine = null;
  ttsEnginePromise = null;
}

let nativePromise: Promise<OnDeviceSpeechNative> | null = null;

/** The TTS engine, built once from the downloaded model and reused. */
let ttsEngine: Awaited<ReturnType<OnDeviceSpeechNative["createTts"]>> | null = null;
let ttsEnginePromise: Promise<Awaited<ReturnType<OnDeviceSpeechNative["createTts"]>>> | null = null;

async function loadNative(): Promise<OnDeviceSpeechNative> {
  if (injected) return injected;
  nativePromise ??= (async () => {
    const [stt, audio, tts, download] = await Promise.all([
      import("react-native-sherpa-onnx/stt"),
      import("react-native-sherpa-onnx/audio"),
      import("react-native-sherpa-onnx/tts"),
      import("react-native-sherpa-onnx/download"),
    ]);
    // The SDK's own types are structurally identical to the slice above;
    // the cast keeps vendor types out of this module's public surface.
    return {
      createStreamingStt: stt.createStreamingSTT,
      createPcmLiveStream: audio.createPcmLiveStream,
      createTts: tts.createTTS,
      ensureModel: download.ensureModel,
      extractModel: download.extractModel,
      getStorageBasePath: download.getStorageBasePath,
      isModelDownloaded: download.isModelDownloaded,
      getModelPath: download.getModelPath,
      deleteModel: download.deleteModel,
      refreshModels: download.refreshModels,
    } as unknown as OnDeviceSpeechNative;
  })();
  return nativePromise;
}

// Settings: one on/off switch per account. Off by default: enabling it
// starts a ~211 MB model download, so it must be an explicit choice.

const SETTINGS_KEY_PREFIX = "rakazo.on-device-speech.";

function settingsKey(userId: string): string {
  return `${SETTINGS_KEY_PREFIX}${userId}`;
}

/**
 * Reads the switch for the signed-in account. The account is resolved here,
 * so callers never need the session: no account, no on-device speech.
 */
export async function loadOnDeviceSpeechEnabled(): Promise<boolean> {
  const userId = await currentUserId();
  if (!userId) return false;
  try {
    const SecureStore = await import("expo-secure-store");
    return (await SecureStore.getItemAsync(settingsKey(userId))) === "1";
  } catch {
    return false;
  }
}

export async function saveOnDeviceSpeechEnabled(on: boolean): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  const SecureStore = await import("expo-secure-store");
  await SecureStore.setItemAsync(settingsKey(userId), on ? "1" : "0");
}

async function currentUserId(): Promise<string | null> {
  try {
    return (await loadVerifiedIntegrationsScope())?.userId ?? null;
  } catch {
    return null;
  }
}

// Model management: the download manager fetches the models from the
// engine's official releases, resumes interrupted downloads, and verifies
// checksums. Models live in the app's document directory.

export type OnDeviceSpeechModelState = "missing" | "downloading" | "ready";

export type OnDeviceSpeechModelsStatus = {
  stt: OnDeviceSpeechModelState;
  tts: OnDeviceSpeechModelState;
  /** 0..1 while a download is running, null otherwise. */
  progress: number | null;
};

let downloading: Promise<void> | null = null;
let downloadProgress: number | null = null;

export async function onDeviceSpeechModelsStatus(): Promise<OnDeviceSpeechModelsStatus> {
  const native = await loadNative().catch(() => null);
  if (!native) return { stt: "missing", tts: "missing", progress: null };
  const [stt, tts] = await Promise.all([
    onDeviceSpeechModelReady("stt"),
    onDeviceSpeechModelReady("tts"),
  ]).catch(() => [false, false] as const);
  if (downloading) {
    return {
      stt: stt ? "ready" : "downloading",
      tts: tts ? "ready" : "downloading",
      progress: downloadProgress,
    };
  }
  return { stt: stt ? "ready" : "missing", tts: tts ? "ready" : "missing", progress: null };
}

/**
 * Downloads both models, resuming where a previous attempt stopped.
 * Resolves when both are on disk; reports combined progress (0..1) as the
 * downloads and extractions proceed. A second call while one is running
 * waits for the same download instead of starting another.
 */
export async function downloadOnDeviceSpeechModels(
  onProgress?: (status: OnDeviceSpeechModelsStatus) => void,
): Promise<void> {
  if (downloading) {
    await downloading;
    return;
  }
  downloading = (async () => {
    const native = await loadNative();
    const report = async () => {
      const status = await onDeviceSpeechModelsStatus().catch(() => ({
        stt: "missing" as const,
        tts: "missing" as const,
        progress: downloadProgress,
      }));
      onProgress?.(status);
    };
    // The download manager only knows a model after its release list is
    // fetched: ensureModel looks the id up in a local cache, and the cache
    // starts empty, so refresh both lists before downloading. refreshModels
    // returns the cached list when it is under a day old.
    await native.refreshModels("stt");
    await native.refreshModels("tts");
    // A model the manager marked ready can still be missing the files
    // the engine loads; ensureModel would skip it as already downloaded,
    // so clear it here and let the download below repair it.
    for (const category of ["stt", "tts"] as const) {
      const downloaded = await native
        .isModelDownloaded(category, onDeviceSpeechModelId(category))
        .catch(() => false);
      if (downloaded && !(await onDeviceSpeechModelReady(category))) {
        await native.deleteModel(category, onDeviceSpeechModelId(category)).catch(() => undefined);
      }
    }
    // The two downloads run one after the other so the progress bar reads
    // as one download: STT first, then TTS.
    downloadProgress = 0;
    await native.ensureModel("stt", STT_MODEL_ID, {
      onProgress: (progress) => {
        downloadProgress = progress.percent / 200;
        void report();
      },
    });
    await native.ensureModel("tts", TTS_MODEL_ID, {
      onProgress: (progress) => {
        downloadProgress = 0.5 + progress.percent / 200;
        void report();
      },
    });
    downloadProgress = 1;
    await report();
  })();
  try {
    await downloading;
  } finally {
    downloading = null;
    downloadProgress = null;
  }
}

export async function deleteOnDeviceSpeechModels(): Promise<void> {
  const native = await loadNative();
  await Promise.all([
    native.deleteModel("stt", STT_MODEL_ID).catch(() => undefined),
    native.deleteModel("tts", TTS_MODEL_ID).catch(() => undefined),
  ]);
}

// Bring-your-own archive: a model can come from a local file the user
// picked, or from a base address the user entered, instead of the
// engine's GitHub releases. Both place the archive at the download
// manager's fixed archive path and extract it from there, so the
// manager's size check and extraction still apply.

export type OnDeviceSpeechModelCategory = "stt" | "tts";

function onDeviceSpeechModelId(category: OnDeviceSpeechModelCategory): string {
  return category === "stt" ? STT_MODEL_ID : TTS_MODEL_ID;
}

/** The archive filename for a model, as the download manager names it. */
function onDeviceSpeechArchiveName(category: OnDeviceSpeechModelCategory): string {
  return `${onDeviceSpeechModelId(category)}.tar.bz2`;
}

/**
 * The files the engine needs inside a model's directory. The download
 * manager marks a model ready when any model-like file survived
 * extraction, so a partial extraction can look ready while the native
 * loader has nothing to load — and a native load of a missing file can
 * kill the app instead of failing. Check the exact files each engine
 * looks for before trusting or loading a model.
 */
const ON_DEVICE_SPEECH_MODEL_FILES: Record<
  OnDeviceSpeechModelCategory,
  { onnxPrefixes: string[]; files: string[]; dirs: string[] }
> = {
  // Streaming transducer: encoder, decoder and joiner plus the token list.
  stt: { onnxPrefixes: ["encoder", "decoder", "joiner"], files: ["tokens.txt"], dirs: [] },
  // Kokoro: one model file, the voice table, the token list and the
  // pronunciation data directory.
  tts: { onnxPrefixes: ["model"], files: ["voices.bin", "tokens.txt"], dirs: ["espeak-ng-data"] },
};

/**
 * True when every file the engine needs is in the model's directory and
 * non-empty. False when the directory is missing, unreadable, or any
 * required file is missing or empty. Never throws: an unverifiable model
 * is treated as unusable, never loaded.
 */
async function onDeviceSpeechModelFilesComplete(
  category: OnDeviceSpeechModelCategory,
  modelPath: string,
): Promise<boolean> {
  try {
    const { Directory, File } = await loadFileSystem();
    const dir = new Directory(toFileUri(modelPath));
    if (!dir.exists) return false;
    const required = ON_DEVICE_SPEECH_MODEL_FILES[category];
    const files = new Map<string, number>();
    const dirs = new Set<string>();
    for (const entry of dir.list()) {
      if (entry instanceof Directory) dirs.add(entry.name);
      else if (entry instanceof File) {
        const size = entry.info().size;
        files.set(entry.name, typeof size === "number" ? size : 0);
      }
    }
    for (const prefix of required.onnxPrefixes) {
      const found = [...files].some(
        ([name, size]) => name.startsWith(prefix) && name.endsWith(".onnx") && size > 0,
      );
      if (!found) return false;
    }
    for (const name of required.files) {
      const size = files.get(name);
      if (size === undefined || size <= 0) return false;
    }
    for (const name of required.dirs) {
      if (!dirs.has(name)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the download manager marked the model ready and the files
 * the engine needs are actually in its directory. The marker alone is
 * not enough: a partial extraction can leave it behind.
 */
async function onDeviceSpeechModelReady(category: OnDeviceSpeechModelCategory): Promise<boolean> {
  try {
    const native = await loadNative();
    const id = onDeviceSpeechModelId(category);
    if (!(await native.isModelDownloaded(category, id))) return false;
    const path = await native.getModelPath(category, id);
    if (!path) return false;
    return onDeviceSpeechModelFilesComplete(category, path);
  } catch {
    return false;
  }
}

/** Where the download manager expects a model's archive. */
async function onDeviceSpeechArchivePath(category: OnDeviceSpeechModelCategory): Promise<string> {
  const native = await loadNative();
  const base = (await native.getStorageBasePath()).replace(/\/+$/, "");
  return `${base}/sherpa-onnx/models/${category}/${onDeviceSpeechArchiveName(category)}`;
}

function toFileUri(path: string): string {
  return path.startsWith("file://") ? path : `file://${path}`;
}

async function ensureArchiveDirectory(archivePath: string): Promise<void> {
  const { Directory } = await loadFileSystem();
  const dir = new Directory(toFileUri(archivePath.slice(0, archivePath.lastIndexOf("/"))));
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
}

/**
 * Extracts a model whose archive is already at the download manager's
 * fixed archive path. The registry lookup needs refreshModels first.
 * STT verifies its checksum; TTS skips verification because the
 * tts-models checksum.txt is stale upstream (verified 2026-11-10: the
 * hosted archive's real SHA-256 differs from the listed one), so
 * verification would reject the official archive on every attempt.
 * Extraction itself still validates the archive.
 */
async function extractPlacedModel(category: OnDeviceSpeechModelCategory): Promise<void> {
  const native = await loadNative();
  await native.refreshModels(category);
  await native.extractModel(category, onDeviceSpeechModelId(category), {
    verifyChecksum: category !== "tts",
  });
}

/**
 * Imports one model from a local archive the user picked. The archive is
 * copied to the download manager's fixed archive path, then extracted.
 * A file with the wrong name is refused with the expected name; a
 * truncated archive fails in extraction with its sizes, never silently.
 */
export async function importOnDeviceSpeechModel(
  category: OnDeviceSpeechModelCategory,
  sourceUri: string,
  sourceName?: string,
): Promise<void> {
  const expected = onDeviceSpeechArchiveName(category);
  if (sourceName && sourceName !== expected) {
    throw new Error(t("Please choose the {name} file.", { name: expected }));
  }
  const { File } = await loadFileSystem();
  const archivePath = await onDeviceSpeechArchivePath(category);
  await ensureArchiveDirectory(archivePath);
  // The archive path is reused: a previous download or import may already
  // have left an archive there, and copy refuses to replace one by
  // default, so overwrite it.
  await new File(sourceUri).copy(new File(toFileUri(archivePath)), { overwrite: true });
  await extractPlacedModel(category);
  // Extraction marks the model ready even when a file is missing; an
  // incomplete model would crash the native loader on first use, so
  // refuse it here and clear the marker instead of leaving it ready.
  // The marker is known to exist after extraction, so only the files
  // need checking.
  const native = await loadNative();
  const modelPath = await native.getModelPath(category, onDeviceSpeechModelId(category));
  if (!modelPath || !(await onDeviceSpeechModelFilesComplete(category, modelPath))) {
    await native.deleteModel(category, onDeviceSpeechModelId(category)).catch(() => undefined);
    throw new Error(t("Could not import the voice models."));
  }
}

/**
 * Downloads one model archive from a base address the user entered, then
 * extracts it. The address is a directory: the archive is fetched from
 * {address}/{id}.tar.bz2. A failed download reports a clear error and
 * leaves any previous archive untouched.
 */
export async function downloadOnDeviceSpeechModelFromAddress(
  category: OnDeviceSpeechModelCategory,
  baseUrl: string,
): Promise<void> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error(t("Enter a model download address."));
  const url = `${base}/${onDeviceSpeechArchiveName(category)}`;
  const { File } = await loadFileSystem();
  const archivePath = await onDeviceSpeechArchivePath(category);
  await ensureArchiveDirectory(archivePath);
  const target = new File(toFileUri(archivePath));
  const temp = new File(toFileUri(`${archivePath}.tmp`));
  if (temp.exists) temp.delete();
  const task = File.createDownloadTask(url, temp);
  let downloaded: { uri: string } | null;
  try {
    downloaded = await task.downloadAsync();
  } finally {
    task.release();
  }
  if (!downloaded || !new File(downloaded.uri).exists) {
    throw new Error(t("Could not download the voice models."));
  }
  // Same as the local import: a previous download or import may already
  // have left an archive at the target, and copy refuses to replace one.
  await new File(downloaded.uri).copy(target, { overwrite: true });
  try {
    new File(downloaded.uri).delete();
  } catch {
    // A leftover temp file is harmless; the archive is already in place.
  }
  await extractPlacedModel(category);
  // Same as the local import: refuse an incomplete model instead of
  // leaving it marked ready for the native loader to crash on.
  const native = await loadNative();
  const modelPath = await native.getModelPath(category, onDeviceSpeechModelId(category));
  if (!modelPath || !(await onDeviceSpeechModelFilesComplete(category, modelPath))) {
    await native.deleteModel(category, onDeviceSpeechModelId(category)).catch(() => undefined);
    throw new Error(t("Could not download the voice models."));
  }
}

async function reportModelsStatus(
  progress: number | null,
  onProgress?: (status: OnDeviceSpeechModelsStatus) => void,
): Promise<void> {
  if (!onProgress) return;
  const status = await onDeviceSpeechModelsStatus().catch(() => ({
    stt: "missing" as const,
    tts: "missing" as const,
    progress,
  }));
  onProgress({ ...status, progress });
}

/**
 * Downloads the missing models from a base address the user entered,
 * STT first, then TTS. Progress is coarse (one step per model), reported
 * through the same status callback the GitHub download uses.
 */
export async function downloadOnDeviceSpeechModelsFromAddress(
  baseUrl: string,
  onProgress?: (status: OnDeviceSpeechModelsStatus) => void,
): Promise<void> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!base) throw new Error(t("Enter a model download address."));
  const status = await onDeviceSpeechModelsStatus();
  const missing: OnDeviceSpeechModelCategory[] = [];
  if (status.stt !== "ready") missing.push("stt");
  if (status.tts !== "ready") missing.push("tts");
  if (missing.length === 0) return;
  await reportModelsStatus(0, onProgress);
  for (const [index, category] of missing.entries()) {
    await downloadOnDeviceSpeechModelFromAddress(category, base);
    await reportModelsStatus((index + 1) / missing.length, onProgress);
  }
}

// A model download address, per account, next to the on-device switch.
// Empty means the engine's GitHub releases.

const MODEL_BASE_URL_KEY_PREFIX = "rakazo.on-device-speech.models-base-url.";

function modelBaseUrlKey(userId: string): string {
  return `${MODEL_BASE_URL_KEY_PREFIX}${userId}`;
}

export async function loadOnDeviceSpeechModelBaseUrl(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) return "";
  try {
    const SecureStore = await import("expo-secure-store");
    return (await SecureStore.getItemAsync(modelBaseUrlKey(userId))) ?? "";
  } catch {
    return "";
  }
}

export async function saveOnDeviceSpeechModelBaseUrl(url: string): Promise<void> {
  const userId = await currentUserId();
  if (!userId) return;
  const SecureStore = await import("expo-secure-store");
  const trimmed = url.trim();
  if (!trimmed) {
    await SecureStore.deleteItemAsync(modelBaseUrlKey(userId));
    return;
  }
  await SecureStore.setItemAsync(modelBaseUrlKey(userId), trimmed);
}

/**
 * True when on-device speech is switched on for this account, both models
 * are on disk, and the engine loads. Anything else falls back to the
 * existing recognition and read-aloud paths.
 */
export async function onDeviceSpeechAvailable(): Promise<boolean> {
  try {
    if (!(await loadOnDeviceSpeechEnabled())) return false;
    const [stt, tts] = await Promise.all([
      onDeviceSpeechModelReady("stt"),
      onDeviceSpeechModelReady("tts"),
    ]);
    return stt && tts;
  } catch {
    return false;
  }
}

// Dictation: the microphone streams into the recognizer, which reports
// words as they are heard. The turn ends the same way system dictation
// ends it — a quiet gap.
//
// Endpoint: the recognizer's own endpoint detection is the primary signal,
// tuned to the same 1.2 s quiet gap system dictation uses, because the
// recognizer knows whether speech was present rather than only how loud the
// room is. A JavaScript timer with the same 1.2 s gap is the fallback, for
// a model whose endpoint detection does not fire; either one ending the
// turn delivers the same text.

type ListenSession = {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp?: (reason: DictationGiveUp) => void;
  pcm: ReturnType<OnDeviceSpeechNative["createPcmLiveStream"]>;
  stream: Awaited<
    ReturnType<Awaited<ReturnType<OnDeviceSpeechNative["createStreamingStt"]>>["createStream"]>
  >;
  engine: Awaited<ReturnType<OnDeviceSpeechNative["createStreamingStt"]>>;
  heard: string;
  silence?: ReturnType<typeof setTimeout>;
  finished: boolean;
  /** Drops the microphone data/error listeners. */
  unsubscribe?: () => void;
};

/** A session older than this one can never deliver a final. */
let token = 0;
let active: ListenSession | null = null;

export function stopOnDeviceSpeech(): void {
  const session = active;
  active = null;
  token += 1;
  if (!session) return;
  clearTimeout(session.silence);
  void teardown(session).catch(() => undefined);
}

async function teardown(session: ListenSession): Promise<void> {
  session.finished = true;
  try {
    await session.pcm.stop();
  } catch {
    // already stopped
  }
  try {
    await session.stream.release();
  } catch {
    // already released
  }
  try {
    await session.engine.destroy();
  } catch {
    // already destroyed
  }
}

/**
 * Delivers the utterance heard so far as the finished turn, e.g. when the
 * caller releases hold-to-talk instead of waiting out the quiet gap. A
 * no-op when nothing is listening or nothing was heard.
 */
export function finishOnDeviceSpeech(): void {
  const session = active;
  if (!session) return;
  finishSession(session);
}

/** Opens the microphone until a quiet gap ends the utterance, or `signal` aborts it. */
export async function listenOnDeviceSpeech(opts: {
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onGiveUp?: (reason: DictationGiveUp) => void;
  signal?: AbortSignal;
  lang?: string;
}): Promise<void> {
  if (opts.signal?.aborted) return;
  stopOnDeviceSpeech();
  const mine = token;
  const native = await loadNative();
  if (token !== mine) return;
  if (opts.signal?.aborted) return;
  const sttPath = await native.getModelPath("stt", STT_MODEL_ID);
  if (token !== mine) return;
  if (!sttPath) {
    opts.onGiveUp?.("failed");
    return;
  }
  // A model marked ready can still be missing the files the native
  // loader needs; give up the same way as a missing model instead of
  // handing a broken directory to the engine.
  if (!(await onDeviceSpeechModelFilesComplete("stt", sttPath))) {
    if (token !== mine) return;
    opts.onGiveUp?.("failed");
    return;
  }
  let engine: Awaited<ReturnType<OnDeviceSpeechNative["createStreamingStt"]>>;
  try {
    engine = await native.createStreamingStt({
      modelPath: { type: "file", path: sttPath },
      modelType: "transducer",
      enableEndpoint: true,
      endpointConfig: {
        rule1: { mustContainNonSilence: false, minTrailingSilence: 1.2, minUtteranceLength: 0 },
        rule2: { mustContainNonSilence: true, minTrailingSilence: 1.2, minUtteranceLength: 0 },
        rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 20 },
      },
    });
  } catch {
    if (token === mine) opts.onGiveUp?.("failed");
    return;
  }
  if (token !== mine) {
    await engine.destroy().catch(() => undefined);
    return;
  }
  let stream: Awaited<ReturnType<typeof engine.createStream>>;
  try {
    stream = await engine.createStream();
  } catch {
    await engine.destroy().catch(() => undefined);
    if (token === mine) opts.onGiveUp?.("failed");
    return;
  }
  if (token !== mine) {
    await stream.release().catch(() => undefined);
    await engine.destroy().catch(() => undefined);
    return;
  }
  const pcm = native.createPcmLiveStream({ sampleRate: STT_SAMPLE_RATE });
  const session: ListenSession = {
    onInterim: opts.onInterim,
    onFinal: opts.onFinal,
    onGiveUp: opts.onGiveUp,
    pcm,
    stream,
    engine,
    heard: "",
    finished: false,
  };
  active = session;
  opts.signal?.addEventListener(
    "abort",
    () => {
      if (active === session) stopOnDeviceSpeech();
    },
    { once: true },
  );
  const unsubscribeData = pcm.onData((samples, sampleRate) => {
    void onAudio(session, samples, sampleRate).catch(() => undefined);
  });
  const unsubscribeError = pcm.onError(() => {
    if (active !== session) return;
    giveUp(session, "failed");
  });
  // Keep the unsubscribe handle on the session so stop() can drop it.
  session.unsubscribe = () => {
    unsubscribeData();
    unsubscribeError();
  };
  try {
    await pcm.start();
  } catch {
    session.unsubscribe?.();
    if (active === session) giveUp(session, "failed");
    return;
  }
  if (token !== mine) return;
}

async function onAudio(
  session: ListenSession,
  samples: Float32Array,
  sampleRate: number,
): Promise<void> {
  if (active !== session || session.finished) return;
  let outcome: { result: { text: string }; isEndpoint: boolean };
  try {
    outcome = await session.stream.processAudioChunk(samples, sampleRate);
  } catch {
    return;
  }
  if (active !== session || session.finished) return;
  const text = outcome.result.text.trim();
  if (text) {
    session.heard = text;
    session.onInterim?.(text);
    // Any words mean the caller was just heard, so the quiet gap restarts here.
    clearTimeout(session.silence);
    session.silence = setTimeout(() => finishSession(session), ENDPOINT_SILENCE_MS);
  }
  if (outcome.isEndpoint) finishSession(session);
}

function giveUp(session: ListenSession, reason: DictationGiveUp): void {
  if (active !== session) return;
  finishSession(session, reason);
}

function finishSession(session: ListenSession, reason?: DictationGiveUp): void {
  if (active !== session) return;
  const text = session.heard.trim();
  const { onFinal } = session;
  session.unsubscribe?.();
  stopOnDeviceSpeech();
  if (text) onFinal(text);
  else if (reason) session.onGiveUp?.(reason);
}

// Read-aloud: each utterance is synthesized on the device and played
// through the system audio player, so pause, resume and stop keep working
// the way hosted read-aloud does. One utterance at a time keeps the first
// words playing while the rest is still being synthesized.

export type OnDeviceSpeechPlayback = {
  pause(): void;
  resume(): void;
  stop(): void;
};

async function loadTtsEngine(): Promise<Awaited<ReturnType<OnDeviceSpeechNative["createTts"]>>> {
  if (ttsEngine) return ttsEngine;
  ttsEnginePromise ??= (async () => {
    const native = await loadNative();
    const path = await native.getModelPath("tts", TTS_MODEL_ID);
    if (!path) throw new Error(t("Voice models are not downloaded yet."));
    // Same as dictation: never hand a broken model directory to the
    // native loader; the caller treats this as no voice, not a crash.
    if (!(await onDeviceSpeechModelFilesComplete("tts", path))) {
      throw new Error(t("Voice models are not downloaded yet."));
    }
    const engine = await native.createTts({
      modelPath: { type: "file", path },
      modelType: "kokoro",
    });
    ttsEngine = engine;
    return engine;
  })();
  try {
    return await ttsEnginePromise;
  } catch (error) {
    ttsEnginePromise = null;
    throw error;
  }
}

export function stopOnDeviceSpeechPlayback(): void {
  ttsPlayback?.stop();
}

/** The player for the utterance speaking now, if any. */
let ttsPlayback: OnDeviceSpeechPlayback | null = null;

/**
 * Speaks the text with the on-device voice. Resolves to whether anything
 * was spoken. `onPlayback` receives the control for the utterance playing
 * now, so a caller can pause, resume or stop it.
 */
export async function speakOnDeviceSpeech(
  text: string,
  opts: {
    onPlayback?: (playback: OnDeviceSpeechPlayback) => void;
    signal?: AbortSignal;
  } = {},
): Promise<boolean> {
  const utterances = toUtterances(text);
  if (utterances.length === 0) return false;
  if (opts.signal?.aborted) return false;
  let engine: Awaited<ReturnType<OnDeviceSpeechNative["createTts"]>>;
  try {
    engine = await loadTtsEngine();
  } catch {
    return false;
  }
  if (opts.signal?.aborted) return false;
  let spoken = false;
  for (const utterance of utterances) {
    if (opts.signal?.aborted) break;
    let audio: { samples: number[]; sampleRate: number };
    try {
      audio = await engine.generateSpeech(utterance, { sid: TTS_VOICE_SID });
    } catch {
      continue;
    }
    if (opts.signal?.aborted) break;
    if (!audio.samples.length) continue;
    try {
      const played = await playPcmWav(audio.samples, audio.sampleRate, opts);
      spoken = spoken || played;
    } catch {}
  }
  return spoken;
}

type AudioModuleShape = typeof import("expo-audio");
type FileSystemShape = typeof import("expo-file-system");

let audioModulePromise: Promise<AudioModuleShape> | null = null;
let fileSystemPromise: Promise<FileSystemShape> | null = null;

function loadAudioModule(): Promise<AudioModuleShape> {
  audioModulePromise ??= import("expo-audio");
  return audioModulePromise;
}

function loadFileSystem(): Promise<FileSystemShape> {
  fileSystemPromise ??= import("expo-file-system");
  return fileSystemPromise;
}

/**
 * Writes float PCM samples as a 16-bit WAV and plays it through the system
 * audio player. Returns whether the clip played to the end.
 */
async function playPcmWav(
  samples: number[],
  sampleRate: number,
  opts: {
    onPlayback?: (playback: OnDeviceSpeechPlayback) => void;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const [{ createAudioPlayer, setAudioModeAsync }, { File, Paths }] = await Promise.all([
    loadAudioModule(),
    loadFileSystem(),
  ]);
  await setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false });
  const file = new File(Paths.cache, `rakazo-on-device-speech-${Date.now()}.wav`);
  file.create({ overwrite: true });
  file.write(floatSamplesToWavBase64(samples, sampleRate), { encoding: "base64" });
  const player = createAudioPlayer({ uri: file.uri });
  let stopped = false;
  const playback: OnDeviceSpeechPlayback = {
    pause: () => player.pause(),
    resume: () => player.play(),
    stop: () => {
      stopped = true;
      player.pause();
    },
  };
  ttsPlayback = playback;
  opts.onPlayback?.(playback);
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (played: boolean) => {
        if (settled) return;
        settled = true;
        sub.remove();
        resolve(played);
      };
      const sub = player.addListener("playbackStatusUpdate", (status) => {
        if (status.error || status.playbackState === "failed") {
          finish(false);
          return;
        }
        if (status.didJustFinish) {
          finish(true);
          return;
        }
      });
      const abort = () => finish(false);
      opts.signal?.addEventListener("abort", abort, { once: true });
      if (stopped || opts.signal?.aborted) {
        finish(false);
        return;
      }
      try {
        player.play();
      } catch {
        finish(false);
      }
    });
  } finally {
    if (ttsPlayback === playback) ttsPlayback = null;
    player.release();
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}

/** Encodes float PCM samples in [-1, 1] as a base64 16-bit PCM WAV. */
export function floatSamplesToWavBase64(samples: number[], sampleRate: number): string {
  const count = samples.length;
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, Math.round(clamped * 32767), true);
  }
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
