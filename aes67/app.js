const loginScreen = document.getElementById('login-screen');
const dashboardScreen = document.getElementById('dashboard-screen');
const loginBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const loginError = document.getElementById('login-error');
const deviceAddressSpan = document.getElementById('device-address');

const inputStreamsTableBody = document.querySelector('#input-streams-table tbody');
const connectedInputsTableBody = document.querySelector('#connected-inputs-table tbody');
const outputStreamsTableBody = document.querySelector('#output-streams-table tbody');

const refreshInputsBtn = document.getElementById('refresh-inputs-btn');
const refreshConnectedInputsBtn = document.getElementById('refresh-connected-inputs-btn');
const refreshOutputsBtn = document.getElementById('refresh-outputs-btn');

const editModal = document.getElementById('edit-modal');
const editChannelId = document.getElementById('edit-channel-id');
const editName = document.getElementById('edit-name');
const editIp3 = document.getElementById('edit-ip-3');
const editIp4 = document.getElementById('edit-ip-4');
const saveOutputBtn = document.getElementById('save-output-btn');
const cancelEditBtn = document.getElementById('cancel-edit-btn');

const state = {
  xapi: null,
  deviceAddress: '',
  connectedStreamsCache: [],
  connectedChannelIdsCache: [],
  protectedInputChannels: new Set(),
  protectedOutputChannels: new Set(),
  vuOff: null,
};

const VU_METER_CONNECTOR_TYPE = 'Ethernet';
const VU_METER_SOURCE = 'BeforeAEC';
const PROTECTED_MEDIA_IPS = new Set(['239.0.1.1']);
const PROTECTED_INPUT_MAC_PREFIXES = ['1096c6'];
const PROTECTED_DEVICE_MACS = new Set([
  '01005e000101',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

loginBtn.addEventListener('click', handleLogin);
disconnectBtn.addEventListener('click', handleDisconnect);
refreshInputsBtn.addEventListener('click', fetchInputStreams);
refreshConnectedInputsBtn.addEventListener('click', fetchConnectedInputs);
refreshOutputsBtn.addEventListener('click', fetchOutputStreams);
saveOutputBtn.addEventListener('click', saveOutputConfig);
cancelEditBtn.addEventListener('click', () => editModal.classList.remove('active'));

for (const id of ['password', 'username', 'device-ip']) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      handleLogin();
    }
  });
}

function ensureConnected() {
  if (!state.xapi) {
    throw new Error('Not connected to a device');
  }
  return state.xapi;
}

function normalizeMac(value) {
  if (!value) {
    return '';
  }

  return String(value).toLowerCase().replace(/[^a-f0-9]/g, '');
}

function collectMacCandidates(value, bucket = []) {
  if (!value) {
    return bucket;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectMacCandidates(item, bucket));
    return bucket;
  }

  if (typeof value !== 'object') {
    if (typeof value === 'string' && /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i.test(value)) {
      bucket.push(value);
    }
    return bucket;
  }

  Object.entries(value).forEach(([key, val]) => {
    if (/mac/i.test(key) && val) {
      bucket.push(val);
    }
    collectMacCandidates(val, bucket);
  });

  return bucket;
}

function isProtectedOutput(channel) {
  if (!channel || typeof channel !== 'object') {
    return false;
  }

  if (PROTECTED_MEDIA_IPS.has(channel.MediaIP)) {
    return true;
  }

  const candidates = collectMacCandidates(channel);
  return candidates.some((candidate) => PROTECTED_DEVICE_MACS.has(normalizeMac(candidate)));
}

function isProtectedInput(channel) {
  if (!channel || typeof channel !== 'object') {
    return false;
  }

  const candidates = collectMacCandidates(channel).map(normalizeMac).filter(Boolean);
  return candidates.some((mac) => PROTECTED_INPUT_MAC_PREFIXES.some((prefix) => mac.startsWith(prefix)));
}

async function handleLogin() {
  const ip = document.getElementById('device-ip').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();

  if (!ip || !username || !password) {
    showError('Please fill in all fields.');
    return;
  }

  if (!window.jsxapi || typeof window.jsxapi.connect !== 'function') {
    showError('JSXAPI failed to load.');
    return;
  }

  showError('');
  loginBtn.textContent = 'Connecting...';
  loginBtn.disabled = true;

  const target = ip.includes('://') ? ip : `wss://${ip}`;

  try {
    const xapi = await connectWithTimeout(target, username, password, 10000);
    state.xapi = xapi;
    state.deviceAddress = ip;

    await enforceMandatoryCodecConfig();
    await startVuMeters();

    loginScreen.classList.remove('active');
    dashboardScreen.classList.add('active');
    deviceAddressSpan.textContent = state.deviceAddress;

    await loadInitialData();
  } catch (err) {
    showError(`Connection failed: ${err.message}`);
    loginBtn.textContent = 'Connect';
    loginBtn.disabled = false;
  }
}

