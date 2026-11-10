export const BRAND_KIT_PATH = "/brand/";
export const WORDMARK_SVG_PATH = "/brand/kit/rakazo-wordmark.svg";

export const BRAND_LOGOS = [
  {
    name: "Logo",
    file: "/brand/kit/rakazo-logo.png",
    preview: "/brand/kit/rakazo-logo-preview.webp",
    format: "PNG · 1712 × 576",
  },
  {
    name: "Wordmark",
    file: WORDMARK_SVG_PATH,
    preview: WORDMARK_SVG_PATH,
    format: "SVG",
  },
  {
    name: "App icon",
    file: "/brand/kit/rakazo-icon.png",
    preview: "/brand/kit/rakazo-icon-preview.webp",
    format: "PNG · 1024 × 1024",
  },
  {
    name: "Mascot",
    file: "/brand/kit/rakazo-mascot.png",
    preview: "/brand/kit/rakazo-mascot-preview.webp",
    format: "PNG · 700 × 700",
  },
] as const;

export const BRAND_COLORS = [
  { name: "Orange", hex: "#F97D16" },
  { name: "Black", hex: "#141414" },
  { name: "White", hex: "#FFFFFF" },
] as const;
