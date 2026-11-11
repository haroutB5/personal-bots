// @effect-diagnostics nodeBuiltinImport:off - one existence probe on the profile folder, before any launch.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Data from "effect/Data";

export const IMPORT_MARKER_FILE = "hbots-import.json";

export class ImportedProfileRefused extends Data.TaggedError("ImportedProfileRefused")<{
  readonly profileDir: string;
  readonly message: string;
}> {}

const refusal = (profileDir: string) =>
  new ImportedProfileRefused({
    profileDir,
    message: `This browser folder was imported from a real browser and must not be launched by hbots: ${profileDir} holds ${IMPORT_MARKER_FILE}. Use the shared browser setting, or point hbots at a different folder.`,
  });

export const refuseImportedProfile = async (profileDir: string): Promise<void> => {
  const marked = await NodeFSP.access(NodePath.join(profileDir, IMPORT_MARKER_FILE)).then(
    () => true,
    () => false,
  );
  if (marked) throw refusal(profileDir);
};
