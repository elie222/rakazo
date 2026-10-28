import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { TextInput } from "react-native";

/**
 * Closes a sheet that holds protected fields without iOS offering to save them. iOS offers to save
 * a password when a sheet goes away while a username or password field still holds text, so
 * closing empties and locks the fields first. The native commands run in order, so the field being
 * edited ends editing only after every field is empty and reports its text; the sheet closes a
 * frame after that report, or after a delay if no field was edited.
 */
export function useSecretSheetClose(
  /** The protected fields, in order; a sheet with fields added or removed keeps this current. */
  inputs: RefObject<readonly (TextInput | null | undefined)[]>,
  clear: () => void,
  onClose: () => void,
) {
  const [closing, setClosing] = useState(false);
  const closeState = useRef<"open" | "closing" | "closed">("open");

  function close() {
    if (closeState.current !== "open") return;
    closeState.current = "closing";
    clear();
    setClosing(true);
    for (const input of inputs.current) input?.clear();
    for (const input of inputs.current) input?.blur();
  }

  function finishClosing() {
    if (closeState.current !== "closing") return;
    closeState.current = "closed";
    requestAnimationFrame(() => onClose());
  }

  function endEditing(text: string) {
    if (text === "") finishClosing();
  }

  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(finishClosing, 500);
    return () => clearTimeout(timer);
  }, [closing]);

  return { close, closing, endEditing };
}
