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
import { BotAvatar } from "../components/bot-avatar";
import { BotLookPicker } from "../components/bot-look-picker";
import { NativeActionButton } from "../components/native-action-button";
import { cancelHeaderOptions } from "../components/sheet-header";
import { rpc } from "../lib/api";
import { askForModelBeforeFirstBot, createInboxBot } from "../lib/create-inbox-bot";
import { openChatFromInbox } from "../lib/inbox-changes";
import { native, useMobileTokens } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

/** Names a new bot and picks its look before creating it, as web's New bot dialog does. */
export default function NewBot() {
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const params = useLocalSearchParams<{ spaceId?: string; avatarSet?: BotAvatarSet }>();
  // The account's set: the server gives it to the new bot, so the preview draws it too. Home's
  // copy can predate a change in Account settings, so the current one replaces it.
  const [avatarSet, setAvatarSet] = useState(() => resolveBotAvatarSet(params.avatarSet));
  const [name, setName] = useState("");
  const [look, setLook] = useState(newBotLook);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const creating = useRef(false);
  // Once the screen is gone, a creation still in flight must not open the chat.
  const gone = useRef(false);
  // Create waits for the check made as the screen opened, so the model prompt shows once.
  const modelCheck = useRef<Promise<boolean>>(Promise.resolve(false));
  const trimmed = name.trim();
  const identity = newBotPreviewIdentity(avatarSet, look);

  useEffect(() => {
    gone.current = false;
    void rpc("me")
      .then((me) => {
        if (gone.current) return;
        const set = resolveBotAvatarSet(me.botAvatarSet);
        setAvatarSet(set);
        // The logo has no studio shapes; drop one picked while the Original set was shown.
        if (set === "rakazo")
          setLook((current) => ({ ...current, color: botLookState(current.color).color }));
      })
      .catch(() => undefined);
    // A first bot needs a model; ask before the form is filled in rather than after.
    modelCheck.current = askForModelBeforeFirstBot(params.spaceId, () => !gone.current);
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

  async function create() {
    if (!trimmed || creating.current) return;
    creating.current = true;
    setPending(true);
    setError(null);
    try {
      // That check is asking for a model and closing the screen.
      if (await modelCheck.current) return;
      const outcome = await createInboxBot({
        input: { name: trimmed, ...newBotLookInput(avatarSet, look) },
        openChat: (href) => {
          if (gone.current) return;
          router.dismiss();
          if (!openChatFromInbox(href)) router.push(href);
        },
        spaceId: params.spaceId,
      });
      // A model is needed first, or the account or space changed: nothing is left to do here.
      if (outcome !== "created" && !gone.current) router.back();
    } catch (err) {
      setError(errorText(err, t`Could not create bot`));
    } finally {
      creating.current = false;
      setPending(false);
    }
  }

  return (
    <>
      <Stack.Screen
        options={{
          ...cancelHeaderOptions(t`Cancel`, () => {
            if (!creating.current) router.back();
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
          onSubmitEditing={() => void create()}
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
          onPress={() => void create()}
          style={{ marginTop: 28, borderRadius: 28 }}
        />
      </ScrollView>
    </>
  );
}
