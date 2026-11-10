const posthogKey = import.meta.env.PUBLIC_POSTHOG_KEY?.trim();

if (posthogKey) {
  void import("posthog-js").then(({ default: posthog }) => {
    posthog.init(posthogKey, {
      api_host: import.meta.env.PUBLIC_POSTHOG_HOST?.trim() || "https://us.i.posthog.com",
      ui_host: "https://us.posthog.com",
      capture_pageview: "history_change",
      defaults: "2026-06-25",
      person_profiles: "identified_only",
    });
  });
}

export function capture(event: string) {
  if (!posthogKey) return;
  void import("posthog-js").then(({ default: posthog }) => posthog.capture(event));
}
