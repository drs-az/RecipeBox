const statusEl = document.getElementById('status');
const vaultPanel = document.getElementById('vaultPanel');
const vaultStatusEl = document.getElementById('vaultStatus');
const videoListEl = document.getElementById('videoList');
const emptyVaultEl = document.getElementById('emptyVault');
const addLinkForm = document.getElementById('addLinkForm');
const titleInput = document.getElementById('videoTitle');
const urlInput = document.getElementById('videoUrl');
const notesInput = document.getElementById('videoNotes');
const lockBtn = document.getElementById('lockBtn');
const installBtn = document.getElementById('installBtn');
const passwordDialog = document.getElementById('passwordDialog');
const passwordForm = document.getElementById('passwordForm');
const passwordInput = document.getElementById('passwordInput');
const confirmPasswordWrap = document.getElementById('confirmPasswordWrap');
const confirmPasswordInput = document.getElementById('confirmPasswordInput');
const passwordDialogTitle = document.getElementById('passwordDialogTitle');
const passwordDialogDescription = document.getElementById('passwordDialogDescription');
const passwordSubmitBtn = document.getElementById('passwordSubmitBtn');
const passwordError = document.getElementById('passwordError');
const cancelPasswordBtn = document.getElementById('cancelPasswordBtn');

const SECRET_SEQUENCE = ['left', 'right', 'center'];
const VAULT_KEY = 'recipeBoxVaultEntries';
const SALT_KEY = 'recipeBoxVaultSalt';
const HASH_KEY = 'recipeBoxVaultHash';
const SECRET_RESET_MS = 2200;
const PBKDF2_ITERATIONS = 150000;

let secretIndex = 0;
let secretTimer = null;
let deferredPrompt = null;
let dialogMode = 'unlock';
let unlocked = false;
let cryptoKey = null;
let decryptedEntries = [];
let pendingSharedUrl = null;

function setStatus(target, message, type = 'info') {
  if (!target) return;
  target.textContent = message || '';
  target.classList.remove('error', 'success');
  if (type === 'error') {
    target.classList.add('error');
  } else if (type === 'success') {
    target.classList.add('success');
  }
}

function supportsEncryption() {
  return typeof window.crypto !== 'undefined' && typeof window.crypto.subtle !== 'undefined';
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function utf8Encode(text) {
  return new TextEncoder().encode(text);
}

async function deriveKeyMaterial(password) {
  return await crypto.subtle.importKey('raw', utf8Encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}

async function deriveEncryptionKey(password, saltBuffer) {
  const keyMaterial = await deriveKeyMaterial(password);
  return await crypto.subtle.deriveKey({
    name: 'PBKDF2',
    salt: saltBuffer,
    iterations: PBKDF2_ITERATIONS,
    hash: 'SHA-256'
  }, keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function derivePasswordHash(password, saltBuffer) {
  const keyMaterial = await deriveKeyMaterial(password);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: saltBuffer,
    iterations: PBKDF2_ITERATIONS,
    hash: 'SHA-256'
  }, keyMaterial, 256);
  return arrayBufferToBase64(bits);
}

function generateId() {
  if (typeof crypto?.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const now = Date.now().toString(16);
  const rand = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16);
  return `${now}-${rand}`;
}

async function encryptEntry(entry) {
  if (!cryptoKey) throw new Error('Vault is locked.');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload = utf8Encode(JSON.stringify(entry));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, payload);
  return {
    id: entry.id,
    iv: arrayBufferToBase64(iv.buffer),
    data: arrayBufferToBase64(encrypted)
  };
}

async function decryptEntry(record) {
  if (!cryptoKey) throw new Error('Vault is locked.');
  const iv = new Uint8Array(base64ToArrayBuffer(record.iv));
  const ciphertext = base64ToArrayBuffer(record.data);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext);
  const text = new TextDecoder().decode(decrypted);
  return JSON.parse(text);
}

async function loadEncryptedRecords() {
  const stored = await idbkv.get(VAULT_KEY);
  if (!Array.isArray(stored)) {
    return [];
  }
  return stored;
}

async function saveEncryptedRecords(records) {
  await idbkv.set(VAULT_KEY, records);
}

