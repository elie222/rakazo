import { withSandboxedArtifactCsp } from "@rakazo/core";
import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

/**
 * Renders bot-authored HTML in a WebView that cannot reach the app's session:
 * a fresh `source.html` load has no cookies/local storage from the rest of
 * the app, `domStorageEnabled`/file access/shared cookies are explicitly off,
 * and `onShouldStartLoadWithRequest` allows only the very first navigation
 * (the initial load) and blocks anything the content tries to navigate to
 * afterward. The CSP meta tag (the same policy as the web viewer) is a
 * second layer on top, blocking outbound network requests from a script.
 */
export function SandboxedHtmlPreview({ html }: { html: string }) {
  const allowedFirstLoad = useRef(false);

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
        onShouldStartLoadWithRequest={() => {
          if (!allowedFirstLoad.current) {
            allowedFirstLoad.current = true;
            return true;
          }
          return false;
        }}
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
