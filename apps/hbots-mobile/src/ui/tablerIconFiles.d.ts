/**
 * The package's export map points its types at dist/icons/<Name>.d.ts, but the files sit in
 * dist/icons/icons/. TypeScript cannot see the per-icon declarations, so each deep import is
 * typed as the package's own Icon component type.
 */
declare module "@tabler/icons-react-native/*" {
  const icon: import("@tabler/icons-react-native/types").Icon;
  export default icon;
}
