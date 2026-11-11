import { requireOptionalNativeModule } from "expo";

interface SecureStorageModule {
  writeEncryptedText(path: string, text: string): void;
  readDecryptedText(path: string): Promise<string | null>;
  encryptFile(sourceUri: string, destinationPath: string): Promise<boolean>;
  decryptFile(sourcePath: string, destinationPath: string): Promise<boolean>;
  deleteCacheKey(): void;
  setRecentsBlanked(blank: boolean): void;
}

const native = requireOptionalNativeModule<SecureStorageModule>("HbotsSecure");

/** Whether the Keystore helper is linked. Without it nothing is cached: no plaintext fallback. */
export const secureStorageAvailable = native !== null;

/** Writes `text` as `v1 | iv | ciphertext` under the Keystore key. Throws when it cannot. */
export function writeEncryptedText(path: string, text: string): void {
  if (native === null) throw new Error("Secure storage is not available.");
  native.writeEncryptedText(path, text);
}

/** The text, or null when the file is unreadable or in an old format (the native side deletes it). */
export async function readDecryptedText(path: string): Promise<string | null> {
  return native === null ? null : native.readDecryptedText(path);
}

export async function encryptFile(sourceUri: string, destinationPath: string): Promise<boolean> {
  return native === null ? false : native.encryptFile(sourceUri, destinationPath);
}

export async function decryptFile(sourcePath: string, destinationPath: string): Promise<boolean> {
  return native === null ? false : native.decryptFile(sourcePath, destinationPath);
}

/** Removes the Keystore key. Files written under it become unreadable. */
export function deleteCacheKey(): void {
  native?.deleteCacheKey();
}

/** Blanks the Recents thumbnail and shields the app in the background while the app lock is on. */
export function setRecentsBlanked(blank: boolean): void {
  native?.setRecentsBlanked(blank);
}
