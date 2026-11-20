import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import MeetingsScreen from "../../app/meetings";

type Meetings = {
  enabled: boolean;
  meetings: {
    id: string;
    platform: string;
    status: string;
    transcriptAvailable: boolean;
    createdAt: string;
  }[];
};

const mocks = vi.hoisted(() => ({
  botId: "bot-1",
  list: {
    data: undefined as Meetings | undefined,
    error: null as Error | null,
    isFetching: false,
    refetch: vi.fn(),
  },
  calendar: { isFetching: false, refetch: vi.fn() },
  calendarRetry: false,
  joinError: null as Error | null,
  actions: new Map<string, () => void>(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (text: TemplateStringsArray) => text[0] }),
}));
vi.mock("@rakazo/contracts", () => ({ canLeaveMeeting: () => false }));
vi.mock("@rakazo/core", () => ({ showCalendarStatusRetry: () => mocks.calendarRetry }));
vi.mock("@rakazo/i18n/meeting", () => ({
  meetingPlatformLabel: () => "Example meeting",
  meetingStatusLabel: () => "Finished",
  meetingTime: () => "10:00",
}));
vi.mock("expo-router", () => ({
  useIsFocused: () => true,
  useLocalSearchParams: () => ({ botId: mocks.botId }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("react-native", () => {
  const View = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    ActivityIndicator: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
      <div role="progressbar" aria-label={accessibilityLabel} />
    ),
    ScrollView: View,
    StyleSheet: { create: (styles: unknown) => styles },
    Text: ({
      children,
      accessibilityRole,
    }: {
      children?: ReactNode;
      accessibilityRole?: string;
    }) => <span role={accessibilityRole}>{children}</span>,
    View,
  };
});
vi.mock("../../components/native/native-action-button", () => ({
  NativeActionButton: ({ label, onPress }: { label: string; onPress: () => void }) => {
    mocks.actions.set(label, onPress);
    return <button type="button">{label}</button>;
  },
}));
vi.mock("../../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsInputRow: () => null,
  SettingsRow: ({
    title,
    value,
    onPress,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
  }) => {
    if (onPress) mocks.actions.set(title, onPress);
    return <div>{value ? `${title} ${value}` : title}</div>;
  },
}));
vi.mock("../api/roster-signals", () => ({ useSpaceChanges: () => undefined }));
vi.mock("../api/user-error", () => ({ errorText: (error: Error) => error.message }));
vi.mock("../appearance/appearance", () => ({ mobileTokens: () => ({}) }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../navigation/screen-header", () => ({ useScreenHeader: () => undefined }));
vi.mock("../query/query", () => ({
  rpcQuery: (method: string) => ({ queryKey: [method] }),
  useSave: ({ onSaved }: { onSaved?: () => void }) => ({ error: onSaved ? mocks.joinError : null }),
}));
vi.mock("../query/screen-query", () => ({
  useScreenQuery: ({ queryKey: [method] }: { queryKey: string[] }) =>
    method === "meetings/list" ? mocks.list : mocks.calendar,
}));

function render() {
  mocks.actions.clear();
  return renderToStaticMarkup(<MeetingsScreen />);
}

beforeEach(() => {
  mocks.botId = "bot-1";
  mocks.list.data = undefined;
  mocks.list.error = null;
  mocks.list.isFetching = false;
  mocks.list.refetch.mockReset();
  mocks.calendar.refetch.mockReset();
  mocks.calendarRetry = false;
  mocks.joinError = null;
});

it("retries only the first meetings read and shows the recovered list", () => {
  mocks.list.error = new Error("Could not reach the server");
  mocks.list.refetch.mockImplementation(() => {
    mocks.list.isFetching = true;
  });

  const failed = render();
  expect(failed).toContain('role="alert">Could not reach the server');
  expect(mocks.actions.has("Retry")).toBe(true);
  mocks.actions.get("Retry")?.();
  expect(mocks.list.refetch).toHaveBeenCalledExactlyOnceWith({ cancelRefetch: false });
  expect(mocks.calendar.refetch).not.toHaveBeenCalled();
  expect(render()).toContain('role="progressbar"');
  expect(mocks.actions.has("Retry")).toBe(false);

  mocks.list.data = {
    enabled: true,
    meetings: [
      {
        id: "meeting-1",
        platform: "google_meet",
        status: "completed",
        transcriptAvailable: false,
        createdAt: "2026-01-01T10:00:00Z",
      },
    ],
  };
  mocks.list.error = null;
  mocks.list.isFetching = false;
  const recovered = render();
  expect(recovered).toContain("Example meeting");
  expect(recovered).not.toContain('role="alert"');
  expect(mocks.actions.has("Retry")).toBe(false);
});

it("does not offer first-read retry for cached data or a join failure", () => {
  mocks.list.data = { enabled: true, meetings: [] };
  mocks.list.error = new Error("Refresh failed");
  expect(render()).toContain('role="alert">Refresh failed');
  expect(mocks.actions.has("Retry")).toBe(false);

  mocks.joinError = new Error("Join failed");
  expect(render()).toContain('role="alert">Join failed');
  expect(mocks.actions.has("Retry")).toBe(false);
});

it("keeps unavailable state and calendar retry separate from the meetings retry", () => {
  mocks.botId = "";
  expect(render()).toContain("Meeting joins are unavailable.");
  expect(mocks.actions.has("Retry")).toBe(false);

  mocks.botId = "bot-1";
  mocks.list.data = { enabled: true, meetings: [] };
  mocks.calendarRetry = true;
  expect(render()).toContain("Could not load calendar Try again");
  expect(mocks.actions.has("Retry")).toBe(false);
  mocks.actions.get("Could not load calendar")?.();
  expect(mocks.calendar.refetch).toHaveBeenCalledTimes(1);
  expect(mocks.list.refetch).not.toHaveBeenCalled();
});
