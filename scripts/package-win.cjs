const fs = require('node:fs/promises');
const path = require('node:path');
const { createRequire } = require('node:module');
const asar = require('@electron/asar');
const { build, Platform, Arch } = require('electron-builder');
const root = path.resolve(__dirname, '..'), release = path.join(root, 'release');
function owned(target) {
  const relative = path.relative(release, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Packaging path must stay within release');
  return path.resolve(target);
}
async function reset(target) { const verified = owned(target); await fs.rm(verified, { recursive: true, force: true, maxRetries: 3 }); await fs.mkdir(verified, { recursive: true }); }
async function resolvePackage(name, from) {
  const request = createRequire(path.join(from, 'package.json'));
  try { return path.dirname(request.resolve(`${name}/package.json`)); }
  catch {
    let directory = path.dirname(request.resolve(name));
    while (directory !== path.dirname(directory)) {
      try { const value = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8')); if (value.name === name) return directory; } catch {}
      directory = path.dirname(directory);
    }
    throw new Error(`Cannot resolve ${name}`);
  }
}
async function main() {
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const stage = owned(path.join(release, 'staging')), unpacked = owned(path.join(release, 'win-unpacked'));
  await reset(stage); await reset(unpacked);
  const dist = path.join(root, 'node_modules', 'electron', 'dist');
  await fs.access(path.join(dist, 'electron.exe'));
  await fs.cp(dist, unpacked, { recursive: true });
  await fs.rename(path.join(unpacked, 'electron.exe'), path.join(unpacked, 'FlyDrop.exe'));
  await fs.rm(path.join(unpacked, 'resources', 'default_app.asar'), { force: true });
  for (const name of ['desktop', 'public', 'server.js', 'security.js']) await fs.cp(path.join(root, name), path.join(stage, name), { recursive: true });
  await fs.mkdir(path.join(stage, 'build')); for (const name of ['tray.png', 'icon.ico']) await fs.copyFile(path.join(root, 'build', name), path.join(stage, 'build', name));
  const runtime = { name: metadata.name, version: metadata.version, main: metadata.main, type: metadata.type, description: metadata.description, author: metadata.author, dependencies: metadata.dependencies };
  await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(runtime, null, 2));
  const visited = new Set();
  async function collect(name, from, optional = false) {
    let source; try { source = await resolvePackage(name, from); } catch (error) { if (optional) return; throw error; }
    if (visited.has(source)) return; visited.add(source);
    const relative = path.relative(path.join(root, 'node_modules'), source);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Dependency outside checkout: ${name}`);
    await fs.cp(source, path.join(stage, 'node_modules', relative), { recursive: true, filter: filename => filename === source || path.basename(filename) !== 'node_modules' });
    const pkg = JSON.parse(await fs.readFile(path.join(source, 'package.json'), 'utf8'));
    for (const dependency of Object.keys(pkg.dependencies || {})) await collect(dependency, source);
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) await collect(dependency, source, true);
    for (const dependency of Object.keys(pkg.peerDependencies || {})) await collect(dependency, source, Boolean(pkg.peerDependenciesMeta?.[dependency]?.optional));
  }
  for (const name of Object.keys(runtime.dependencies)) await collect(name, root);
  await asar.createPackage(stage, path.join(unpacked, 'resources', 'app.asar'));
  console.log(`Packaged ${visited.size} runtime dependencies; no PowerShell or package-manager child process`);
  await build({ projectDir: root, prepackaged: unpacked, targets: Platform.WINDOWS.createTarget('portable', Arch.x64), config: { ...metadata.build, npmRebuild: false, electronVersion: metadata.devDependencies.electron.replace(/^[^\d]+/, '') } });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
