/**
 * The picker's own file name is the only name it has without a media
 * permission. When the picker hands back a generated cache name, the message
 * says "Photo N" instead of showing a UUID.
 */
const GENERATED_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[a-z0-9]+)?$/i;

export function attachmentName(input: {
  readonly fileName: string | null | undefined;
  readonly camera: boolean;
  readonly index: number;
}): string {
  const fileName = input.fileName?.trim();
  if (fileName !== undefined && fileName.length > 0 && !GENERATED_NAME.test(fileName)) {
    return fileName;
  }
  return input.camera ? "Camera photo.jpg" : `Photo ${String(input.index + 1)}.jpg`;
}