function connectWithTimeout(target, username, password, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const connection = window.jsxapi.connect(target, {
      username,
      password,
      rejectUnauthorized: false,
    });

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        connection.close();
      } catch (_e) {
      }
      reject(new Error('Connection timed out. Check host, network, and WSS accessibility.'));
    }, timeoutMs);

    connection.on('error', (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      reject(new Error(err && err.message ? err.message : 'Unknown connection error'));
    });

    connection.on('ready', (xapi) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolve(xapi);
    });
  });
}

async function enforceMandatoryCodecConfig() {
  const xapi = ensureConnected();

  const sapMode = await xapi.Config.Audio.Ethernet.SAPDiscovery.Mode.get();
  const encryption = await xapi.Config.Audio.Ethernet.Encryption.get();

  if (sapMode === 'On' && encryption === 'Optional') {
    return;
  }

  const confirmed = await showDialog(
    'confirm',
    'Required Settings',
    'This tool requires "AES67 SAP Discovery" to be ON and "AES67 Encryption" to be OPTIONAL.<br><br>Allow this app to update those settings now?'
  );

  if (!confirmed) {
    await handleDisconnect();
    throw new Error('Codec settings were not accepted.');
  }

  if (sapMode !== 'On') {
    await xapi.Config.Audio.Ethernet.SAPDiscovery.Mode.set('On');
  }

  if (encryption !== 'Optional') {
    await xapi.Config.Audio.Ethernet.Encryption.set('Optional');
  }

  showToast('Codec configured for AES67 automatically.');
}

async function startVuMeters() {
  const xapi = ensureConnected();

  try {
    await xapi.Command.Audio.VuMeter.StopAll();
  } catch (_e) {
  }

  for (let i = 1; i <= 8; i += 1) {
    try {
      await xapi.Command.Audio.VuMeter.Start({
        ConnectorId: i,
        ConnectorType: VU_METER_CONNECTOR_TYPE,
        Source: VU_METER_SOURCE,
      });
    } catch (_e) {
    }
  }

  if (state.vuOff) {
    try {
      state.vuOff();
    } catch (_e) {
    }
  }

  state.vuOff = xapi.Event.Audio.Input.Connectors.Ethernet.on((event) => {
    const connectorId = event && event.id;
    if (!connectorId) {
      return;
    }

    const subIds = Array.isArray(event.SubId) ? event.SubId : [event.SubId];
    let maxVu = 0;

    for (const sub of subIds) {
      if (!sub || !sub.VuMeter) {
        continue;
      }
      const value = parseInt(sub.VuMeter, 10);
      if (!Number.isNaN(value) && value > maxVu) {
        maxVu = value;
      }
    }

    const bar = document.getElementById(`vu-bar-${connectorId}`);
    if (!bar) {
      return;
    }

    const percentage = Math.min(100, Math.max(0, maxVu * 2));
    bar.style.width = `${100 - percentage}%`;
  });
}

async function handleDisconnect() {
  if (state.vuOff) {
    try {
      state.vuOff();
    } catch (_e) {
    }
    state.vuOff = null;
  }

  if (state.xapi) {
    try {
      await state.xapi.Command.Audio.VuMeter.StopAll();
    } catch (_e) {
    }

    try {
      state.xapi.close();
    } catch (_e) {
    }
  }

  state.xapi = null;
  window.location.reload();
}

function showError(msg) {
  loginError.textContent = msg;
}

async function loadInitialData() {
  await fetchConnectedInputs();
  await Promise.all([fetchInputStreams(), fetchOutputStreams()]);
}

