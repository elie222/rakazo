import type { AdapterContext, PaidServiceProvider, ToolSearchHit } from "@rakazo/adapter-kit";
import { bestEffort } from "@rakazo/logging";
import { describePaidService, findPaidServices } from "../../payments/paid-service-tools.js";
import type { ToolSearchSource } from "./tool-search.js";

type ShownService = NonNullable<Awaited<ReturnType<typeof describePaidService>>>;

/** Paid lookups the deployment runs for the bot; service_call runs a hit and charges for it. */
export function paidServiceSource(
  provider: PaidServiceProvider,
  context: AdapterContext,
  billing: () => Promise<boolean>,
): ToolSearchSource {
  return {
    label: "paid services",
    async search(query, limit) {
      const services = await findPaidServices(
        provider,
        query.slice(0, 200),
        context,
        await billing(),
      );
      return services.slice(0, limit).map(serviceHit);
    },
    async find(ids) {
      const billed = await billing();
      const services = await Promise.all(
        ids.map((id) =>
          bestEffort(`find_tool service ${id}`, describePaidService(provider, id, context, billed)),
        ),
      );
      return services.filter((service) => service !== undefined).map(serviceHit);
    },
  };
}

function serviceHit({ id, name, description, ...details }: ShownService): ToolSearchHit {
  return { id, name, description, next: "service_call", details };
}
