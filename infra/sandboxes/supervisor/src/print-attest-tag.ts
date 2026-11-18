import { ATTEST_CONTEXT, expectedAttestImage } from "./egress-attest.js";

// Offline installs cannot build the attestation image on the Docker host; this
// prints the exact content-hash tag to build elsewhere and preload. A separate
// entry point, so it runs without any supervisor configuration or credentials.
process.stdout.write(`${expectedAttestImage(ATTEST_CONTEXT)}\n`);
