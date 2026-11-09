const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

/** @type {import("expo/metro-config").MetroConfig} */
const config = getDefaultConfig(__dirname);
const workspaceRoot = path.resolve(__dirname, "../..");

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspaceRoot])];
config.resolver.nodeModulesPaths = [
  path.join(__dirname, "node_modules"),
  path.join(workspaceRoot, "node_modules"),
];

// The phone pins react 19.2.3 while personal-client tests against catalog react
// 19.3.0, so a bare import of a package that holds React context resolves to a
// second copy inside personal-client. Each copy creates its own context, which
// splits atom state between the screens and the commands they run.
const SINGLETONS = {
  "@effect/atom-react": __dirname,
  scheduler: path.dirname(require.resolve("react-native/package.json")),
};

const singletonFor = (moduleName) =>
  Object.keys(SINGLETONS).find((name) => moduleName === name || moduleName.startsWith(`${name}/`));

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const singleton = singletonFor(moduleName);
  const next =
    singleton === undefined
      ? context
      : { ...context, originModulePath: path.join(SINGLETONS[singleton], "package.json") };
  return context.resolveRequest(next, moduleName, platform);
};

module.exports = config;
