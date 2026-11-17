import { useLingui } from "@lingui/react/macro";
import {
  defaultGroupName,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
  GROUP_NAME_MAX_LENGTH,
} from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Stack, useNavigation, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useContext, useEffect, useMemo, useState } from "react";
import { BackHandler, Platform, ScrollView, Text, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { BotChipPicker } from "../components/bot-chip-picker";
import { GlassIconButton } from "../components/glass-icon-button";
import { GroupAvatar } from "../components/group-avatar";
import { NativeActionButton } from "../components/native-action-button";
import { SheetCloseButton } from "../components/sheet-close-button";
import { CallKeyboardContext } from "../lib/call-keyboard-context";
import { hapticSuccess } from "../lib/haptics";
import type { MobileBot } from "../lib/mobile-types";
import { native, useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { formRead, queryClient, rpcQuery, useSave } from "../lib/query";
import { addToSearchInbox, isSearchInboxSession, searchInboxSession } from "../lib/search-inbox";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function NewGroup() {
  const call = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const router = useRouter();
  const navigation = useNavigation();
  const headerHeight = useHeaderHeight();
  // Read as the sheet opens and never again: the picks are made from this list, and a copy an
  // earlier visit left is not it.
  const botsRead = useQuery(formRead(rpcQuery("bots/list")), queryClient);
  const listed = botsRead.isFetchedAfterMount ? botsRead.data : undefined;
  const bots = useMemo<MobileBot[]>(
    () => (listed ?? []).filter((bot) => !bot.archivedAt),
    [listed],
  );
  const [step, setStep] = useState<"bots" | "name">("bots");
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const valid = selected.length >= GROUP_MEMBER_MIN && selected.length <= GROUP_MEMBER_MAX;
  const picked = selected.flatMap((id) => bots.find((bot) => bot.id === id) ?? []);
  const creation = useSave({
    save: async (
      ask: { name: string; botIds: string[]; askedIn: ReturnType<typeof searchInboxSession> },
      send,
    ) => {
      const group = await send("groups/create", { name: ask.name, botIds: ask.botIds });
      if (navigation.isFocused() && isSearchInboxSession(ask.askedIn)) hapticSuccess();
      // The group exists by now, so it is opened even when this sheet has been closed meanwhile.
      addToSearchInbox({ kind: "group", group }, ask.askedIn);
      router.replace({
        pathname: "/group-thread",
        params: { groupId: group.id, name: group.name },
      });
    },
    closesScreen: true,
  });
  const pending = creation.pending;
  const error = creation.error ? errorText(creation.error, t`Could not create group`) : null;
  const goBack = () => {
    if (!pending) setStep("bots");
  };
  function close() {
    if (router.canDismiss()) router.dismiss();
    else if (router.canGoBack()) router.back();
    else router.replace("/");
  }
  useEffect(() => {
    if (step !== "name") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!pending) setStep("bots");
      return true;
    });
    return () => subscription.remove();
  }, [step, pending]);

  function create() {
    if (!valid) return;
    creation.run({
      name: name.trim() || defaultGroupName(picked.map((bot) => bot.name)),
      botIds: selected,
      askedIn: searchInboxSession(),
    });
  }
  return (
    <>
      <Stack.Screen
        options={{
          title: t`New group chat`,
          headerTransparent: true,
          headerStyle: { backgroundColor: "transparent" },
          headerBackVisible: false,
          headerLeft: () =>
            step === "bots" ? (
              <SheetCloseButton onPress={close} />
            ) : (
              <GlassIconButton
                accessibilityLabel={t`Back`}
                ios="chevron.left"
                android="chevron-back"
                onPress={goBack}
              />
            ),
          headerRight: () =>
            step === "bots" ? (
              <NativeActionButton
                label={t`Next`}
                disabled={!valid}
                size="compact"
                onPress={() => setStep("name")}
                style={{ borderRadius: 24 }}
              />
            ) : null,
          ...(iosAtLeast(26)
            ? {
                unstable_headerLeftItems: () => [
                  {
                    type: "button" as const,
                    label: step === "bots" ? t`Close` : t`Back`,
                    icon: {
                      type: "sfSymbol" as const,
                      name: step === "bots" ? "xmark" : "chevron.left",
                    },
                    onPress: step === "bots" ? close : goBack,
                    disabled: pending,
                  },
                ],
                unstable_headerRightItems: () =>
                  step === "bots"
                    ? [
                        {
                          type: "button" as const,
                          label: t`Next`,
                          icon: { type: "sfSymbol" as const, name: "chevron.right" },
                          variant: "prominent" as const,
                          tintColor: tokens.primary,
                          disabled: !valid,
                          onPress: () => setStep("name"),
                        },
                      ]
                    : [],
              }
            : {}),
        }}
      />
      {/* Shrinks above the keyboard so Skip/Create and the last bot rows stay reachable. */}
      <KeyboardAvoidingView
        enabled={!call}
        behavior="padding"
        automaticOffset
        style={{ flex: 1, backgroundColor: tokens.background }}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          style={[{ flex: 1 }, sideInsets]}
          contentContainerStyle={{
            padding: 24,
            paddingTop: Platform.OS === "ios" ? 24 : headerHeight + 24,
          }}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
        >
          {step === "bots" ? (
            <BotChipPicker bots={bots} selected={selected} onChange={setSelected} />
          ) : (
            <View key="name">
              <View style={{ alignItems: "center", marginTop: 24, marginBottom: 32 }}>
                <GroupAvatar
                  size={120}
                  members={picked
                    .slice(0, 3)
                    .map((bot) => ({ botId: bot.id, color: bot.color, avatarSet: bot.avatarSet }))}
                />
              </View>
              <TextInput
                autoFocus
                value={name}
                onChangeText={setName}
                maxLength={GROUP_NAME_MAX_LENGTH}
                autoCapitalize="words"
                autoCorrect={false}
                autoComplete="off"
                textContentType="none"
                editable={!pending}
                placeholder={t`Ex: Project Falcon`}
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
              <NativeActionButton
                fill
                label={pending ? t`Creating…` : name.trim() ? t`Create` : t`Skip`}
                prominence={name.trim() ? "primary" : "secondary"}
                disabled={pending}
                onPress={create}
                style={{ marginTop: 24, borderRadius: 28 }}
              />
              {error ? (
                <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text>
              ) : null}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
