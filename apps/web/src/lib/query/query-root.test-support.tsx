import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";

/** A React root whose renders share one query client, which saves and reads need. */
export function createQueryRoot(container: Element, queryClient = new QueryClient()) {
  const root = createRoot(container);
  return {
    queryClient,
    render: (node: ReactNode) =>
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
    unmount: () => root.unmount(),
  };
}
