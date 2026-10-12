// The upstream files the Bun port's classes name in their Javadoc (rewrite-javascript's internal.lock.bun, which
// follows bun 1.3.10), by their path at tag bun-v1.3.10, with the classes that name each. Zig's standard library
// (wyhash.zig, hash_map.zig at oven-sh/zig c031cbebf5) is named too but is not in oven-sh/bun.
const FILES = [
  'src/install/PackageManager/install_with_manager.zig', // BunLockRegenerator
  'src/install/PackageManager/PackageManagerOptions.zig', // BunOptions
  'src/install/PackageManager/PackageManagerEnqueue.zig', // PackageManager
  'src/install/PackageManager/runTasks.zig', // PackageManager
  'src/install/PackageManager/processDependencyList.zig', // PackageManager
  'src/install/PackageManager/PackageManagerResolution.zig', // PackageManager
  'src/install/resolvers/folder_resolver.zig', // PackageManager
  'src/install/lockfile.zig', // Lockfile, Cleaner, DefaultTrustedDependencies
  'src/install/default-trusted-dependencies.txt', // DefaultTrustedDependencies
  'src/install/lockfile/bun.lock.zig', // TextLockfileReader, TextLockfileWriter
  'src/install/lockfile/Tree.zig', // Tree
  'src/install/lockfile/Package.zig', // Package, PackageDiff, Cleaner
  'src/install/lockfile/Package/Meta.zig', // Package
  'src/install/lockfile/Package/Scripts.zig', // Package
  'src/install/lockfile/Package/WorkspaceMap.zig', // Workspaces
  'src/install/lockfile/CatalogMap.zig', // CatalogMap
  'src/install/lockfile/OverrideMap.zig', // OverrideMap
  'src/install/dependency.zig', // Dependency, DependencyVersion, Behavior
  'src/install/resolution.zig', // Resolution
  'src/install/versioned_url.zig', // Resolution
  'src/install/npm.zig', // PackageManifest, Negatable
  'src/install/integrity.zig', // Integrity
  'src/install/repository.zig', // Repository
  'src/install/hosted_git_info.zig', // HostedGitInfo
  'src/install/bin.zig', // Bin
  'src/install/install.zig', // Features
  'src/semver/Version.zig', // SemverVersion
  'src/semver/SemverQuery.zig', // SemverQuery
  'src/semver/SemverRange.zig', // SemverRange
  'src/glob.zig', // Glob
  'src/glob/match.zig', // Glob
  'src/ini.zig', // Ini
  'src/env_loader.zig', // DotEnv
  'src/interchange/json.zig', // Json
  'src/string/immutable.zig', // Strings
  'src/js_printer.zig', // Strings
  'src/wyhash.zig', // Wyhash11
  'src/bunfig.zig', // Toml (as bunfig.zig reads it)
  'src/toml/', // Toml (bun's TOML parser, a directory)
]
module.exports = { FILES }
