import type { ServerProviderResetCredits } from "@t3tools/contracts";
import { resetCreditOffer } from "@hbots/personal-client/usage/usagePresentation";

/** The redeem row the usage strip draws: a button, the pairing line, or neither. */
export interface UsageRedeemRow {
  readonly showButton: boolean;
  readonly notice: string | null;
}

export function usageRedeemRow(
  credits: Pick<ServerProviderResetCredits, "availableCount">,
  canRedeem: boolean,
): UsageRedeemRow {
  const offer = resetCreditOffer(credits.availableCount, canRedeem);
  switch (offer._tag) {
    case "Redeem":
      return { showButton: true, notice: null };
    case "PairAgain":
      return { showButton: false, notice: offer.notice };
    case "Hidden":
      return { showButton: false, notice: null };
  }
}