async function fetchConnectedInputs() {
  connectedInputsTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center">Loading...</td></tr>';

  try {
    const xapi = ensureConnected();
    let channels = await xapi.Status.Audio.Input.Connectors.Ethernet.get();
    if (!Array.isArray(channels)) {
      channels = channels ? [channels] : [];
    }

    state.connectedStreamsCache = [];
    state.connectedChannelIdsCache = [];

    for (const ch of channels) {
      const streamName = ch.StreamName || (ch.Connect ? ch.Connect.Name : null) || '';
      if (streamName) {
        state.connectedStreamsCache.push(streamName);
        if (ch.id) {
          state.connectedChannelIdsCache.push(ch.id.toString());
        }
      }
    }

    renderConnectedInputs(channels);
  } catch (err) {
    connectedInputsTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:#b7372f">Error: ${err.message}</td></tr>`;
  }
}

function renderConnectedInputs(channels) {
  connectedInputsTableBody.innerHTML = '';
  state.protectedInputChannels.clear();

  if (channels.length === 0) {
    connectedInputsTableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#536a80">No inputs connected</td></tr>';
    return;
  }

  for (const ch of channels) {
    const streamName = ch.StreamName || (ch.Connect ? ch.Connect.Name : null) || '-';
    const isProtected = isProtectedInput(ch);
    const displayName = isProtected ? 'Cisco Microphone' : streamName;
    const isConnected = streamName !== '-' && streamName !== '';

    if (isProtected && ch.id) {
      state.protectedInputChannels.add(String(ch.id));
    }

    const actionHtml = isConnected
      ? (isProtected
        ? '<span class="badge" style="background-color: #666; color: #ccc; cursor: not-allowed;" title="Protected Device">Protected</span>'
        : `<button class="action-btn secondary-btn" onclick="disconnectInput('${ch.id}')">Disconnect</button>`)
      : '-';

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${ch.id || '-'}</td>
      <td>${displayName}</td>
      <td><span class="badge ${isConnected ? 'connected' : 'disconnected'}">${isConnected ? 'Connected' : 'Disconnected'}</span></td>
      <td>
        <div class="vu-meter-container">
          <div id="vu-bar-${ch.id}" class="vu-meter-bar-mask" style="width:100%"></div>
        </div>
      </td>
      <td>${actionHtml}</td>
    `;

    connectedInputsTableBody.appendChild(tr);
  }
}

async function fetchInputStreams() {
  inputStreamsTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center">Loading...</td></tr>';

  try {
    const xapi = ensureConnected();
    let streams = await xapi.Status.Audio.Input.Ethernet.DiscoveredStream.get();
    if (!Array.isArray(streams)) {
      streams = streams ? [streams] : [];
    }
    renderInputStreams(streams);
  } catch (err) {
    inputStreamsTableBody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:#b7372f">Error: ${err.message}</td></tr>`;
  }
}

function renderInputStreams(streams) {
  inputStreamsTableBody.innerHTML = '';

  if (streams.length === 0) {
    inputStreamsTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#536a80">No streams discovered</td></tr>';
    return;
  }

  for (const stream of streams) {
    const isAlreadyConnected = state.connectedStreamsCache.includes(stream.Name);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${stream.id || '-'}</td>
      <td>${stream.Name || '-'}</td>
      <td>${stream.MediaIP || '-'}</td>
      <td>${stream.OriginIP || '-'}</td>
      <td>${stream.Channels || '-'}</td>
      <td>
        ${isAlreadyConnected ? '<span class="badge connected">Connected</span>' : `<button class="action-btn" onclick="connectInput('${(stream.Name || '').replace(/'/g, '&#39;')}')">Connect</button>`}
      </td>
    `;

    inputStreamsTableBody.appendChild(tr);
  }
}

window.connectInput = async (name) => {
  const channel = await showDialog('channel-picker', 'Connect Stream', `Select a channel for stream "<b>${name}</b>":`);

  if (channel === null) {
    return;
  }

  try {
    const xapi = ensureConnected();
    const args = { StreamName: name };

    if (channel.trim() !== '') {
      args.ConnectorId = parseInt(channel, 10);
    }

    await xapi.Command.Audio.LocalInput.Ethernet.Register(args);
    showToast('Connected successfully');
    await sleep(900);
    await fetchConnectedInputs();
    await fetchInputStreams();
  } catch (err) {
    await showDialog('alert', 'Error', `Failed to connect: ${err.message}`);
  }
};

window.disconnectInput = async (channelId) => {
  if (state.protectedInputChannels.has(String(channelId))) {
    await showDialog('alert', 'Protected Device', `Channel ${channelId} is a protected Cisco Microphone and cannot be removed.`);
    return;
  }

  const confirmed = await showDialog('confirm', 'Disconnect', `Disconnect channel ${channelId}?`);
  if (!confirmed) {
    return;
  }

  try {
    const xapi = ensureConnected();
    await xapi.Command.Audio.LocalInput.Ethernet.Deregister({ ConnectorId: parseInt(channelId, 10) });
    showToast('Disconnected successfully');
    await sleep(900);
    await fetchConnectedInputs();
    await fetchInputStreams();
  } catch (err) {
    await showDialog('alert', 'Error', `Failed to disconnect: ${err.message}`);
  }
};

async function fetchOutputStreams() {
  outputStreamsTableBody.innerHTML = '<tr><td colspan="4" style="text-align:center">Loading...</td></tr>';

  try {
    const xapi = ensureConnected();
    let channels = await xapi.Status.Audio.Output.Connectors.Ethernet.get();
    if (!Array.isArray(channels)) {
      channels = channels ? [channels] : [];
    }
    renderOutputStreams(channels);
  } catch (err) {
    outputStreamsTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#b7372f">Error: ${err.message}</td></tr>`;
  }
}

