/**
 * Where a `host-file` link points on this host.
 *
 * The path resolves the way the chat shows it: the workspace first, then the
 * home folder, with `~/` and the old Windows paths mapped. The deny list runs
 * on whichever candidate the asset layer finally opens, in `AssetAccess`.
 */
import { hostPathCandidates } from "../../workspace/HostFilePaths.ts";

export interface HostFileRequest {
  readonly path: string;
  /** The chat's workspace root. */
  readonly cwd: string;
  readonly homeDir: string;
}

/** Every place the link can mean, most likely first. */
export function hostFileCandidates(input: HostFileRequest): string[] {
  return hostPathCandidates(input.path, {
    workspaceRoot: input.cwd,
    homeDir: input.homeDir,
    pathMap: process.env.T3CODE_PATH_MAP,
  });
}
