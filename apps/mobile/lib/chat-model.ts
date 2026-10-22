import type { ChatModelChoice } from "@rakazo/core";
import { chatModelChoices, connectedModelChoices } from "@rakazo/core";
import type { MobileMe, MobileModel, MobileModelCredential } from "./api";

/** What a chat's model picker lists, with the space default named after its model. */
export function chatModelPickerChoices(
  me: MobileMe | null,
  catalog: MobileModel[],
  credentials: MobileModelCredential[],
  selectedKey: string,
  t: (message: string) => string,
): ChatModelChoice[] {
  const spaceDefaultLabel = me?.defaultModel
    ? `${t("Space default")} (${catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel})`
    : t("Space default");
  const choices = chatModelChoices(
    connectedModelChoices(credentials, catalog),
    selectedKey,
    spaceDefaultLabel,
  );
  choices[0] = {
    key: "",
    label: spaceDefaultLabel,
    title: t("Space default"),
    detail: me?.defaultModel
      ? (catalogLabel(catalog, me.defaultProvider, me.defaultModel) ?? me.defaultModel)
      : undefined,
  };
  return choices;
}

function catalogLabel(
  catalog: MobileModel[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId)?.label;
}
