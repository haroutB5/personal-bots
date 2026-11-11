/** What the setting asks for. Owned is the default and needs nothing; shared names Brave's own data folder. */
export type BrowserBackendSetting =
  | { readonly kind: "owned" }
  | { readonly kind: "shared"; readonly userDataDir: string };
