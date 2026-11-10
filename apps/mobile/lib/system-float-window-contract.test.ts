import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const moduleRoot = resolve(mobileRoot, "modules/rakazo-system-float");
const nativeRoot = resolve(moduleRoot, "android/src/main");

function read(relative: string): string {
  return readFileSync(resolve(nativeRoot, relative), "utf8");
}

describe("system float window native contract", () => {
  it("declares the overlay permission, the foreground-service permission and the service", () => {
    const manifest = read("AndroidManifest.xml");
    expect(manifest).toContain("android.permission.SYSTEM_ALERT_WINDOW");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE");
    expect(manifest).toContain("android.permission.FOREGROUND_SERVICE_SPECIAL_USE");
    expect(manifest).toContain("RakazoSystemFloatService");
    expect(manifest).toContain('android:foregroundServiceType="specialUse"');
    expect(manifest).toContain("android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE");
  });

  it("exposes the window through the RakazoSystemFloat module", () => {
    const module = read("java/com/rakazo/systemfloat/RakazoSystemFloatModule.kt");
    expect(module).toContain('Name("RakazoSystemFloat")');
    expect(module).toContain('AsyncFunction("isSupported")');
    expect(module).toContain('AsyncFunction("hasOverlayPermission")');
    expect(module).toContain("appContext.reactContext ?: return@AsyncFunction false");
    expect(module).toContain("Settings.canDrawOverlays(context)");
    expect(module).toContain('AsyncFunction("show")');
    expect(module).toContain("RakazoSystemFloatService.ACTION_SHOW");
    expect(module).toContain('AsyncFunction("updateUrl")');
    expect(module).toContain('AsyncFunction("hide")');
    expect(module).toContain('AsyncFunction("isShowing")');
    expect(module).toContain("startForegroundService");
  });

  it("hosts the live screen in a WindowManager overlay kept alive by a foreground service", () => {
    const service = read("java/com/rakazo/systemfloat/RakazoSystemFloatService.kt");
    expect(service).toContain("TYPE_APPLICATION_OVERLAY");
    expect(service).toContain("WebView");
    expect(service).toContain("javaScriptEnabled = true");
    expect(service).toContain("domStorageEnabled = true");
    expect(service).toContain("FOREGROUND_SERVICE_TYPE_SPECIAL_USE");
    expect(service).toContain("startForeground(");
    expect(service).toContain("FLAG_NOT_TOUCH_MODAL");
    expect(service).toContain("updateViewLayout");
    expect(service).toContain("windowManager?.removeView");
    expect(service).toContain("webView?.destroy()");
    // A rotated capability re-points the window instead of reopening it.
    expect(service).toContain("if (url == currentUrl) return");
    // Closing the window from its own title bar stops the service.
    expect(service).toContain("setOnClickListener { stopSelf() }");
  });

  it("hides the phone-operation buttons in the small window and shows them once expanded", () => {
    const service = read("java/com/rakazo/systemfloat/RakazoSystemFloatService.kt");
    // The popup takes control when it opens, but the small floating window
    // is just for watching: the keyboard and return-to-app buttons appear
    // only once the window is maximized, while expand and close always stay.
    expect(service).toContain("private fun updateOperationButtons()");
    expect(service).toContain("if (isMaximized) View.VISIBLE else View.GONE");
    expect(service).toContain("keyboardButton?.visibility = visibility");
    expect(service).toContain("openButton?.visibility = visibility");
    // Expanding the window shows the buttons again; restoring hides them.
    expect(service).toContain("updateOperationButtons()\n    manager.updateViewLayout");
  });

  it("ships the notification strings for every supported locale", () => {
    const locales = ["", "de", "es", "ja", "nl", "pl", "ru", "zh-rCN", "zh-rTW"];
    for (const locale of locales) {
      const dir = locale === "" ? "values" : `values-${locale}`;
      const path = resolve(nativeRoot, "res", dir, "strings.xml");
      expect(existsSync(path)).toBe(true);
      const strings = readFileSync(path, "utf8");
      for (const key of [
        "rakazo_system_float_title",
        "rakazo_system_float_text",
        "rakazo_system_float_channel",
      ]) {
        expect(strings).toContain(`name="${key}"`);
      }
    }
    expect(readdirSync(resolve(nativeRoot, "res", "drawable"))).toEqual(
      expect.arrayContaining([
        "ic_rakazo_system_float.xml",
        "ic_rakazo_system_float_close.xml",
        "ic_rakazo_system_float_open.xml",
        "ic_rakazo_system_float_resize.xml",
      ]),
    );
  });
});
