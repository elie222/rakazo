import { FitImage as UntypedFitImage } from "@ronradtke/react-native-markdown-display";
import type { ComponentType } from "react";
import { useContext, useState } from "react";
import type { ImageProps } from "react-native";
import { Pressable, Text, View } from "react-native";
import { markRemoteImageLoaded, RemoteImagesContext, remoteImageRenders } from "../markdown";
import type { FenceStyles } from "./styles";

// Its declared props extend a type React Native's public API no longer exports.
export const FitImage = UntypedFitImage as ComponentType<ImageProps & { indicator?: boolean }>;

export function RemoteMarkdownImage({
  image,
  alt,
  title,
  styles,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  styles: FenceStyles;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, false)) {
    return (
      <FitImage
        indicator
        style={styles.image}
        source={{ uri: image.href }}
        accessible={Boolean(alt)}
        accessibilityLabel={alt}
      />
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={alt ? `${alt}, ${image.host}` : image.host}
      accessibilityHint={title}
      // A 32pt chip with 6pt slop on each side keeps the 44pt touch target.
      hitSlop={6}
      onPress={(event) => {
        event.preventDefault();
        event.stopPropagation();
        markRemoteImageLoaded(image.href);
        setRevision((revision) => revision + 1);
      }}
      style={styles.image_placeholder}
    >
      <View style={styles.image_placeholder_icon} />
      {alt ? (
        <Text numberOfLines={1} style={styles.image_placeholder_alt}>
          {alt}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={styles.image_placeholder_host}>
        {image.host}
      </Text>
    </Pressable>
  );
}
