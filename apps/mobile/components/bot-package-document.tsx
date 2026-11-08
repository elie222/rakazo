import type { BotPackageDocument, BotPackageLeftOut } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

function Details({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <NativeActionButton
        label={label}
        selected={open}
        prominence="quiet"
        onPress={() => setOpen(!open)}
      />
      {open ? children : null}
    </View>
  );
}

export function BotPackageLeftOutList({ items }: { items: BotPackageLeftOut[] }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return (
    <View style={styles.section} testID="bot-package-left-out">
      <Text style={styles.heading}>{t("Not imported")}</Text>
      {items.map((item, index) => (
        <View key={`${item.kind}:${index}`}>
          <Text selectable style={styles.text}>
            {item.name}
          </Text>
          <Text selectable style={styles.secondary}>
            {item.reason}
          </Text>
        </View>
      ))}
    </View>
  );
}

export function BotPackageDocumentView({ document }: { document: BotPackageDocument }) {
  const { t } = useI18n();
  return (
    <View style={styles.section} testID="bot-package-document">
      <Text selectable style={styles.heading}>
        {document.profile.name}
      </Text>
      {document.profile.title ? (
        <Text selectable style={styles.text}>
          {document.profile.title}
        </Text>
      ) : null}
      {document.profile.description ? (
        <Text selectable style={styles.secondary}>
          {document.profile.description}
        </Text>
      ) : null}
      <Details label={t("Instructions")}>
        <Text selectable style={styles.raw}>
          {document.profile.instructions}
        </Text>
      </Details>
      <Details label={`${t("Skills")} · ${document.skills.length}`}>
        {document.skills.map((skill, index) => (
          <Details key={`${skill.name}:${index}`} label={skill.name}>
            <Text selectable style={styles.raw}>
              {skill.content}
            </Text>
          </Details>
        ))}
      </Details>
      <Details label={`${t("Routines")} · ${document.routines.length}`}>
        {document.routines.map((routine, index) => (
          <Details key={`${routine.name}:${index}`} label={routine.name}>
            <Text selectable style={styles.secondary}>
              {routine.crons.join("; ")} · {routine.timezone}
            </Text>
            <Text selectable style={styles.raw}>
              {routine.prompt}
            </Text>
          </Details>
        ))}
      </Details>
      <Details label={`${t("Connections")} · ${document.connections.length}`}>
        {document.connections.map((connection, index) => (
          <View key={`${connection.name}:${index}`}>
            <Text selectable style={styles.text}>
              {connection.name}
            </Text>
            <Text selectable style={styles.secondary}>
              {connection.note}
            </Text>
          </View>
        ))}
      </Details>
      {document.memory.length ? (
        <Details label={`${t("Memory")} · ${document.memory.length}`}>
          {document.memory.map((entry) => (
            <Details key={entry.path} label={entry.path}>
              <Text selectable style={styles.raw}>
                {entry.content}
              </Text>
            </Details>
          ))}
        </Details>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { fontSize: 16, fontWeight: "600", color: native.label },
  text: { fontSize: 14, color: native.label },
  secondary: { fontSize: 14, color: native.secondaryLabel },
  raw: {
    fontSize: 13,
    color: native.label,
    backgroundColor: native.fill,
    padding: 12,
    borderRadius: 10,
  },
});
