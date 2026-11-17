/**
 * What is wrong with the details given for a provider or server connection, or with how that
 * server answered a check. The message is written for the person setting the connection up.
 */
export class ConnectionSetupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConnectionSetupError";
  }
}
