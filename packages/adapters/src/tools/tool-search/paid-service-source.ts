import type { AdapterContext, PaidServiceProvider, ToolSearchHit } from "@rakazo/adapter-kit";
import { describePaidService, findPaidServices } from "../../payments/paid-service-tools.js";
import type { ToolSearchSource } from "./tool-search.js";

type ShownService = NonNullable<Awaited<ReturnType<typeof describePaidService>>>;

/** Paid lookups the deployment runs for the bot; service_call runs a hit and charges for it. */
export function paidServiceSource(
  provider: PaidServiceProvider,
  context: AdapterContext,
  billing: boolean,
): ToolSearchSource {
  return {
    label: "paid services",
    async search(query, limit) {
      const services = await findPaidServices(provider, query.slice(0, 200), context, billing);
      return services.slice(0, limit).map(serviceHit);
    },
    async find(ids) {
      const services = await Promise.all(
        ids.map((id) => describePaidService(provider, id, context, billing)),
      );
      return services.filter((service) => service !== undefined).map(serviceHit);
    },
  };
}

function serviceHit({ id, name, description, ...details }: ShownService): ToolSearchHit {
  return { id, name, description, next: "service_call", details };
}
