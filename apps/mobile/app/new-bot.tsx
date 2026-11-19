import { useLingui } from "@lingui/react/macro";
import type { BotAvatarSet } from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH, resolveBotAvatarSet } from "@rakazo/contracts";
import {
  botLookState,
  newBotLook,
  newBotLookInput,
  newBotPreviewIdentity,
  ORGANIC_PREVIEW_IDENTITIES,
} from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { BackHandler, ScrollView, Text, TextInput, View } from "react-native";
import { BotAvatar } from "../components/bots/bot-avatar";
import { BotLookPicker } from "../components/bots/bot-look-picker";
import { NativeActionButton } from "../components/native/native-action-button";
import { cancelHeaderOptions } from "../components/native/sheet-header";
import { selectedSpaceId } from "../lib/api/api";
import { errorText } from "../lib/api/user-error";
import type { InboxBotOutcome } from "../lib/inbox/create-inbox-bot";
import { askForModelBeforeFirstBot, createInboxBot } from "../lib/inbox/create-inbox-bot";
import { openChatFromInbox } from "../lib/inbox/inbox-changes";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useMobileTokens } from "../lib/native/native";
import { accountRpcQuery, useSave } from "../lib/query/query";
import { useScreenQuery } from "../lib/query/screen-query";

type NewBotInput = Parameters<typeof createInboxBot>[0]["input"];

/** Names a new bot and picks its look before creating it, as web's New bot dialog does. */
export default function NewBot() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const params = useLocalSearchParams<{ spaceId?: string; avatarSet?: BotAvatarSet }>();
  // The account's set: the server gives it to the new bot, so the preview draws it too. Home's
  // copy can predate a change in Account settings, so the current one replaces it.
  const meRead = useScreenQuery(accountRpcQuery("me"));
  const currentSet = meRead.data ? resolveBotAvatarSet(meRead.data.botAvatarSet) : undefined;
  const avatarSet = currentSet ?? resolveBotAvatarSet(params.avatarSet);
  const [name, setName] = useState("");
  const [look, setLook] = useState(newBotLook);
  // Once the screen is gone, a creation still in flight must not open the chat.
  const gone = useRef(false);
  // Set with the Create tap: the header's Cancel can still be the one rendered before it.
  const started = useRef(false);
  // Create waits for the check made as the screen opened, so the model prompt shows once.
  const modelCheck = useRef<Promise<boolean>>(Promise.resolve(false));
  const trimmed = name.trim();
  const identity = newBotPreviewIdentity(avatarSet, look);
  // The Space the bot is created in, kept from the Create tap so a later switch leaves it shown.
  const tappedIn = useRef<string | undefined>(undefined);
  const createdIn = tappedIn.current ?? params.spaceId ?? selectedSpaceId() ?? undefined;
  const creation = useSave({
    // The bot's onboarding and focus prompt still reach its Space after another is selected.
    target: createdIn ? { scope: "space", spaceId: createdIn } : undefined,
    save: async (input: NewBotInput, send): Promise<InboxBotOutcome | "asked"> => {
      let outcome: InboxBotOutcome | "asked" | undefined;
      try {
        // That check is asking for a model and closing the screen.
        outcome = (await modelCheck.current)
          ? "asked"
          : await createInboxBot({
              input,
              openChat: (href) => {
                if (gone.current) return;
                router.dismiss();
                if (!openChatFromInbox(href)) router.push(href);
              },
              send,
              // The chat opens in the Space the bot was written to.
              spaceId: createdIn,
            });
        return outcome;
      } finally {
        // Cleared here, not in onFailed, which a save no longer shown skips.
        if (outcome !== "created") started.current = false;
        // A failed create is tried again in the Space selected then.
        if (outcome === undefined) tappedIn.current = undefined;
      }
    },
    // A model is needed first, or the account or space changed: nothing is left to do here.
    onSaved: (outcome) => {
      if (outcome === "needsModel" || outcome === "stale") router.back();
    },
    closesScreen: true,
  });
  const pending = creation.pending;
  const error = creation.error ? errorText(creation.error, t`Could not create bot`) : null;

  // The logo has no studio shapes; drop one picked while the Original set was shown.
  useEffect(() => {
    if (currentSet === "rakazo")
      setLook((current) => ({ ...current, color: botLookState(current.color).color }));
  }, [currentSet]);

  useEffect(() => {
    gone.current = false;
    // A first bot needs a model; ask before the form is filled in rather than after.
    // The same Space Create would ask about, so both open the same model settings.
    modelCheck.current = askForModelBeforeFirstBot(
      params.spaceId ?? selectedSpaceId() ?? undefined,
      () => !gone.current,
    );
    void modelCheck.current.then((asked) => {
      if (asked && !gone.current) router.back();
    });
    return () => {
      gone.current = true;
    };
  }, [params.spaceId, router]);

  // Android's Back would close the screen mid-create, like the Cancel it replaces.
  useEffect(() => {
    if (!pending) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => subscription.remove();
  }, [pending]);

  function create() {
    if (!trimmed) return;
    started.current = true;
    tappedIn.current = createdIn;
    creation.run({ name: trimmed, ...newBotLookInput(avatarSet, look) });
  }

  return (
    <>
      <Stack.Screen
        options={{
          ...cancelHeaderOptions(t`Cancel`, () => {
            if (!started.current) router.back();
          }),
          gestureEnabled: !pending,
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ alignItems: "center", marginTop: 8, marginBottom: 24 }}>
          <BotAvatar color={look.color} identity={identity} avatarSet={avatarSet} size={96} />
        </View>
        <TextInput
          autoFocus
          accessibilityLabel={t`Name`}
          value={name}
          onChangeText={setName}
          maxLength={BOT_NAME_MAX_LENGTH}
          autoCapitalize="words"
          autoCorrect={false}
          editable={!pending}
          placeholder={t`Name your Bot`}
          placeholderTextColor={tokens.mutedForeground}
          returnKeyType="done"
          onSubmitEditing={create}
          style={{
            height: 56,
            borderRadius: 11,
            backgroundColor: native.fill,
            color: tokens.foreground,
            fontSize: 22,
            fontWeight: "600",
            textAlign: "center",
            paddingHorizontal: 14,
          }}
        />
        <View style={{ marginTop: 24 }}>
          <BotLookPicker
            value={look.color}
            identity={identity}
            organicIdentities={ORGANIC_PREVIEW_IDENTITIES}
            avatarSet={avatarSet}
            disabled={pending}
            onChange={(color, picked) => {
              setLook((current) => ({ ...current, color, identity: picked ?? current.identity }));
            }}
          />
        </View>
        {error ? <Text style={{ color: tokens.destructive, marginTop: 16 }}>{error}</Text> : null}
        <NativeActionButton
          fill
          label={pending ? t`Creating…` : t`Create`}
          disabled={!trimmed || pending}
          onPress={create}
          style={{ marginTop: 28, borderRadius: 28 }}
        />
      </ScrollView>
    </>
  );
}
