// Remotion Studio / CLI entry (`remotion:studio`, `remotion:render`). Never
// imported by the app: Remotion is a dev dependency, and the app ships these
// poses as the generated CSS keyframes (`avatarMotion.generated.css`).
import { registerRoot } from "remotion";

import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
