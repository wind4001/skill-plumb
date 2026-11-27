import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatDoctorReport, runDoctor } from '../src/index.mjs';

function snapshotHashes(rootDir) {
  const out = {};
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else out[path.relative(rootDir, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  }
  walk(rootDir);
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-doctor-test-with spaces-'));
try {
  // 1. Healthy fixture directory returns exit 0
  const cleanDir = path.join(tmp, 'clean-skills');
  fs.mkdirSync(path.join(cleanDir, 'alpha-db', 'references'), { recursive: true });
  fs.writeFileSync(path.join(cleanDir, 'alpha-db', 'references', 'guide.md'), '# Guide\n');
  fs.writeFileSync(
    path.join(cleanDir, 'alpha-db', 'SKILL.md'),
    '---\nname: alpha-db\nx-domain: db\ndescription: "Audit Postgres schemas. Use when checking tables. Not for query tuning."\n---\n\nSee [guide](references/guide.md)\n'
  );
  const cleanDoc = runDoctor({ skillsDirs: [cleanDir], noMcp: true });
  assert.equal(cleanDoc.exitCode, 0);
  assert.equal(cleanDoc.result.summary.findings_count, 0);

  // 2. Messy fixture dir surfaces bloated SKILL.md, crowded missing Not-for, broken link, path leak & override warning
  const messyDir = path.join(tmp, 'messy-skills');
  const ovrFile = path.join(tmp, 'bad_overrides.json');
  fs.mkdirSync(path.join(messyDir, 'pg-one'), { recursive: true });
  fs.mkdirSync(path.join(messyDir, 'pg-two'), { recursive: true });

  const longBody = Array.from({ length: 160 }, (_, i) => `Rule ${i}`).join('\n');
  const leakPath = ['/home', 'bobdev', 'scripts', 'run.mjs'].join('/');
  fs.writeFileSync(
    path.join(messyDir, 'pg-one', 'SKILL.md'),
    `---\nname: pg-one\nx-domain: db\ndescription: "Postgres linter one. Use when checking FK constraints."\n---\n\nRun \`${leakPath}\`\nSee [missing](references/missing.md)\n${longBody}\n`
  );
  fs.writeFileSync(
    path.join(messyDir, 'pg-two', 'SKILL.md'),
    '---\nname: pg-two\nx-domain: db\ndescription: "Postgres linter two. Use when checking slow queries."\n---\n# Two\n'
  );
  fs.writeFileSync(ovrFile, JSON.stringify({
    overrides: {
      'pg-two': {
        domain: 'db',
        not_for: 'non-array string value',
      },
    },
  }, null, 2));

  const beforeHashes = snapshotHashes(messyDir);
  const messyDoc = runDoctor({
    skillsDirs: [messyDir],
    overridesPath: ovrFile,
    noMcp: true,
  });
  const afterHashes = snapshotHashes(messyDir);

  assert.deepEqual(afterHashes, beforeHashes, 'doctor MUST be strictly read-only');
  assert.equal(messyDoc.exitCode, 2);
  const s = messyDoc.result.summary;
  assert.equal(s.bloated_count, 1);
  assert.equal(s.crowded_missing_not_for_count, 1);
  assert.equal(s.broken_links_count, 1);
  assert.equal(s.hardcoded_path_count, 1);
  assert.equal(s.override_warnings_count, 1);

  assert.ok(messyDoc.result.suggested_overrides?.overrides?.['pg-one']);
  const textReport = formatDoctorReport(messyDoc.result);
  assert.match(textReport, /ISSUES FOUND/);
  assert.match(textReport, /pg-one/);
  assert.match(textReport, /Suggested router_overrides\.json/);

  // 3. Explicit nonexistent --skills-dir or --mcp-cfg must return exitCode 1 (never 0 HEALTHY)
  const missingDirDoc = runDoctor({ skillsDirs: [path.join(tmp, 'no-such-skills-dir')], noMcp: true });
  assert.equal(missingDirDoc.exitCode, 1);
  const missingMcpDoc = runDoctor({ skillsDirs: [cleanDir], mcpCfgPath: path.join(tmp, 'no-such-mcp.json') });
  assert.equal(missingMcpDoc.exitCode, 1);

  // 4. Unclosed >35-line fence flagged bloated; example link inside code block ignored
  const edgeDir = path.join(tmp, 'edge-skills');
  fs.mkdirSync(path.join(edgeDir, 'edge-skill'), { recursive: true });
  const unclosed = ['```bash', ...Array.from({ length: 40 }, (_, i) => `echo ${i}`)].join('\n');
  fs.writeFileSync(
    path.join(edgeDir, 'edge-skill', 'SKILL.md'),
    `---\nname: edge-skill\nx-domain: repo\ndescription: "Edge case check. Use when testing doctor. Not for db."\n---\n\n\`\`\`md\n[example](references/not-real.md)\n\`\`\`\n\n${unclosed}\n`
  );
  const edgeDoc = runDoctor({ skillsDirs: [edgeDir], noMcp: true });
  assert.equal(edgeDoc.exitCode, 2);
  assert.equal(edgeDoc.result.summary.bloated_count, 1);
  assert.equal(edgeDoc.result.summary.broken_links_count, 0);

  // 5. Missing frontmatter / Use when surfaced in both summary and formatted report table
  const noFmDir = path.join(tmp, 'nofm-skills');
  fs.mkdirSync(path.join(noFmDir, 'plain-md'), { recursive: true });
  fs.writeFileSync(path.join(noFmDir, 'plain-md', 'SKILL.md'), '# No YAML Frontmatter\nJust plain text.\n');
  const noFmDoc = runDoctor({ skillsDirs: [noFmDir], noMcp: true });
  assert.equal(noFmDoc.exitCode, 2);
  assert.equal(noFmDoc.result.summary.missing_frontmatter_or_use_when_count, 1);
  const noFmTable = formatDoctorReport(noFmDoc.result);
  assert.match(noFmTable, /Missing YAML frontmatter \/ name \/ Use when \| 1/);

  console.log('test_doctor.mjs PASSED (5/5)');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
