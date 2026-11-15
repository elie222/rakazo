// The server imports only @better-auth/expo's server plugin. Its optional Expo peers serve the
// unused client entry, yet resolve to the mobile app's copies and pull React Native into the
// server image.
function readPackage(pkg) {
  if (pkg.name === "@better-auth/expo") {
    for (const name of Object.keys(pkg.peerDependencies ?? {})) {
      if (name.startsWith("expo-")) {
        delete pkg.peerDependencies[name];
        delete pkg.peerDependenciesMeta?.[name];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