function renderVault() {
  videoListEl.innerHTML = '';
  if (!decryptedEntries.length) {
    emptyVaultEl.hidden = false;
    return;
  }
  emptyVaultEl.hidden = true;
  const sorted = [...decryptedEntries].sort((a, b) => b.createdAt - a.createdAt);
  for (const entry of sorted) {
    const li = document.createElement('li');
    li.className = 'video-item';

    const header = document.createElement('div');
    header.className = 'video-item-header';

    const title = document.createElement('h3');
    title.textContent = entry.title || 'Untitled video';
    header.appendChild(title);

    const actions = document.createElement('div');
    actions.className = 'video-actions';

    const openLink = document.createElement('a');
    openLink.href = entry.url;
    openLink.target = '_blank';
    openLink.rel = 'noopener';
    openLink.className = 'btn-link';
    openLink.textContent = 'Open video';

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = 'Remove';
    deleteBtn.addEventListener('click', () => confirmDelete(entry.id));

    actions.append(openLink, deleteBtn);
    header.appendChild(actions);
    li.appendChild(header);

    const meta = document.createElement('div');
    meta.className = 'video-meta';
    const date = new Date(entry.createdAt || Date.now());
    const domain = (() => {
      try {
        return new URL(entry.url).hostname.replace(/^www\./, '');
      } catch (e) {
        return entry.url;
      }
    })();

    const domainSpan = document.createElement('span');
    domainSpan.textContent = domain;
    meta.appendChild(domainSpan);

    const timeSpan = document.createElement('span');
    timeSpan.textContent = date.toLocaleString();
    meta.appendChild(timeSpan);
    li.appendChild(meta);

    if (entry.notes) {
      const notes = document.createElement('p');
      notes.textContent = entry.notes;
      li.appendChild(notes);
    }

    videoListEl.appendChild(li);
  }
}

async function confirmDelete(id) {
  if (!unlocked) return;
  const entry = decryptedEntries.find(item => item.id === id);
  if (!entry) return;
  if (!confirm(`Remove "${entry.title}" from the vault?`)) {
    return;
  }
  decryptedEntries = decryptedEntries.filter(item => item.id !== id);
  const encrypted = await Promise.all(decryptedEntries.map(encryptEntry));
  await saveEncryptedRecords(encrypted);
  renderVault();
  setStatus(vaultStatusEl, 'Video removed.', 'success');
}

async function handleAddLink(event) {
  event.preventDefault();
  if (!unlocked) {
    setStatus(vaultStatusEl, 'Unlock the vault before adding videos.', 'error');
    return;
  }
  const title = titleInput.value.trim();
  const url = urlInput.value.trim();
  const notes = notesInput.value.trim();
  if (!title || !url) {
    setStatus(vaultStatusEl, 'A title and a valid link are required.', 'error');
    return;
  }
  try {
    new URL(url);
  } catch (e) {
    setStatus(vaultStatusEl, 'Please provide a valid URL.', 'error');
    return;
  }

  const record = {
    id: generateId(),
    title,
    url,
    notes,
    createdAt: Date.now()
  };

  decryptedEntries.push(record);
  const encrypted = await Promise.all(decryptedEntries.map(encryptEntry));
  await saveEncryptedRecords(encrypted);
  renderVault();
  addLinkForm.reset();
  titleInput.focus();
  setStatus(vaultStatusEl, 'Video saved to the pantry.', 'success');
}

function showVault() {
  vaultPanel.hidden = false;
  setStatus(statusEl, 'The secret compartment slides open.', 'success');
  renderVault();
  if (pendingSharedUrl) {
    urlInput.value = pendingSharedUrl;
    titleInput.focus();
    setStatus(vaultStatusEl, 'Shared link loaded. Give it a title and save.', 'success');
    pendingSharedUrl = null;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('url');
      url.searchParams.delete('title');
      url.searchParams.delete('text');
      window.history.replaceState({}, document.title, url.toString());
    } catch (e) {
      // ignore
    }
  }
}

function hideVault() {
  vaultPanel.hidden = true;
  decryptedEntries = [];
  cryptoKey = null;
  unlocked = false;
  setStatus(statusEl, 'The lid closes over the secret stash.', 'info');
  addLinkForm.reset();
  setStatus(vaultStatusEl, '');
}

function openPasswordDialog(mode) {
  dialogMode = mode;
  passwordError.textContent = '';
  passwordInput.value = '';
  confirmPasswordInput.value = '';
  const hasPassword = hasStoredPassword();
  const creating = mode === 'create' || !hasPassword;
  confirmPasswordWrap.hidden = !creating;
  confirmPasswordInput.required = creating;
  passwordInput.autocomplete = creating ? 'new-password' : 'current-password';
  confirmPasswordInput.autocomplete = 'new-password';
  passwordSubmitBtn.textContent = creating ? 'Save password' : 'Unlock';
  passwordDialogTitle.textContent = creating ? 'Create your vault password' : 'Unlock the recipe box';
  passwordDialogDescription.textContent = creating
    ? 'Choose a strong password. It will encrypt your video links on this device.'
    : 'Enter the password to reveal your encrypted video pantry.';
  passwordDialog.showModal();
  requestAnimationFrame(() => passwordInput.focus());
}

function closePasswordDialog() {
  if (passwordDialog.open) {
    passwordDialog.close();
  }
}

