import assert from 'node:assert/strict';
import fs from 'node:fs';
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const version = process.env.RELEASE_VERSION;
assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? ''), 'An exact stable release version is required');
assert.notEqual(version, '0.0.0', 'Choose a release version before publishing');
assert.equal(version, manifest.version, 'Requested version must match package.json');
assert.equal(lock.version, version, 'Lockfile root version must match');
assert.equal(lock.packages[''].version, version, 'Lockfile package version must match');
assert.equal(lock.name, manifest.name, 'Lockfile name must match');
for (const [name, value] of Object.entries(manifest.dependencies)) {
  assert.equal(lock.packages[''].dependencies[name], value, `Lockfile dependency pin differs: ${name}`);
  assert(!/^(?:file:|link:|workspace:)/.test(value), `Local dependency cannot be published: ${name}`);
  if (name.startsWith('@korus-dev/')) assert.notEqual(value, '0.0.0', `Publish and pin ${name} first`);
}
console.log(`Release metadata validated: ${manifest.name}@${version}`);