function renderOutputStreams(channels) {
  outputStreamsTableBody.innerHTML = '';
  state.protectedOutputChannels.clear();
  const foundIds = channels.map((c) => parseInt(c.id, 10)).filter((n) => !Number.isNaN(n));
  const maxId = Math.max(4, ...foundIds);

  for (let i = 1; i <= maxId; i += 1) {
    const id = i.toString();
    const channel = channels.find((c) => c.id == id) || {};
    const name = channel.StreamName || '-';
    const ip = channel.MediaIP || '-';
    const isConfigured = name !== '-' && ip !== '-';
    const isProtected = isProtectedOutput(channel);

    if (isProtected) {
      state.protectedOutputChannels.add(id);
    }

    const tr = document.createElement('tr');

    let actionsHtml = '';
    if (isProtected) {
      actionsHtml = '<span class="badge" style="background:#eceef2;color:#606f83;border:1px solid #c8d3df">Protected</span>';
    } else if (isConfigured) {
      const safeName = String(name).replace(/'/g, '&#39;');
      const safeIp = String(ip).replace(/'/g, '&#39;');
      actionsHtml = `
        <button class="action-btn secondary-btn" onclick="openEditModal('${id}', '${safeName}', '${safeIp}')">Edit</button>
        <button class="action-btn danger-btn" onclick="removeOutput('${id}')">Remove</button>
      `;
    } else {
      actionsHtml = `<button class="action-btn" onclick="openEditModal('${id}', '', '')">Add</button>`;
    }

    tr.innerHTML = `
      <td>${id}</td>
      <td>${name}</td>
      <td>${ip}</td>
      <td>${actionsHtml}</td>
    `;

    outputStreamsTableBody.appendChild(tr);
  }
}

window.openEditModal = (id, name, ip) => {
  editChannelId.value = id;
  editName.value = name;

  if (ip) {
    const match = ip.match(/^239\.69\.([0-9]{1,3})\.([0-9]{1,3})$/);
    if (match) {
      editIp3.value = match[1];
      editIp4.value = match[2];
    } else {
      editIp3.value = '';
      editIp4.value = '';
    }
  } else {
    editIp3.value = '';
    editIp4.value = '';
  }

  const heading = document.querySelector('#edit-modal h3');
  if (!name && !ip) {
    heading.textContent = `Add Output Stream (Channel ${id})`;
  } else {
    heading.textContent = `Edit Output Stream (Channel ${id})`;
  }

  editModal.classList.add('active');
};

window.removeOutput = async (id) => {
  if (state.protectedOutputChannels.has(String(id))) {
    await showDialog('alert', 'Protected Stream', `Channel ${id} is protected and cannot be removed.`);
    return;
  }

  const confirmed = await showDialog('confirm', 'Remove Output', `Remove output stream on channel ${id}?`);
  if (!confirmed) {
    return;
  }

  try {
    const xapi = ensureConnected();
    await xapi.Command.Audio.LocalOutput.Ethernet.Deregister({ ConnectorId: parseInt(id, 10) });
    showToast('Output stream removed');
    await sleep(900);
    await fetchOutputStreams();
  } catch (err) {
    await showDialog('alert', 'Error', `Failed to remove: ${err.message}`);
  }
};

async function saveOutputConfig() {
  const channel = editChannelId.value;
  if (state.protectedOutputChannels.has(String(channel))) {
    await showDialog('alert', 'Protected Stream', `Channel ${channel} is protected and cannot be edited.`);
    return;
  }

  const name = editName.value.trim();
  if (!name) {
    await showDialog('alert', 'Error', 'Output stream name is required.');
    return;
  }

  const octet3 = editIp3.value.trim();
  const octet4 = editIp4.value.trim();

  const isValid3 = octet3 !== '' && Number(octet3) >= 0 && Number(octet3) <= 255;
  const isValid4 = octet4 !== '' && Number(octet4) >= 0 && Number(octet4) <= 255;

  if (!isValid3 || !isValid4) {
    await showDialog('alert', 'Error', 'Both IP octets must be numbers between 0 and 255.');
    return;
  }

  const ipAddress = `239.69.${octet3}.${octet4}`;

  saveOutputBtn.disabled = true;
  saveOutputBtn.textContent = 'Saving...';

  try {
    const xapi = ensureConnected();

    try {
      await xapi.Command.Audio.LocalOutput.Ethernet.Deregister({ ConnectorId: parseInt(channel, 10) });
    } catch (_e) {
    }

    await xapi.Command.Audio.LocalOutput.Ethernet.Register({
      StreamName: name,
      MediaIp: ipAddress,
      Channels: 1,
    });

    editModal.classList.remove('active');
    showToast('Configuration saved');
    await sleep(900);
    await fetchOutputStreams();
  } catch (err) {
    await showDialog('alert', 'Error', `Failed to save: ${err.message}`);
  } finally {
    saveOutputBtn.disabled = false;
    saveOutputBtn.textContent = 'Save';
  }
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 3000);
}

function showDialog(type, title, message, defaultValue = '') {
  return new Promise((resolve) => {
    const modal = document.getElementById('dialog-modal');
    const titleEl = document.getElementById('dialog-title');
    const msgEl = document.getElementById('dialog-message');
    const inputContainer = document.getElementById('dialog-input-container');
    const optionsContainer = document.getElementById('dialog-options-container');
    const input = document.getElementById('dialog-input');
    const okBtn = document.getElementById('dialog-ok-btn');
    const cancelBtn = document.getElementById('dialog-cancel-btn');

    titleEl.textContent = title;
    msgEl.innerHTML = message;
    input.value = defaultValue;

    inputContainer.style.display = 'none';
    optionsContainer.style.display = 'none';
    optionsContainer.className = 'dialog-options-container';
    optionsContainer.innerHTML = '';
    cancelBtn.style.display = 'none';
    okBtn.style.display = 'inline-block';

    const close = (value) => {
      modal.classList.remove('active');
      resolve(value);
    };

    okBtn.onclick = null;
    cancelBtn.onclick = null;

    if (type === 'alert') {
      okBtn.textContent = 'OK';
      okBtn.onclick = () => close(true);
    } else if (type === 'confirm') {
      okBtn.textContent = 'Yes';
      cancelBtn.textContent = 'No';
      cancelBtn.style.display = 'inline-block';
      okBtn.onclick = () => close(true);
      cancelBtn.onclick = () => close(false);
    } else if (type === 'prompt') {
      inputContainer.style.display = 'block';
      cancelBtn.style.display = 'inline-block';
      okBtn.textContent = 'OK';
      cancelBtn.textContent = 'Cancel';
      okBtn.onclick = () => close(input.value);
      cancelBtn.onclick = () => close(null);
      setTimeout(() => input.focus(), 0);
    } else if (type === 'channel-picker') {
      optionsContainer.style.display = 'grid';
      optionsContainer.className = 'dialog-options-grid';

      const autoBtn = document.createElement('button');
      autoBtn.className = 'channel-btn auto';
      autoBtn.textContent = 'Auto (Next Available)';
      autoBtn.onclick = () => close('');
      optionsContainer.appendChild(autoBtn);

      for (let i = 1; i <= 8; i += 1) {
        const btn = document.createElement('button');
        btn.className = 'channel-btn';
        const inUse = state.connectedChannelIdsCache.includes(i.toString());

        if (inUse) {
          btn.textContent = `Ch ${i} (In Use)`;
          btn.disabled = true;
        } else {
          btn.textContent = `Ch ${i}`;
          btn.onclick = () => close(i.toString());
        }

        optionsContainer.appendChild(btn);
      }

      cancelBtn.style.display = 'inline-block';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = () => close(null);
      okBtn.style.display = 'none';
    }

    modal.classList.add('active');
  });
}
