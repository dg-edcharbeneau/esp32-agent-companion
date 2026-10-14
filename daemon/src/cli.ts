#!/usr/bin/env node
import {agentHookTimeoutMs, runDaemon} from './daemon.js';
import {requestDaemon, streamDaemon} from './client.js';
import {characterStates, hookEvents, type HookEvent, type HookPayload} from './protocol.js';
import {characterRequestValue} from './character-pack.js';
import {isConnectionMode} from './connection-mode.js';
import {pairWifi} from './wifi-config.js';
import {defaultAgentContext, normalizeAgentHook, shouldIgnoreGrokClaudeHook, type AgentId} from './agents/index.js';
import {cursorHookResponse} from './agents/cursor.js';
import {agentRunsHeadless} from './agents/headless.js';
import {isAgentId} from './agents/types.js';
import {isVoiceNotificationMode} from './voice-notifications.js';
import {addPlugin, removePlugin} from './plugin-install.js';
import type {PluginInfo} from './plugin-host.js';
import {createInterface} from 'node:readline';

async function main(): Promise<void> {
  const [command, argument, file, ...options] = process.argv.slice(2);
  if (command === 'daemon') {
    // A daemon that cannot start (for example, another one holds the socket) ends at once. Its
    // timers would keep it alive otherwise, and the service manager would count it as running.
    await runDaemon().catch(error => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
    return;
  }
  if (command === 'status') {
    // The first status after startup probes each agent's version, which can take a second or two.
    console.log(JSON.stringify(await requestDaemon({type: 'status'}, 5000), null, 2));
    return;
  }
  if (command === 'send' && characterStates.includes(argument as never)) {
    console.log(JSON.stringify(await requestDaemon({type: 'send', state: argument as typeof characterStates[number]})));
    return;
  }
  if (command === 'speak') {
    const text = [argument, file, ...options].filter((value): value is string => value !== undefined).join(' ');
    const response = checked(await requestDaemon({type: 'speak', text}, 60_000));
    console.log(JSON.stringify(response));
    return;
  }
  if (command === 'narrate') {
    const text = [argument, file, ...options].filter((value): value is string => value !== undefined).join(' ');
    const response = checked(await requestDaemon({type: 'narrate', text}, 60_000));
    console.log(JSON.stringify(response));
    return;
  }
  if (command === 'hook') {
    let cursorEvent: string | undefined;
    let responded = false;
    const allowCursor = () => {
      if (cursorEvent === undefined || responded) return;
      responded = true;
      process.stdout.write(cursorHookResponse(cursorEvent));
    };
    try {
      const parsed = parseHookArguments(argument, file);
      if (!parsed) return;
      if (parsed.agent === 'cursor') cursorEvent = parsed.nativeEvent ?? '';
      const input = await readStdin(4 * 1024 * 1024);
      allowCursor();
      const payload = input.trim() ? parseHookPayload(input) : {};
      if (parsed.agent === 'claude' && shouldIgnoreGrokClaudeHook(process.env, payload, defaultAgentContext().home)) return;
      let headless: boolean | undefined;
      const hooks = normalizeAgentHook(parsed.agent, parsed.nativeEvent, payload)
        .filter(hook => hook.event !== 'notification' || !(headless ??= agentRunsHeadless(parsed.agent)));
      for (const hook of hooks) await requestDaemon({type: 'hook', agent: parsed.agent, event: hook.event, payload: hook.payload}, 300);
    } catch {
      // Hooks are notifications only; a missing device or daemon must never block the agent.
      // Cursor blocks a permission hook that prints nothing, so answer before giving up.
      allowCursor();
    }
    return;
  }
  if (command === 'agents') {
    if (!argument) {
      console.log(JSON.stringify(await requestDaemon({type: 'agents'}, 2000), null, 2));
      return;
    }
    if ((argument === 'enable' || argument === 'disable') && isAgentId(file)) {
      console.log(JSON.stringify(checked(await requestDaemon(
        {type: 'agentEnable', agent: file, enabled: argument === 'enable'}, 5000)), null, 2));
      return;
    }
    if ((argument === 'install' || argument === 'uninstall') && isAgentId(file)) {
      console.log(JSON.stringify(checked(await requestDaemon({
        type: argument === 'install' ? 'agentInstall' : 'agentUninstall',
        agent: file,
      }, agentHookTimeoutMs + 1000)), null, 2));
      return;
    }
    throw new Error('Usage: agent-companion agents [enable|disable|install|uninstall AGENT]');
  }
  if (command === 'settings') {
    console.log(JSON.stringify(await requestDaemon({type: 'settings'})));
    return;
  }
  if (command === 'badges') {
    if (argument !== 'on' && argument !== 'off') throw new Error('Usage: agent-companion badges on|off');
    const enabled = argument === 'on';
    console.log(JSON.stringify(checked(await requestDaemon({type: 'badges', enabled}, 2000))));
    return;
  }
  if (command === 'voice') {
    if (!isVoiceNotificationMode(argument))
      throw new Error('Usage: agent-companion voice off|milestones|chatty|contextual');
    console.log(JSON.stringify(checked(await requestDaemon({type: 'voice', mode: argument}, 2000))));
    return;
  }
  if (command === 'speech') {
    if (!argument) {
      const status = await requestDaemon({type: 'status'}, 5000) as {
        voice?: {provider?: string}; speech?: {providers?: {key: string; name: string; available: boolean; reason?: string}[]}};
      for (const provider of status.speech?.providers ?? []) {
        const mark = provider.key === status.voice?.provider ? '*' : ' ';
        console.log(`${mark} ${provider.key.padEnd(28)} ${provider.name}${provider.available ? '' : ` (${provider.reason})`}`);
      }
      return;
    }
    console.log(JSON.stringify(checked(await requestDaemon({type: 'speech', provider: argument}, 2000))));
    return;
  }
  if (command === 'plugin') {
    await pluginCommand(argument, file, options);
    return;
  }
  if (command === 'list-characters') {
    // Listing can wait on a character pack rebuild after an update.
    console.log(JSON.stringify(await requestDaemon({type: 'listCharacters'}, 30_000)));
    return;
  }
  if (command === 'connection') {
    if (!argument) {
      const status = await requestDaemon({type: 'status'}, 5000) as {mode?: string};
      console.log(status.mode ?? 'auto');
      return;
    }
    if (!isConnectionMode(argument)) throw new Error('Connection mode must be auto, usb, or wifi.');
    const response = await requestDaemon({type: 'setConnection', mode: argument}, 5000) as {
      ok?: boolean; error?: string};
    if (!response.ok) throw new Error(response.error ?? 'Could not change the connection mode.');
    return;
  }
  if (command === 'setup-character' && argument) {
    // npm runs scripts from daemon/, so resolve relative pack paths from the caller's directory.
    const character = characterRequestValue(argument, process.env.INIT_CWD ?? process.cwd());
    let shown = -1;
    const response = await streamDaemon({type: 'installCharacter', character}, message => {
      const progress = (message as {progress?: unknown}).progress;
      if (typeof progress !== 'number' || (progress < shown + 5 && progress !== 100)) return;
      shown = progress;
      process.stderr.write(`\rInstalling character: ${progress}%`);
    }, 10 * 60 * 1000) as {ok?: boolean; name?: string; transport?: string; error?: string};
    if (shown >= 0) process.stderr.write('\n');
    if (!response.ok) throw new Error(response.error ?? 'Character installation failed.');
    console.log(`Installed ${response.name} over ${response.transport === 'wifi' ? 'Wi-Fi' : 'USB'}. `
        + 'The device is restarting.');
    return;
  }
  if (command === 'pair-wifi' && argument) {
    const hostIndex = [file, ...options].indexOf('--host');
    const values = [file, ...options];
    const host = hostIndex >= 0 ? values[hostIndex + 1] : process.env.AGENT_COMPANION_HOST;
    if (hostIndex >= 0 && !host) throw new Error('--host requires an IP address or hostname.');
    const paired = await pairWifi(argument, host);
    try {
      await requestDaemon({type: 'reloadWifi'});
    } catch {
      // Pairing also works before daemon installation; it will load the file at startup.
    }
    console.log(`Paired Wi-Fi device ${paired.deviceId}.`);
    return;
  }
  if (command === 'setup-wifi' && argument) {
    const password = process.env.AGENT_COMPANION_WIFI_PASSWORD ?? await readSecret('Wi-Fi password: ');
    const response = await requestDaemon(
      {type: 'configureWifi', ssid: argument, password}, 10000) as {
        ok?: boolean;
        deviceId?: string;
        error?: string;
      };
    if (!response.ok) throw new Error(response.error ?? 'Wi-Fi setup failed.');
    console.log(`Configured and paired Wi-Fi device ${response.deviceId}.`);
    return;
  }
  throw new Error(
    'Usage: agent-companion {daemon|status|send STATE|speak TEXT|narrate TEXT|voice off|milestones|chatty|contextual|hook [AGENT] EVENT|agents [enable|disable|install|uninstall AGENT]|setup-wifi SSID|pair-wifi CODE [--host ADDRESS]|setup-character NAME|PATH|connection [auto|usb|wifi]|badges on|off}');
}

function parseHookArguments(first: string | undefined, second: string | undefined):
    {agent: AgentId; nativeEvent: string | undefined} | null {
  if (!first) return null;
  if (hookEvents.includes(first as never)) return {agent: 'copilot', nativeEvent: first};
  if (isAgentId(first)) return {agent: first, nativeEvent: second};
  return null;
}

async function readStdin(limit = Number.POSITIVE_INFINITY): Promise<string> {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    if (input.length < limit) input += chunk.slice(0, Math.max(0, limit - input.length));
  }
  return input;
}

