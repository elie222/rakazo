import { useQuery } from "@tanstack/react-query";
import { Redirect, useLocalSearchParams, useSegments } from "expo-router";
import type { ReactNode } from "react";
import { ActivityIndicator } from "react-native";
import { errorText } from "../lib/api/user-error";
import { modelAccountConfigQuery } from "../lib/model-account-client";
import { useI18n } from "../lib/model-account-i18n";
import { modelConnectionRequest } from "../lib/models/model-connection-request";
import { queryClient } from "../lib/query/query";
import { LoadFailure } from "./ui/load-failure";

export function ModelAccountRoutes({ children }: { children: ReactNode }) {
  const segments = useSegments();
  const params = useLocalSearchParams<{ spaceId?: string; requestId?: string }>();
  const request = params.requestId ? modelConnectionRequest(params.requestId) : undefined;
  const spaceId =
    params.spaceId ?? (request?.target.scope === "space" ? request.target.spaceId : undefined);
  const guarded = ["models", "model-connection"].includes(segments[segments.length - 1] ?? "");
  const policy = useQuery({ ...modelAccountConfigQuery(), enabled: guarded }, queryClient);
  const { t } = useI18n();
  if (!guarded) return children;
  if (policy.error && !policy.data)
    return (
      <LoadFailure
        message={errorText(policy.error, t("Could not load model settings"))}
        onRetry={() => void policy.refetch()}
      />
    );
  if (!policy.data) return <ActivityIndicator />;
  if (policy.data.modelAccountOnly)
    return (
      <Redirect
        href={{
          pathname: "/model-account",
          params: spaceId ? { spaceId } : {},
        }}
      />
    );
  return children;
}
