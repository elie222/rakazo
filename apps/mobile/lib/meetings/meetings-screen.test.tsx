import { deferred } from "@rakazo/core/test-async";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
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
  leaveError: null as Error | null,
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
  SettingsGroup: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <section aria-label={accessibilityLabel}>{children}</section>,
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
vi.mock("../i18n/i18n", () => ({ useDateLocale: () => "en-US" }));
vi.mock("../layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../native/native", () => ({
  native: {},
  useThemedStyles: <T,>(factory: () => T) => factory(),
}));
vi.mock("../navigation/screen-header", () => ({ useScreenHeader: () => undefined }));
vi.mock("../query/query", () => ({
  rpcQuery: (method: string) => ({ queryKey: [method] }),
  useSave: ({ onSaved }: { onSaved?: () => void }) => ({
    error: onSaved ? mocks.joinError : mocks.leaveError,
  }),
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
  mocks.leaveError = null;
});

it("offers Retry after a failed first read and recovers when it succeeds", async () => {
  const retry = deferred<Meetings>();
  const read = vi
    .fn<() => Promise<Meetings>>()
    .mockRejectedValueOnce(new Error("Could not reach the server"))
    .mockImplementationOnce(() => retry.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new QueryObserver(client, {
    queryKey: ["meetings/list"],
    queryFn: read,
    enabled: false,
  });
  const unsubscribe = observer.subscribe(({ data, error, isFetching }) =>
    Object.assign(mocks.list, { data, error, isFetching }),
  );
  mocks.list.refetch.mockImplementation((options) => observer.refetch(options));

  try {
    await observer.refetch();
    expect(render()).toContain('role="alert">Could not reach the server');
    mocks.actions.get("Retry")?.();
    expect(mocks.list.refetch).toHaveBeenCalledWith({ cancelRefetch: false });

    const loading = render();
    expect(loading).toContain('role="progressbar"');
    expect(loading).not.toContain("Retry");
    expect(loading).not.toContain('role="alert"');
    expect(mocks.calendar.refetch).not.toHaveBeenCalled();

    retry.resolve({ enabled: true, meetings: [] });
    await mocks.list.refetch.mock.results[0]?.value;
    const recovered = render();
    expect(recovered).toContain("Join meeting");
    expect(recovered).not.toContain("Recent meetings");
    expect(recovered).not.toContain("Retry");
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    client.clear();
  }
});

it("does not offer first-read retry for cached data or a join failure", () => {
  mocks.list.data = { enabled: true, meetings: [] };
  mocks.list.error = new Error("Refresh failed");
  expect(render()).toContain('role="alert">Refresh failed');
  expect(mocks.actions.has("Retry")).toBe(false);

  mocks.joinError = new Error("Join failed");
  expect(render()).toContain('role="alert">Join failed');
  expect(mocks.actions.has("Retry")).toBe(false);
  mocks.joinError = null;
  mocks.leaveError = new Error("Leave failed");
  expect(render()).toContain('role="alert">Leave failed');
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
