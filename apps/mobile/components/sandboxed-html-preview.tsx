import { withSandboxedArtifactCsp } from "@rakazo/core";
import { useRef } from "react";
import { StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";

function isPreviewDocument(url: string): boolean {
  return url === "about:blank" || url === "about:blank/";
}

/** The MCP app shell's own frame loads its app as srcdoc; nothing else may navigate. */
function isAppShellDocument(url: string): boolean {
  return isPreviewDocument(url) || url === "about:srcdoc";
}

// The document's own `postMessage` calls reach the app only through the WebView bridge.
const FORWARD_WINDOW_MESSAGES = `window.addEventListener("message", function (event) {
  if (event.source !== window) return;
  try { window.ReactNativeWebView.postMessage(JSON.stringify(event.data)); } catch (_) {}
});
true;`;

/**
 * Renders bot-authored HTML in a WebView that cannot reach the app's session:
 * a fresh `source.html` load has no cookies/local storage from the rest of
 * the app, `domStorageEnabled`/file access/shared cookies are explicitly off,
 * and navigation is limited to the preview document itself. The CSP meta tag
 * (the same policy as the web viewer) blocks outbound network requests.
 */
export function SandboxedHtmlPreview({
  html,
  background = "white",
  scrollEnabled,
  onMessage,
  appShell = false,
}: {
  html: string;
  /**
   * `html` is the MCP app shell (`mcpAppShellDocument`): it carries its own policy, runs its app
   * one sandboxed frame down, and talks to the app itself, so no window forwarding is added.
   */
  appShell?: boolean;
  /** Pages paint their own themed background; plain HTML is written for a white page. */
  background?: string;
  scrollEnabled?: boolean;
  /** A message the document posted; `answer` posts a reply back into the document. */
  onMessage?: (data: string, answer: (message: object) => void) => void;
}) {
  const view = useRef<WebView>(null);
  // JSON is a valid script literal for any message, so nothing in it can break out of the call.
  const answer = (message: object) =>
    view.current?.injectJavaScript(`window.postMessage(${JSON.stringify(message)}, "*");true;`);
  return (
    <View style={styles.container}>
      <WebView
        ref={view}
        source={{ html: appShell ? html : withSandboxedArtifactCsp(html), baseUrl: "about:blank" }}
        style={[styles.webview, { backgroundColor: background }]}
        scrollEnabled={scrollEnabled}
        injectedJavaScriptBeforeContentLoaded={
          onMessage && !appShell ? FORWARD_WINDOW_MESSAGES : undefined
        }
        onMessage={(event) => onMessage?.(event.nativeEvent.data, answer)}
        javaScriptEnabled
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        // A long-pressed link's preview would load it outside the navigation check below.
        allowsLinkPreview={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        mixedContentMode="never"
        cacheEnabled={false}
        // Every request reaches the check below, which allows only the shell and its srcdoc frame.
        // A URL failing the library's own origin list would be handed to the system instead.
        originWhitelist={appShell ? ["*"] : undefined}
        onShouldStartLoadWithRequest={({ url }) =>
          appShell ? isAppShellDocument(url) : isPreviewDocument(url)
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // The default is not a theme color: HTML written for a white page leaves its own text dark,
  // so the canvas has to be white in dark mode too.
  webview: { flex: 1 },
});
