/// <reference types="vite/client" />

import type { ReactNode } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      amount: { children?: ReactNode };
      unit: { children?: ReactNode };
      time: { children?: ReactNode };
    }
  }
}

interface ImportMetaEnv {
  readonly VITE_DEFAULT_UI_LOCALE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