function parseHookPayload(input: string): HookPayload {
  try {
    return JSON.parse(input) as HookPayload;
  } catch {
    const payload: HookPayload = {};
    for (const key of ['session_id', 'sessionId', 'hook_event_name', 'hookEventName', 'tool_name',
      'toolName', 'tool_use_id', 'toolCallId', 'agent_id', 'agentId', 'agent_type', 'agentName',
      'notification_type', 'notificationType']) {
      const match = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,512})"`).exec(input);
      if (match?.[1]) payload[key] = match[1];
    }
    return payload;
  }
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    return (await readStdin()).replace(/\r?\n$/, '');
  process.stdout.write(prompt);
  process.stdin.setEncoding('utf8');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (error?: Error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === '\u0003') {
          finish(new Error('Wi-Fi setup cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = [...value].slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

const pluginUsage = 'Usage: agent-companion plugin list | add FOLDER|GIT-URL | remove ID [--keep-data] '
  + '| enable ID [--yes] | disable ID | restart ID | set ID KEY [VALUE]';

async function pluginList(): Promise<PluginInfo[]> {
  const plugins = await requestDaemon({type: 'plugins'}, 5000);
  if (!Array.isArray(plugins)) checked(plugins);
  return plugins as PluginInfo[];
}

// A running daemon picks up added or removed plugins at once; a stopped one finds them when it starts.
async function reloadPlugins(): Promise<void> {
  try {
    checked(await requestDaemon({type: 'pluginReload'}, 30_000));
  } catch {
    console.log('The companion service is not running; it loads the change when it starts.');
  }
}

async function pluginCommand(action: string | undefined, id: string | undefined, rest: string[]): Promise<void> {
  if (action === 'list' || action === undefined) {
    const plugins = await pluginList();
    if (!plugins.length) console.log('No plugins are installed. Add one with: npm run plugin add FOLDER|GIT-URL');
    for (const plugin of plugins) {
      const note = plugin.problem ?? (plugin.report && plugin.report.state !== 'ready' ? plugin.report.message : '');
      console.log(`${plugin.id.padEnd(24)} ${(plugin.version ?? '?').padEnd(10)} ${plugin.state}${note ? ` - ${note}` : ''}`);
    }
    return;
  }
  if (!id) throw new Error(pluginUsage);
  if (action === 'add') {
    const result = await addPlugin(id);
    const {manifest} = result;
    console.log(result.previousVersion
      ? `Updated ${manifest.name} from ${result.previousVersion} to ${manifest.version}.`
      : `Added ${manifest.name} ${manifest.version}.`);
    await reloadPlugins();
    if (result.needsConsent)
      console.log(`Review and enable it in Settings > Plugins, or run: npm run plugin enable ${manifest.id}`);
    return;
  }
  if (action === 'remove') {
    await removePlugin(id, {keepData: rest.includes('--keep-data')});
    await reloadPlugins();
    console.log(`Removed ${id}.`);
    return;
  }
  const plugin = (await pluginList()).find(entry => entry.id === id);
  if (!plugin) throw new Error(`No plugin named "${id}" is installed.`);
  if (action === 'enable') {
    console.log(`${plugin.name} ${plugin.version} runs as a separate program on this computer, with your user account.`);
    console.log(`Permissions: ${plugin.permissions.join(', ') || 'none'}`);
    console.log(`Network hosts: ${plugin.network.join(', ') || 'none'}`);
    if (!rest.includes('--yes') && !/^y(es)?$/i.test(await ask('Enable it? [y/N] ')))
      throw new Error('Not enabled.');
    const consent = {version: plugin.version ?? '', permissions: plugin.permissions, network: plugin.network};
    const result = await requestDaemon({type: 'pluginEnable', id, consent}, 30_000);
    if (!Array.isArray(result)) checked(result);
    console.log(`${plugin.name} is enabled.`);
    return;
  }
  if (action === 'disable' || action === 'restart') {
    const result = await requestDaemon({type: action === 'disable' ? 'pluginDisable' : 'pluginRestart', id}, 30_000);
    if (!Array.isArray(result)) checked(result);
    console.log(`${plugin.name} ${action === 'disable' ? 'is disabled' : 'restarted'}.`);
    return;
  }
  if (action === 'set') {
    const [key, value] = rest;
    const field = plugin.settings.find(setting => setting.key === key);
    if (!field) throw new Error(`${plugin.name} settings: ${plugin.settings.map(setting => setting.key).join(', ')}`);
    let next: unknown;
    if (field.type === 'secret') {
      // Never from the command line, where it would land in shell history and the process list.
      if (value !== undefined) throw new Error(`Type ${field.title} at the prompt, or pipe it in; don't pass it as an argument.`);
      next = process.stdin.isTTY ? await ask(`${field.title}: `, true) : (await readStdin(4096)).trim();
      if (!next) next = null;
    } else {
      if (value === undefined) throw new Error(`Usage: agent-companion plugin set ${id} ${key} VALUE`);
      next = field.type === 'number' ? Number(value) : field.type === 'boolean' ? value === 'true' : value;
    }
    const result = await requestDaemon({type: 'pluginSet', id, values: {[key!]: next}}, 5000);
    if (!Array.isArray(result)) checked(result);
    console.log(`${field.title} ${next === null ? 'removed' : 'saved'}.`);
    return;
  }
  throw new Error(pluginUsage);
}

// Asks on the terminal. A hidden prompt echoes nothing, for secrets.
function ask(question: string, hidden = false): Promise<string> {
  return new Promise(resolve => {
    const prompt = createInterface({input: process.stdin, output: process.stdout, terminal: true});
    if (hidden) {
      const write = (prompt as unknown as {_writeToOutput: (text: string) => void})._writeToOutput;
      (prompt as unknown as {_writeToOutput: (text: string) => void})._writeToOutput = text => {
        if (text.includes(question)) write.call(prompt, question);
      };
    }
    prompt.question(question, answer => {
      prompt.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// The daemon reports failures as {ok: false, error}; surface them as a non-zero exit.
function checked(response: unknown): unknown {
  const result = response as {ok?: unknown; error?: unknown} | null;
  if (!result || typeof result !== 'object' || Object.keys(result).length === 0)
    throw new Error('The daemon closed the connection without a result. Check the daemon log for details.');
  if (result.ok === false) throw new Error(typeof result.error === 'string' ? result.error : 'The daemon reported an error.');
  return response;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
