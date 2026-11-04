import { configureOutbox } from "@hbots/personal-client/composer/outbox";
import { configureOutboxBlobs } from "@hbots/personal-client/composer/outboxBlobs";

import { randomUUID } from "~/lib/utils";
import { webKeyValueStore } from "./webStorage";
import { webBlobStore } from "./webBlobStore";

/**
 * Binds the queue before any screen reads it. The cold-launch reconnect screen
 * imports the outbox without loading the app bootstrap, and it must still see
 * the messages already on the device.
 */
configureOutbox({ store: webKeyValueStore, ids: { randomUUID } });
configureOutboxBlobs(webBlobStore);
