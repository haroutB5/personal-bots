import { requireOptionalNativeModule } from "expo";

import { type GoogleAuthModule, type GoogleAuthPort, makeGoogleAuthPort } from "./googleAuth";

export const googleAuth: GoogleAuthPort = makeGoogleAuthPort(
  requireOptionalNativeModule<GoogleAuthModule>("HbotsGoogleAuth"),
);
