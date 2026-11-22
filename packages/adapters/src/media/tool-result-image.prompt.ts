/** A read_file or web_fetch target that is a picture, when the run's model takes text only. */
export const IMAGE_MODEL_CANNOT_SEE =
  "This is an image, and this bot's model cannot see images. Pick a vision-capable model to look at it.";

/** Bytes that start like a picture but do not decode as one. */
export const IMAGE_UNREADABLE = "This image is corrupt or in a format that cannot be read.";
