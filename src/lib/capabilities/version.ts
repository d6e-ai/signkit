/**
 * The SignKit product version this build was made from: the root
 * `package.json` `version`, injected at build time by `vite.config.ts`. The
 * release workflow refuses a tag that differs from it, so for a release build
 * this is the release tag without its leading `v` (`0.1.17` for `v0.1.17`). A
 * build from an untagged commit reports the version its `package.json` carries.
 */
export const SIGNKIT_VERSION: string = __SIGNKIT_VERSION__;
