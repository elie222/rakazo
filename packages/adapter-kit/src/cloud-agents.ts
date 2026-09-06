/** A provider definitively rejected a request before starting remote work. */
export class CloudAgentRequestRejected extends Error {
  constructor() {
    super("Cloud agent request was rejected. Check the provider configuration and request.");
    this.name = "CloudAgentRequestRejected";
  }
}
