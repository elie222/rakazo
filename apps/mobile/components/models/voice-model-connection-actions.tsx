import { useLingui } from "@lingui/react/macro";
import type { VoiceCatalogEntry } from "@rakazo/contracts";
import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import {
  closeModelConnection,
  openModelConnection,
} from "../../lib/models/model-connection-request";
import type { SettingsTarget } from "../../lib/query/settings-target";
import { NativeActionButton } from "../native/native-action-button";

export function VoiceModelConnectionActions({
  provider,
  target,
  choices,
  signInLabel,
  linked,
  disabled,
  onChoose,
  onSignedIn,
}: {
  provider: string;
  target: SettingsTarget;
  choices: NonNullable<VoiceCatalogEntry["modelConnections"]>;
  signInLabel?: string;
  linked: boolean;
  disabled: boolean;
  onChoose: (credentialId: string) => Promise<boolean>;
  onSignedIn: (credentialId: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const router = useRouter();
  const signInRequest = useRef<string | null>(null);
  const closeRequest = useCallback(() => {
    if (signInRequest.current) closeModelConnection(signInRequest.current);
    signInRequest.current = null;
  }, []);

  useEffect(() => closeRequest, [closeRequest]);
  useFocusEffect(closeRequest);

  function signIn() {
    // A second tap while the screen opens must not replace its request.
    if (signInRequest.current) return;
    const requestId = openModelConnection({
      provider,
      credentialId: null,
      makeDefault: false,
      target,
      onSaved: (credentialId) => void onSignedIn(credentialId),
    });
    signInRequest.current = requestId;
    router.push({ pathname: "/model-connection", params: { requestId } });
  }

  if (signInLabel) {
    return <NativeActionButton disabled={disabled} label={signInLabel} onPress={signIn} />;
  }
  return choices.map(({ id, label }) => (
    <NativeActionButton
      key={id}
      disabled={disabled}
      prominence={choices.length === 1 && !linked ? "primary" : "secondary"}
      label={t`Use ${label}`}
      onPress={() => void onChoose(id)}
    />
  ));
}
