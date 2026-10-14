import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {cp, mkdir, readdir, rename, rm, stat} from 'node:fs/promises';
import {basename, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {pluginDirectory} from './paths.js';
import {loadPluginManifest, type PluginManifest} from './plugin-manifest.js';
import {consentCovers, PluginStore} from './plugin-store.js';

const execFileAsync = promisify(execFile);

export interface PluginInstallResult {
  manifest: PluginManifest;
  previousVersion: string | null;
  // The new version asks for something the user has not agreed to, so it waits for consent.
  needsConsent: boolean;
}

export function isGitSource(source: string): boolean {
  return /^(https:\/\/|git@|ssh:\/\/)/.test(source) || /\.git$/.test(source);
}

// Native add-ons break when the desktop app updates Node, and are not allowed in v1.
async function findNativeAddon(folder: string): Promise<string | null> {
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      const found = await findNativeAddon(path);
      if (found) return found;
    } else if (entry.name.endsWith('.node')) {
      return path;
    }
  }
  return null;
}

// Copies or clones a plugin into place. Nothing in the plugin runs: no install scripts, no build.
export async function addPlugin(source: string, {
  directory = pluginDirectory(),
  store = new PluginStore(),
  git = 'git',
}: {directory?: string; store?: PluginStore; git?: string} = {}): Promise<PluginInstallResult> {
  await mkdir(directory, {recursive: true, mode: 0o700});
  const staging = join(directory, `.staging-${randomBytes(6).toString('hex')}`);
  let commit: string | undefined;
  try {
    if (isGitSource(source)) {
      await execFileAsync(git, ['clone', '--depth', '1', '--no-recurse-submodules', '--quiet', source, staging],
                          {timeout: 120_000});
      commit = (await execFileAsync(git, ['-C', staging, 'rev-parse', 'HEAD'])).stdout.trim();
      await rm(join(staging, '.git'), {recursive: true, force: true});
    } else {
      const folder = resolve(source);
      if (!(await stat(folder)).isDirectory()) throw new Error(`${source} is not a folder.`);
      await cp(folder, staging, {
        recursive: true,
        filter: path => basename(path) !== '.git',
      });
    }
    const manifest = loadPluginManifest(staging, false);
    const addon = await findNativeAddon(staging);
    if (addon) throw new Error(`Plugins cannot include native add-ons (${basename(addon)}).`);
    const target = join(directory, manifest.id);
    let previousVersion: string | null = null;
    try {
      previousVersion = loadPluginManifest(target).version;
    } catch {
      // A first install, or a broken earlier copy that this replaces.
    }
    const old = `${target}.old-${randomBytes(4).toString('hex')}`;
    await rename(target, old).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await rename(staging, target);
    await rm(old, {recursive: true, force: true});
    const record = await store.update(manifest.id, {
      source: {type: commit ? 'git' : 'path', ref: isGitSource(source) ? source : resolve(source), commit},
    });
    return {manifest, previousVersion, needsConsent: !consentCovers(record.consent, manifest)};
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}

// Removes the plugin's code, and its settings and secrets unless keepData.
export async function removePlugin(id: string, {
  directory = pluginDirectory(),
  store = new PluginStore(),
  keepData = false,
}: {directory?: string; store?: PluginStore; keepData?: boolean} = {}): Promise<void> {
  if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(id)) throw new Error('That is not a plugin id.');
  await rm(join(directory, id), {recursive: true, force: true});
  await store.forget(id, keepData);
}
