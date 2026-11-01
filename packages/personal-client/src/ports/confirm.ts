export interface ConfirmRequest {
  readonly title: string;
  readonly body?: string | undefined;
  readonly confirmLabel?: string | undefined;
  readonly destructive: boolean;
}

export interface Confirm {
  confirm(request: ConfirmRequest): Promise<boolean>;
}
