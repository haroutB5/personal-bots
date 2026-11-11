import * as Layer from "effect/Layer";

import {
  personalBrowserFilesRouteLayer,
  personalBrowserStreamRouteLayer,
} from "../browser/routes.ts";
import * as PersonalBrowserHost from "../browser/ServerBrowserHost.ts";
import { personalDesktopStreamRouteLayer } from "../desktop/routes.ts";
import { personalClientDiagRouteLayer } from "../push/clientDiagRoute.ts";
import {
  personalNotificationActionRouteLayer,
  personalNotificationContentRouteLayer,
} from "../push/notificationActionsRoute.ts";
import { personalPushSentRouteLayer } from "../push/sentPushesRoute.ts";
import { personalUpdateStatusRouteLayer } from "../updateStatus/updateStatusRoute.ts";
import { personalClientCompatRouteLayer } from "../clientCompat/clientCompatRoute.ts";
import { personalAndroidApkRouteLayer } from "../androidUpdates/androidApkRoute.ts";
import { personalPerformanceStreamRouteLayer } from "../performance/routes.ts";
import { personalSystemSummaryRouteLayer } from "../performance/systemSummaryRoute.ts";
import {
  personalRoutineHookMethodRouteLayer,
  personalRoutineHookRouteLayer,
} from "../routines/hookRoutes.ts";

/**
 * Every HTTP route the personal layer owns, in one registration. The shared
 * server keeps the merge line; the routes and their wiring live here.
 */
export const personalHttpRoutesLayer = Layer.mergeAll(
  // personal browser (routes + in-process preview automation host; the host
  // shares the single PreviewAutomationBroker provided by the server)
  personalBrowserStreamRouteLayer,
  personalBrowserFilesRouteLayer,
  // The PC's live view (Computer > Desktop): view only, frames while watched.
  personalDesktopStreamRouteLayer,
  // Open, allowlisted and rate limited: notification-tap diagnostics (see clientDiagRoute.ts).
  personalClientDiagRouteLayer,
  // Signed-in only: pushes sent to this device, for taps iOS drops (see sentPushesRoute.ts).
  personalPushSentRouteLayer,
  // Bearer or DPoP only: what a phone push says, and its reply and one-tap answer (see notificationActionsRoute.ts).
  personalNotificationContentRouteLayer,
  personalNotificationActionRouteLayer,
  // Signed-in only: where a release is, for the Bots page's status line (see updateStatusRoute.ts).
  personalUpdateStatusRouteLayer,
  // Open: the Android version handshake, before a client holds a credential.
  personalClientCompatRouteLayer,
  // Bearer only: the current APK for the phone's self-updater (see androidApkRoute.ts).
  personalAndroidApkRouteLayer,
  // Signed-in only: the Performance tab's SSE feed; samples only while watched
  // (see personal/performance/routes.ts).
  personalPerformanceStreamRouteLayer,
  // Signed-in only: CPU, RAM and disk for the Bots page header line; never
  // starts the sampler (see personal/performance/systemSummaryRoute.ts).
  personalSystemSummaryRouteLayer,
  // Unauthenticated by necessity; the URL token is the whole credential.
  personalRoutineHookRouteLayer,
  personalRoutineHookMethodRouteLayer,
  PersonalBrowserHost.layer,
);
