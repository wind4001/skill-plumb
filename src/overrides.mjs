/**
 * Loader & schema validator for zero-invasion `router_overrides.json`.
 * Never silently drops non-array `not_for` or `aka` values — emits explicit warnings.
 */
import fs from 'node:fs';

function normalizeStringArrayField(skillName, field, rawVal, warnings) {
  if (rawVal === undefined) return [];
  if (Array.isArray(rawVal)) {
    const out = [];
    for (const item of rawVal) {
      if (typeof item === 'string' && item.trim()) {
        out.push(item.trim());
      } else {
        warnings.push({
          skill: skillName,
          field,
          message: `Expected non-empty string item in ${field}[], got ${typeof item}`,
        });
      }
    }
    return out;
  }
  warnings.push({
    skill: skillName,
    field,
    message: `Field "${field}" must be a string array (got ${typeof rawVal}); coerced to array to avoid silent loss`,
  });
  if (typeof rawVal === 'string' && rawVal.trim()) {
    return [rawVal.trim()];
  }
  return [];
}

export function loadOverrides(overridesPath, { explicit = false } = {}) {
  if (!overridesPath) {
    return { ok: true, overrides: {}, warnings: [], error: null, path: null };
  }
  if (!fs.existsSync(overridesPath)) {
    if (explicit) {
      return {
        ok: false,
        overrides: {},
        warnings: [],
        error: `Overrides file not found: ${overridesPath}`,
        path: overridesPath,
      };
    }
    return { ok: true, overrides: {}, warnings: [], error: null, path: overridesPath };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      overrides: {},
      warnings: [],
      error: `Invalid JSON in overrides file ${overridesPath}: ${err.message}`,
      path: overridesPath,
    };
  }

  let rawMap;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.overrides !== undefined) {
      if (typeof parsed.overrides !== 'object' || parsed.overrides === null || Array.isArray(parsed.overrides)) {
        return {
          ok: false,
          overrides: {},
          warnings: [],
          error: `"overrides" property in ${overridesPath} must be an object`,
          path: overridesPath,
        };
      }
      rawMap = parsed.overrides;
    } else {
      rawMap = { ...parsed };
      delete rawMap._doc;
      delete rawMap.$schema;
    }
  } else {
    return {
      ok: false,
      overrides: {},
      warnings: [],
      error: `Overrides root in ${overridesPath} must be a JSON object`,
      path: overridesPath,
    };
  }

  const warnings = [];
  const normalized = {};
  for (const [skillName, entry] of Object.entries(rawMap)) {
    if (skillName.startsWith('_') || skillName === '$schema') continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      warnings.push({
        skill: skillName,
        field: 'entry',
        message: `Override entry for "${skillName}" must be an object`,
      });
      continue;
    }
    normalized[skillName] = {
      domain: typeof entry.domain === 'string' && entry.domain.trim() ? entry.domain.trim().toLowerCase() : null,
      aka: normalizeStringArrayField(skillName, 'aka', entry.aka, warnings),
      not_for: normalizeStringArrayField(skillName, 'not_for', entry.not_for, warnings),
    };
  }

  return { ok: true, overrides: normalized, warnings, error: null, path: overridesPath };
}
