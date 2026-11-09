// The mobile app's package is CommonJS-flavoured, so the server program cannot
// parse its sources. This declaration keeps the integration test typed without
// pulling the mobile module graph into the server typecheck shards.
export interface MobileStoredSession {
  readonly environmentId: string;
  readonly label: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly accessToken: string;
  readonly scope: string;
  readonly expiresAt: number;
  readonly pairedAt: number;
}

export function openSocketUrl(
  session: MobileStoredSession,
  clientAppVersion: string,
  signal?: AbortSignal,
): Promise<string>;
