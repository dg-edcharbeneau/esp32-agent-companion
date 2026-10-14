import {readFileSync, realpathSync, statSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';

// The plugin API this host speaks. A plugin names the lowest version it needs in "api".
export const hostApiVersion = {major: 1, minor: 0} as const;
export const manifestFileName = 'agent-buddy.plugin.json';

// What a plugin may ask for. Unknown permissions are rejected so a typo never silently does nothing.
export const pluginPermissions = [
  'speech.provide', // Answer speech/synthesize for the providers the manifest contributes.
  'events.state', // Receive the companion's character state changes.
  'events.agent', // Receive sanitized agent activity: which agent, which event, never prompt text.
  'voice.narrate', // Ask the companion to speak a contextual line, under the user's voice mode.
  'status.read', // Read a small, sanitized slice of the companion's status.
  'process.spawn', // Start child processes (for example, an audio tool). Shown prominently at consent.
] as const;
export type PluginPermission = typeof pluginPermissions[number];

export const settingTypes = ['string', 'secret', 'select', 'boolean', 'number'] as const;
export type SettingType = typeof settingTypes[number];

export interface SettingHelp {
  text: string;
  url: string;
}

export interface SettingField {
  key: string;
  type: SettingType;
  title: string;
  description?: string;
  required?: boolean;
  default?: string | number | boolean;
  pattern?: string;
  options?: {value: string; label: string}[];
  min?: number;
  max?: number;
  help?: SettingHelp;
}

export interface SpeechProviderContribution {
  id: string;
  name: string;
  description?: string;
}

export interface PluginManifest {
  manifestVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  publisher?: string;
  homepage?: string;
  license?: string;
  api: {major: number; minor: number};
  runtime: 'node';
  main: string;
  permissions: PluginPermission[];
  network: string[];
  contributes: {
    speechProviders: SpeechProviderContribution[];
    settings: SettingField[];
  };
}

export type SettingValues = Record<string, string | number | boolean>;

const idPattern = /^[a-z0-9][a-z0-9-]{1,47}$/;
const keyPattern = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const hostPattern = /^(?=.{1,253}$)(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const maxSettings = 20;
const maxProviders = 4;

export class ManifestError extends Error {}

function fail(message: string): never {
  throw new ManifestError(message);
}

function text(value: unknown, field: string, max: number, required = true): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be text.`);
  if ([...value].length > max) fail(`${field} cannot exceed ${max} characters.`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(`${field} cannot contain control characters.`);
  return value;
}

function httpsUrl(value: unknown, field: string): string {
  const url = text(value, field, 2048)!;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`${field} must be a URL.`);
  }
  if (parsed.protocol !== 'https:') fail(`${field} must use https.`);
  return url;
}

export function parseApiVersion(value: unknown): {major: number; minor: number} {
  const match = typeof value === 'string' ? /^(\d{1,3})\.(\d{1,3})$/.exec(value) : null;
  if (!match) fail('api must be a version such as "1.0".');
  return {major: Number(match[1]), minor: Number(match[2])};
}

// The host runs a plugin built for the same major version and the same or an older minor version.
export function isApiCompatible(needed: {major: number; minor: number},
                                host: {major: number; minor: number} = hostApiVersion): boolean {
  return needed.major === host.major && needed.minor <= host.minor;
}

function parseHelp(value: unknown, field: string): SettingHelp | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') fail(`${field} must be an object with text and url.`);
  const help = value as Record<string, unknown>;
  return {text: text(help.text, `${field}.text`, 80)!, url: httpsUrl(help.url, `${field}.url`)};
}

function parseSetting(value: unknown, index: number, keys: Set<string>): SettingField {
  const where = `contributes.settings[${index}]`;
  if (!value || typeof value !== 'object') fail(`${where} must be an object.`);
  const raw = value as Record<string, unknown>;
  if (typeof raw.key !== 'string' || !keyPattern.test(raw.key)) fail(`${where}.key must be a short identifier.`);
  if (keys.has(raw.key)) fail(`${where}.key "${raw.key}" is used twice.`);
  keys.add(raw.key);
  if (!(settingTypes as readonly unknown[]).includes(raw.type))
    fail(`${where}.type must be one of ${settingTypes.join(', ')}.`);
  const field: SettingField = {
    key: raw.key,
    type: raw.type as SettingType,
    title: text(raw.title, `${where}.title`, 60)!,
    description: text(raw.description, `${where}.description`, 300, false),
    required: raw.required === true ? true : undefined,
    help: parseHelp(raw.help, `${where}.help`),
  };
  if (raw.pattern !== undefined) {
    if (field.type !== 'string' && field.type !== 'secret') fail(`${where}.pattern applies only to text.`);
    field.pattern = text(raw.pattern, `${where}.pattern`, 200);
    try {
      new RegExp(field.pattern!);
    } catch {
      fail(`${where}.pattern is not a valid regular expression.`);
    }
  }
  if (field.type === 'select') {
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 50)
      fail(`${where}.options must list 1 to 50 choices.`);
    field.options = raw.options.map((option, n) => {
      const choice = option as Record<string, unknown>;
      if (!choice || typeof choice !== 'object') fail(`${where}.options[${n}] must be an object.`);
      return {value: text(choice.value, `${where}.options[${n}].value`, 80)!,
              label: text(choice.label, `${where}.options[${n}].label`, 60)!};
    });
  } else if (raw.options !== undefined) {
    fail(`${where}.options applies only to select settings.`);
  }
  if (field.type === 'number') {
    for (const bound of ['min', 'max'] as const) {
      if (raw[bound] === undefined) continue;
      if (typeof raw[bound] !== 'number' || !Number.isFinite(raw[bound])) fail(`${where}.${bound} must be a number.`);
      field[bound] = raw[bound] as number;
    }
  }
  if (raw.default !== undefined) {
    if (field.type === 'secret') fail(`${where} is a secret, so it cannot have a default.`);
    field.default = raw.default as SettingField['default'];
    const problem = settingProblem(field, raw.default);
    if (problem) fail(`${where}.default: ${problem}`);
  }
  return field;
}

function parseProviders(value: unknown): SpeechProviderContribution[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxProviders)
    fail(`contributes.speechProviders must list at most ${maxProviders} providers.`);
  const ids = new Set<string>();
  return value.map((entry, index) => {
    const where = `contributes.speechProviders[${index}]`;
    const raw = entry as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') fail(`${where} must be an object.`);
    if (typeof raw.id !== 'string' || !idPattern.test(raw.id)) fail(`${where}.id must be lowercase letters, digits and dashes.`);
    if (ids.has(raw.id)) fail(`${where}.id "${raw.id}" is used twice.`);
    ids.add(raw.id);
    return {id: raw.id, name: text(raw.name, `${where}.name`, 40)!,
            description: text(raw.description, `${where}.description`, 200, false)};
  });
}

// Checks a manifest's JSON. `folder` is the plugin's folder name, which must match its id.
export function parsePluginManifest(json: unknown, folder?: string): PluginManifest {
  if (!json || typeof json !== 'object' || Array.isArray(json)) fail('The manifest must be a JSON object.');
  const raw = json as Record<string, unknown>;
  if (raw.manifestVersion !== 1) fail('manifestVersion must be 1.');
  if (typeof raw.id !== 'string' || !idPattern.test(raw.id))
    fail('id must be 2 to 48 lowercase letters, digits and dashes.');
  if (folder !== undefined && folder !== raw.id) fail(`The plugin folder must be named "${raw.id}".`);
  if (typeof raw.version !== 'string' || !semverPattern.test(raw.version)) fail('version must be a semantic version.');
  if (raw.runtime !== 'node') fail('runtime must be "node".');
  const main = text(raw.main, 'main', 200)!;
  if (isAbsolute(main) || main.split(/[\\/]/).includes('..')) fail('main must be a path inside the plugin folder.');
  const api = parseApiVersion(raw.api);
  if (!Array.isArray(raw.permissions ?? [])) fail('permissions must be a list.');
  const permissions = [...new Set((raw.permissions ?? []) as unknown[])].map(permission => {
    if (!(pluginPermissions as readonly unknown[]).includes(permission))
      fail(`Unknown permission "${String(permission)}".`);
    return permission as PluginPermission;
  });
  if (!Array.isArray(raw.network ?? [])) fail('network must be a list of host names.');
  const network = [...new Set((raw.network ?? []) as unknown[])].map(host => {
    if (typeof host !== 'string' || !hostPattern.test(host)) fail(`network host "${String(host)}" is not a host name.`);
    return host;
  });
  const contributes = (raw.contributes ?? {}) as Record<string, unknown>;
  if (typeof contributes !== 'object') fail('contributes must be an object.');
  const settingsRaw = contributes.settings ?? [];
  if (!Array.isArray(settingsRaw) || settingsRaw.length > maxSettings)
    fail(`contributes.settings must list at most ${maxSettings} settings.`);
  const keys = new Set<string>();
  const speechProviders = parseProviders(contributes.speechProviders);
  if (speechProviders.length && !permissions.includes('speech.provide'))
    fail('A plugin that contributes speech providers needs the speech.provide permission.');
  return {
    manifestVersion: 1,
    id: raw.id,
    name: text(raw.name, 'name', 60)!,
    version: raw.version,
    description: text(raw.description, 'description', 300)!,
    publisher: text(raw.publisher, 'publisher', 60, false),
    homepage: raw.homepage === undefined ? undefined : httpsUrl(raw.homepage, 'homepage'),
    license: text(raw.license, 'license', 40, false),
    api,
    runtime: 'node',
    main,
    permissions,
    network,
    contributes: {
      speechProviders,
      settings: settingsRaw.map((setting, index) => parseSetting(setting, index, keys)),
    },
  };
}

// Reads and checks <folder>/agent-buddy.plugin.json, and that "main" stays inside the folder.
export function loadPluginManifest(folder: string, expectId = true): PluginManifest {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(join(folder, manifestFileName), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(`No ${manifestFileName} in the plugin folder.`);
    fail(`${manifestFileName} is not valid JSON.`);
  }
  const name = resolve(folder).split(sep).pop();
  const manifest = parsePluginManifest(json, expectId ? name : undefined);
  const entry = resolve(folder, manifest.main);
  let real: string;
  try {
    real = realpathSync(entry);
    if (!statSync(real).isFile()) fail(`main "${manifest.main}" is not a file.`);
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    fail(`main "${manifest.main}" does not exist. Build the plugin first.`);
  }
  const inside = relative(realpathSync(folder), real);
  if (inside.startsWith('..') || isAbsolute(inside)) fail('main must not point outside the plugin folder.');
  return manifest;
}

// Why a value does not suit a setting, or null when it does. Secrets are checked like text.
export function settingProblem(field: SettingField, value: unknown): string | null {
  switch (field.type) {
    case 'string':
    case 'secret':
      if (typeof value !== 'string') return 'must be text';
      if ([...value].length > 4096) return 'is too long';
      if (field.pattern && value !== '' && !new RegExp(field.pattern).test(value)) return 'is not in the expected format';
      return null;
    case 'select':
      return typeof value === 'string' && field.options!.some(option => option.value === value)
        ? null : 'is not one of the choices';
    case 'boolean':
      return typeof value === 'boolean' ? null : 'must be true or false';
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'must be a number';
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
  }
}

// Checks a settings change. A secret set to null is cleared; a missing key leaves the stored value alone.
export function validateSettingChange(manifest: PluginManifest, change: unknown): Record<string, unknown> {
  if (!change || typeof change !== 'object' || Array.isArray(change)) fail('Settings must be an object.');
  const fields = new Map(manifest.contributes.settings.map(field => [field.key, field]));
  for (const [key, value] of Object.entries(change)) {
    const field = fields.get(key);
    if (!field) fail(`"${key}" is not a setting of ${manifest.name}.`);
    if (value === null) continue;
    const problem = settingProblem(field, value);
    if (problem) fail(`${field.title} ${problem}.`);
  }
  return change as Record<string, unknown>;
}

export function settingDefaults(manifest: PluginManifest): SettingValues {
  const values: SettingValues = {};
  for (const field of manifest.contributes.settings)
    if (field.default !== undefined) values[field.key] = field.default;
  return values;
}

// Settings that are required but have no value yet.
export function missingSettings(manifest: PluginManifest, values: SettingValues): SettingField[] {
  return manifest.contributes.settings.filter(field =>
    field.required && (values[field.key] === undefined || values[field.key] === ''));
}
