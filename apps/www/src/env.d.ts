/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_CRISP_WEBSITE_ID?: string;
  readonly PUBLIC_POSTHOG_HOST?: string;
  readonly PUBLIC_POSTHOG_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
