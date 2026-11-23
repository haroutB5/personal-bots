import * as SecureStore from "expo-secure-store";

import { parseRescueRebootConfig, type RescueRebootConfig } from "./restartLaptopModel";

export { parseRescueRebootConfig, type RescueRebootConfig } from "./restartLaptopModel";

export const RESCUE_REBOOT_STORAGE_KEY = "hbots.rescueReboot.v1";

export async function saveRescueReboot(config: RescueRebootConfig): Promise<boolean> {
  const valid = parseRescueRebootConfig(config);
  if (valid === null) return false;
  try {
    await SecureStore.setItemAsync(RESCUE_REBOOT_STORAGE_KEY, JSON.stringify(valid));
    return true;
  } catch {
    return false;
  }
}

export async function loadRescueReboot(): Promise<RescueRebootConfig | null> {
  try {
    const raw = await SecureStore.getItemAsync(RESCUE_REBOOT_STORAGE_KEY);
    if (raw === null) return null;
    return parseRescueRebootConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function clearRescueReboot(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(RESCUE_REBOOT_STORAGE_KEY);
  } catch {
    // Ignore storage errors on sign-out so session teardown always completes.
  }
}
