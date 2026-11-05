import type { ServerProvider } from "@t3tools/contracts";
import type { FieldChoice } from "@hbots/personal-client/bots/botFormFields";

export type SheetRequest =
  | {
      readonly kind: "choice";
      readonly title: string;
      readonly choices: ReadonlyArray<FieldChoice>;
      readonly value: string;
      readonly onSelect: (value: string) => void;
    }
  | {
      readonly kind: "model";
      readonly title: string;
      readonly models: ServerProvider["models"];
      readonly value: string;
      readonly onSelect: (slug: string) => void;
    };

export type OpenSheet = (request: SheetRequest) => void;
