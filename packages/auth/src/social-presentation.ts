import type { SignInProvider } from "@rakazo/contracts";

/** Provider-owned brand assets; clients only render neutral vector data. */
export function socialPresentation(id: string): SignInProvider["presentation"] {
  if (id === "google")
    return {
      variant: "outline",
      mark: {
        viewBox: "0 0 48 48",
        paths: [
          {
            d: "M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z",
          },
        ],
      },
    };
  if (id === "apple")
    return {
      variant: "solid",
      mark: {
        viewBox: "0 0 24 24",
        paths: [
          {
            d: "M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z",
          },
        ],
      },
    };
  return undefined;
}
