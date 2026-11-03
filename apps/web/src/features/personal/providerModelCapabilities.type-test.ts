import { providerModelCapabilities } from "@hbots/personal-client/bots/providerModelCapabilities";
import { getProviderModelCapabilities } from "~/providerModels";

// The package mirrors this upstream wrapper; either signature changing makes
// the other stop being assignable, so web tsc fails before the two drift.
const sameSignature: typeof getProviderModelCapabilities = providerModelCapabilities;
void sameSignature;
