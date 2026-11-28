import { t } from "@lingui/core/macro";
import type { AppIcon } from "@rakazo/contracts";

export function appIconLabel(icon: AppIcon): string {
  switch (icon) {
    case "default":
      return t`Original`;
    case "sunglasses":
      return t`Sunglasses`;
    case "headphones":
      return t`Headphones`;
    case "beanie":
      return t`Beanie`;
    case "cap":
      return t`Cap`;
    case "tie":
      return t`Tie`;
    case "bow-tie":
      return t`Bow tie`;
    case "scarf":
      return t`Scarf`;
    case "flower":
      return t`Flower`;
    case "sprout":
      return t`Sprout`;
    case "feet":
      return t`Feet`;
  }
}
