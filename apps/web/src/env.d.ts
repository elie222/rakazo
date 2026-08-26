interface ImportMetaEnv {
  readonly VITE_DEFAULT_UI_LOCALE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type RakazoRuntimeConfig = {
  readonly defaultUiLocale?: string;
};

var __RAKAZO_RUNTIME_CONFIG__: RakazoRuntimeConfig | undefined;
