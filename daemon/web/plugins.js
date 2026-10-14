// The Plugins tab. Everything a plugin supplies (names, descriptions, setting titles, messages) is
// untrusted, so this builds the page with textContent only and opens only https links.

const permissionText = {
  'speech.provide': 'Turn the companion\'s spoken lines into audio (the text is sent to the plugin)',
  'events.state': 'See when the character changes state (working, needs attention, done)',
  'events.agent': 'See which agent is active and what kind of event happened, never prompts or code',
  'voice.narrate': 'Ask the companion to speak short lines',
  'status.read': 'Read whether the device is connected and the voice setting',
  'process.spawn': 'Start other programs on this computer',
};

const stateText = {
  disabled: 'Disabled', starting: 'Starting', running: 'Running', restarting: 'Restarting', stopped: 'Stopped',
  quarantined: 'Stopped after crashes', needsConsent: 'Needs review', incompatible: 'Needs a newer Agent Buddy',
  broken: 'Cannot load',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeLink(url, text) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const link = element('a', '', text);
  link.href = parsed.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function button(label, className, onClick) {
  const node = element('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

export class PluginsPanel {
  #api;
  #confirm;
  #toast;
  #list;
  #revision = null;
  #loading = null;
  #plugins = [];

  constructor({api, confirm, toast, list}) {
    this.#api = api;
    this.#confirm = confirm;
    this.#toast = toast;
    this.#list = list;
  }

  // Called with each status. Fetches the list only when a plugin changed.
  update(status) {
    const revision = status?.plugins?.revision;
    if (revision === undefined || revision === this.#revision) return;
    this.#revision = revision;
    void this.reload();
  }

  async reload() {
    this.#loading ??= this.#api('/api/plugins').then(plugins => {
      this.#plugins = plugins;
      this.render();
    }).catch(error => this.#toast(error.message, 'error')).finally(() => { this.#loading = null; });
    return this.#loading;
  }

  render() {
    const list = this.#list();
    if (!list) return;
    list.replaceChildren();
    if (!this.#plugins.length) {
      const empty = element('li', 'plugin empty');
      empty.append(element('p', 'hint', 'No plugins are installed. Add one from a terminal with '),
                   element('code', '', 'npm run plugin add <folder or git URL>'));
      list.append(empty);
      return;
    }
    for (const plugin of this.#plugins) list.append(this.#card(plugin));
  }

  #card(plugin) {
    const item = element('li', `plugin${plugin.enabled ? '' : ' disabled'}`);
    const body = element('div', 'plugin-body');
    const title = element('strong', '', plugin.name);
    const pill = element('span', `badge plugin-state ${plugin.state}`, stateText[plugin.state] ?? plugin.state);
    const meta = element('p', 'hint',
      [plugin.version && `v${plugin.version}`, plugin.publisher].filter(Boolean).join(' · '));
    body.append(title, pill, meta);
    if (plugin.description) body.append(element('p', 'hint', plugin.description));
    if (plugin.homepage) {
      const link = safeLink(plugin.homepage, 'Homepage');
      if (link) body.append(link);
    }
    const message = plugin.problem ?? (plugin.report?.state !== 'ready' ? plugin.report?.message : null);
    if (message) {
      const note = element('p', `hint plugin-message${plugin.problem ? ' problem' : ''}`, message);
      note.setAttribute('role', 'status');
      body.append(note);
    }
    if (plugin.settings.length && plugin.state !== 'broken') body.append(this.#settingsForm(plugin));

    const actions = element('div', 'actions agent-actions');
    if (plugin.state === 'broken' || plugin.state === 'incompatible') {
      // Nothing to do here; the message says what to fix.
    } else if (!plugin.enabled || plugin.state === 'needsConsent') {
      actions.append(button(plugin.state === 'needsConsent' ? 'Review' : 'Enable', '', () => void this.#enable(plugin)));
    } else {
      actions.append(button('Disable', 'secondary', () => void this.#action(plugin, 'disable', `${plugin.name} is disabled.`)));
    }
    if (plugin.enabled && ['quarantined', 'running', 'restarting', 'stopped'].includes(plugin.state))
      actions.append(button('Restart', 'secondary', () => void this.#action(plugin, 'restart', `${plugin.name} restarted.`)));
    item.append(body, actions);
    return item;
  }

  #settingsForm(plugin) {
    const form = element('form', 'plugin-settings');
    const inputs = new Map();
    for (const field of plugin.settings) {
      const value = plugin.values[field.key];
      const label = element('label', 'field');
      label.append(element('span', '', field.title + (field.required ? ' (required)' : '')));
      let input;
      if (field.type === 'select') {
        input = element('select');
        for (const option of field.options) {
          const choice = element('option', '', option.label);
          choice.value = option.value;
          input.append(choice);
        }
        input.value = value ?? field.default ?? field.options[0]?.value ?? '';
      } else if (field.type === 'boolean') {
        input = element('input');
        input.type = 'checkbox';
        input.checked = value === true;
      } else {
        input = element('input');
        input.type = field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : 'text';
        input.autocomplete = 'off';
        if (field.type === 'secret') {
          // Secrets are never sent back to the page; show only whether one is saved.
          input.placeholder = value?.set ? 'Saved. Type a new value to replace it.' : 'Not set';
        } else if (value !== undefined) {
          input.value = String(value);
        }
      }
      label.append(input);
      if (field.description) label.append(element('span', 'hint', field.description));
      if (field.help) {
        const link = safeLink(field.help.url, field.help.text);
        if (link) label.append(link);
      }
      if (field.type === 'secret' && value?.set) {
        label.append(button('Remove', 'secondary small', () => void this.#save(plugin, {[field.key]: null},
                                                                                `${field.title} removed.`)));
      }
      inputs.set(field, input);
      form.append(label);
    }
    const save = element('button', '', 'Save settings');
    save.type = 'submit';
    form.append(save);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const change = {};
      for (const [field, input] of inputs) {
        if (field.type === 'secret') {
          if (input.value) change[field.key] = input.value;
        } else if (field.type === 'boolean') {
          change[field.key] = input.checked;
        } else if (field.type === 'number') {
          if (input.value !== '') change[field.key] = Number(input.value);
        } else {
          change[field.key] = input.value;
        }
      }
      void this.#save(plugin, change, `${plugin.name} settings saved.`);
    });
    return form;
  }

  async #save(plugin, values, message) {
    try {
      this.#plugins = await this.#api(`/api/plugins/${encodeURIComponent(plugin.id)}/settings`, {
        method: 'POST', type: 'application/json', body: JSON.stringify({values}),
      });
      this.render();
      this.#toast(message, 'success');
    } catch (error) {
      this.#toast(error.message, 'error');
    }
  }

  // Shows exactly what this version asks for; enabling records that consent.
  async #enable(plugin) {
    const asks = plugin.permissions.map(permission => `• ${permissionText[permission] ?? permission}`);
    if (plugin.network.length) asks.push(`• Connect to ${plugin.network.join(', ')}`);
    const accepted = await this.#confirm(
      `${plugin.name} runs as a separate program on this computer, with your user account.`,
      'Enable', null, {
        title: `Enable ${plugin.name}?`, context: 'Plugin', danger: false,
        note: asks.length ? `It asks to:\n${asks.join('\n')}` : 'It asks for no extra permissions.',
      });
    if (!accepted) return;
    try {
      this.#plugins = await this.#api(`/api/plugins/${encodeURIComponent(plugin.id)}/enable`, {
        method: 'POST', type: 'application/json',
        body: JSON.stringify({consent: {version: plugin.version, permissions: plugin.permissions, network: plugin.network}}),
      });
      this.render();
      this.#toast(`${plugin.name} is enabled.`, 'success');
    } catch (error) {
      this.#toast(error.message, 'error');
    }
  }

  async #action(plugin, action, message) {
    try {
      this.#plugins = await this.#api(`/api/plugins/${encodeURIComponent(plugin.id)}/${action}`, {method: 'POST'});
      this.render();
      this.#toast(message, 'success');
    } catch (error) {
      this.#toast(error.message, 'error');
    }
  }
}
