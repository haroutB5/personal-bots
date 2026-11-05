/**
 * Android's picker can report a media id (`22.png`) instead of the file's own
 * display name. The content resolver's name wins when it has one.
 */
export function attachmentName(input: {
  readonly resolvedName: string | null;
  readonly fileName: string | null | undefined;
  readonly camera: boolean;
  readonly index: number;
}): string {
  const resolvedName = input.resolvedName?.trim();
  if (resolvedName !== undefined && resolvedName.length > 0) return resolvedName;
  const fileName = input.fileName?.trim();
  if (fileName !== undefined && fileName.length > 0) return fileName;
  return input.camera ? "Camera photo.jpg" : `Photo ${String(input.index + 1)}.jpg`;
}