function hasStoredPassword() {
  return Boolean(localStorage.getItem(SALT_KEY) && localStorage.getItem(HASH_KEY));
}

async function unlockVault(password) {
  const saltB64 = localStorage.getItem(SALT_KEY);
  const hashStored = localStorage.getItem(HASH_KEY);
  if (!saltB64 || !hashStored) {
    throw new Error('No password is configured.');
  }
  const saltBuffer = base64ToArrayBuffer(saltB64);
  const hash = await derivePasswordHash(password, saltBuffer);
  if (hash !== hashStored) {
    throw new Error('Incorrect password.');
  }
  cryptoKey = await deriveEncryptionKey(password, saltBuffer);
  const encryptedRecords = await loadEncryptedRecords();
  decryptedEntries = [];
  for (const record of encryptedRecords) {
    try {
      const entry = await decryptEntry(record);
      decryptedEntries.push(entry);
    } catch (e) {
      console.error('Failed to decrypt entry', e);
    }
  }
  unlocked = true;
  showVault();
}

async function createVaultPassword(password) {
  const confirm = confirmPasswordInput.value;
  if (password !== confirm) {
    throw new Error('Passwords do not match.');
  }
  if (password.length < 8) {
    throw new Error('Use at least 8 characters.');
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = arrayBufferToBase64(salt.buffer);
  const hash = await derivePasswordHash(password, salt.buffer);
  localStorage.setItem(SALT_KEY, saltB64);
  localStorage.setItem(HASH_KEY, hash);
  cryptoKey = await deriveEncryptionKey(password, salt.buffer);
  decryptedEntries = [];
  await saveEncryptedRecords([]);
  unlocked = true;
  showVault();
  setStatus(vaultStatusEl, 'Vault ready. Add your first video!', 'success');
}

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setStatus(passwordError, '');
  const password = passwordInput.value;
  if (!password) {
    setStatus(passwordError, 'Password is required.', 'error');
    return;
  }
  try {
    if (!hasStoredPassword() || dialogMode === 'create') {
      await createVaultPassword(password);
    } else {
      await unlockVault(password);
      setStatus(vaultStatusEl, 'Vault unlocked.', 'success');
    }
    closePasswordDialog();
  } catch (error) {
    console.error(error);
    setStatus(passwordError, error.message || 'Unable to unlock the vault.', 'error');
  }
});

cancelPasswordBtn.addEventListener('click', () => {
  closePasswordDialog();
});

lockBtn.addEventListener('click', () => {
  hideVault();
});

addLinkForm.addEventListener('submit', (event) => {
  handleAddLink(event).catch(err => {
    console.error(err);
    setStatus(vaultStatusEl, err.message || 'Unable to save that link.', 'error');
  });
});

function handleSecretTap(step) {
  if (secretTimer) {
    clearTimeout(secretTimer);
  }
  secretTimer = setTimeout(() => {
    secretIndex = 0;
  }, SECRET_RESET_MS);

  if (SECRET_SEQUENCE[secretIndex] === step) {
    secretIndex += 1;
    if (secretIndex === SECRET_SEQUENCE.length) {
      secretIndex = 0;
      clearTimeout(secretTimer);
      secretTimer = null;
      setStatus(statusEl, 'A soft click echoes from the recipe box.', 'success');
      openPasswordDialog(hasStoredPassword() ? 'unlock' : 'create');
    } else {
      setStatus(statusEl, 'The box creaks softly…', 'info');
    }
  } else {
    secretIndex = step === SECRET_SEQUENCE[0] ? 1 : 0;
    setStatus(statusEl, 'Nothing happens. Try another spot.', 'error');
  }
}

for (const pad of document.querySelectorAll('.secret-pad')) {
  pad.addEventListener('click', (event) => {
    event.preventDefault();
    const step = pad.dataset.step;
    handleSecretTap(step);
  });
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredPrompt = event;
  if (installBtn) {
    installBtn.hidden = false;
  }
});

installBtn?.addEventListener('click', async () => {
  installBtn.hidden = true;
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
});

function parseSharedUrl() {
  try {
    const params = new URLSearchParams(window.location.search);
    const sharedUrl = params.get('url');
    if (sharedUrl) {
      pendingSharedUrl = sharedUrl;
      if (params.get('title')) {
        titleInput.value = params.get('title');
      }
      setStatus(statusEl, 'A new video is waiting to be stashed.', 'info');
    }
  } catch (error) {
    console.warn('Could not parse shared URL', error);
  }
}

if (!supportsEncryption()) {
  setStatus(statusEl, 'This browser does not support the required encryption features.', 'error');
  for (const pad of document.querySelectorAll('.secret-pad')) {
    pad.disabled = true;
  }
  addLinkForm.querySelector('button[type="submit"]').disabled = true;
} else {
  parseSharedUrl();
}

// Initial render
renderVault();
