/**
 * Public programmatic API for SkillPlumb (`skill-plumb`).
 */
export { DEFAULT_DOMAINS, loadDomainsConfig, inferDomain, parseFrontmatterDomain } from './domains.mjs';
export {
  discoverSkillDirs,
  collectSkillEntries,
  discoverMcpConfig,
  discoverOverridesPath,
  defaultCachePath,
  findExecutable,
  execSafe,
} from './discovery.mjs';
export { loadOverrides } from './overrides.mjs';
export { tokenize, detectDirectNoTool, scoreFlat, scoreTwoStage } from './scorer.mjs';
export {
  parseFrontmatter,
  parseDescription,
  buildLiveCatalog,
  computeSourceFingerprint,
  buildCrowdedMissingNotFor,
  syncLiveCatalog,
  loadOrSyncCatalog,
  runBrief,
  runList,
  runInspect,
} from './catalog.mjs';
export { runScaffold } from './scaffold.mjs';
export { runGate, findHardcodedUserPaths } from './gate.mjs';
export { runDoctor, formatDoctorReport } from './doctor.mjs';
export { runInitPlugin } from './init_plugin.mjs';
