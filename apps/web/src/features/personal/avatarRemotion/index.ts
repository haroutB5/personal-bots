// Remotion Studio / CLI entry (`remotion:studio`, `remotion:render`). Never
// imported by the app: the app only reaches Remotion through the lazy
// `AvatarPlayer` chunk.
import { registerRoot } from "remotion";

import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
