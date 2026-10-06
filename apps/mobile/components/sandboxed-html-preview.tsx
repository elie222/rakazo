import { withSandboxedArtifactCsp } from "@rakazo/core";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

/**
 * Renders bot-authored HTML in a WebView that cannot reach the app's session:
 * a fresh `source.html` load has no cookies/local storage from the rest of
 * the app, `domStorageEnabled`/file access/shared cookies are explicitly off,
 * and navigation is limited to the preview document itself. The CSP meta tag
 * (the same policy as the web viewer) blocks outbound network requests.
 */
function isPreviewDocument(url: string): boolean {
  return url === "about:blank" || url === "about:blank/";
}

export function SandboxedHtmlPreview({ html }: { html: string }) {
  return (
    <View style={styles.container}>
      <WebView
        source={{ html: withSandboxedArtifactCsp(html), baseUrl: "about:blank" }}
        style={styles.webview}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        mixedContentMode="never"
        cacheEnabled={false}
        onShouldStartLoadWithRequest={({ url }) => isPreviewDocument(url)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // Not a theme color: HTML written for a white page leaves its own text dark,
  // so the canvas has to be white in dark mode too.
  webview: { flex: 1, backgroundColor: "white" },
});
