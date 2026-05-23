// ============================================================
// SecureChat - app.js
// ============================================================

const API = '';
let token = localStorage.getItem('sc_token');

async function apiFetch(url, opts = {}) {
  const res = await fetch(API + url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      Authorization: `Bearer ${token}`
    }
  });
  if (res.status === 401) {
    localStorage.removeItem('sc_token');
    localStorage.removeItem('sc_user');
    token = null; me = null;
    showAuth();
    document.getElementById('auth-error').textContent = 'Session expirée — reconnecte-toi.';
    throw new Error('401');
  }
  return res;
}
let me = JSON.parse(localStorage.getItem('sc_user') || 'null');
let socket = null;
let currentRoomId = null;
let currentRoomCode = null;
let rooms = {};
let typingTimeout = null;
let typingUsers = new Set();
let onlinePollInterval = null;
const pendingMsgIds = new Set(); // messages envoyés localement, à ignorer quand le serveur les renvoie

// WebRTC
let peerConnection = null;
let localStream = null;
let callTarget = null; // { userId, username }
let callType = 'audio'; // 'audio' | 'video'

const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  if (token && me) {
    showApp();
    connectSocket();
    loadRooms();
  } else {
    showAuth();
  }
  bindEvents();
});

// ============================================================
// UI HELPERS
// ============================================================
function showAuth() {
  document.getElementById('auth-screen').classList.add('active');
  document.getElementById('app-screen').classList.remove('active');
}

function showApp() {
  document.getElementById('auth-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  document.getElementById('my-username').textContent = me.username;
  document.getElementById('my-avatar').textContent = me.username[0].toUpperCase();
}

function toast(msg, duration = 3000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), duration);
}

function avatarColor(username) {
  const colors = ['#5865f2','#57f287','#fee75c','#ed4245','#eb459e','#3ba55d','#faa61a'];
  let hash = 0;
  for (const c of username) hash = (hash * 31 + c.charCodeAt(0)) & 0xffffffff;
  return colors[Math.abs(hash) % colors.length];
}

function makeAvatar(username, size = 40) {
  const div = document.createElement('div');
  div.className = 'avatar';
  div.style.background = avatarColor(username);
  div.style.width = size + 'px';
  div.style.height = size + 'px';
  div.style.fontSize = Math.floor(size * 0.4) + 'px';
  div.textContent = username[0].toUpperCase();
  return div;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

// ============================================================
// AUTH
// ============================================================
let authMode = 'login';

function bindEvents() {
  // Tab switch
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      authMode = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('auth-submit').textContent =
        authMode === 'login' ? 'Se connecter' : "S'inscrire";
      document.getElementById('auth-error').textContent = '';
    });
  });

  // Auth form
  document.getElementById('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value;
    const errorEl = document.getElementById('auth-error');

    try {
      const res = await fetch(`${API}/api/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) { errorEl.textContent = data.error; return; }

      token = data.token;
      me = data.user;
      localStorage.setItem('sc_token', token);
      localStorage.setItem('sc_user', JSON.stringify(me));

      showApp();
      connectSocket();
      loadRooms();
    } catch (err) {
      errorEl.textContent = 'Erreur de connexion';
    }
  });

  // Logout
  document.getElementById('logout-btn').addEventListener('click', () => {
    localStorage.removeItem('sc_token');
    localStorage.removeItem('sc_user');
    if (socket) socket.disconnect();
    token = null; me = null; currentRoomId = null;
    document.getElementById('channel-list').innerHTML = '';
    document.getElementById('rooms-list').innerHTML = '';
    showAuth();
  });

  // Create room
  document.getElementById('create-room-btn').addEventListener('click', () => {
    document.getElementById('create-room-modal').style.display = '';
    document.getElementById('join-room-modal').style.display = 'none';
    document.getElementById('modal-overlay').classList.add('active');
    document.getElementById('room-name-input').focus();
  });

  document.getElementById('cancel-create-btn').addEventListener('click', closeModal);
  document.getElementById('confirm-create-btn').addEventListener('click', createRoom);

  // Join room
  document.getElementById('join-room-btn').addEventListener('click', () => {
    document.getElementById('join-room-modal').style.display = '';
    document.getElementById('create-room-modal').style.display = 'none';
    document.getElementById('modal-overlay').classList.add('active');
    document.getElementById('join-code-input').value = '';
    document.getElementById('join-error').textContent = '';
    document.getElementById('join-code-input').focus();
  });

  document.getElementById('cancel-join-btn').addEventListener('click', closeModal);
  document.getElementById('confirm-join-btn').addEventListener('click', joinRoom);

  document.getElementById('join-code-input').addEventListener('input', function() {
    this.value = this.value.replace(/[^0-9]/g, '').slice(0, 6);
  });

  // Mobile nav
  document.getElementById('nav-chat-btn')?.addEventListener('click', () => showMobileView('chat'));
  document.getElementById('nav-rooms-btn')?.addEventListener('click', () => showMobileView('rooms'));
  document.getElementById('nav-join-btn')?.addEventListener('click', () => {
    document.getElementById('join-room-modal').style.display = '';
    document.getElementById('create-room-modal').style.display = 'none';
    document.getElementById('modal-overlay').classList.add('active');
    document.getElementById('join-code-input').value = '';
    document.getElementById('join-error').textContent = '';
    document.getElementById('join-code-input').focus();
  });

  // Bouton retour mobile
  document.getElementById('mobile-back-btn')?.addEventListener('click', () => showMobileView('rooms'));

  // Modal overlay click
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  // Copy code
  document.getElementById('copy-code-btn').addEventListener('click', () => {
    if (currentRoomCode) {
      navigator.clipboard.writeText(currentRoomCode);
      toast('Code copié !');
    }
  });

  // Message input
  const input = document.getElementById('message-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', () => {
    // Auto-resize
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
    // Typing
    if (currentRoomId) {
      socket.emit('typing', { roomId: currentRoomId });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        socket.emit('stop-typing', { roomId: currentRoomId });
      }, 2000);
    }
  });

  // Send button
  document.getElementById('send-btn').addEventListener('click', sendMessage);

  // File input
  document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !currentRoomId) return;
    await uploadAndSend(file);
    e.target.value = '';
  });

  // Call actions
  document.getElementById('accept-call-btn').addEventListener('click', acceptCall);
  document.getElementById('reject-call-btn').addEventListener('click', rejectCall);
  document.getElementById('end-call-btn').addEventListener('click', endCall);
  document.getElementById('mute-btn').addEventListener('click', toggleMute);
  document.getElementById('cam-btn').addEventListener('click', toggleCam);

  // Enter key in modals
  document.getElementById('room-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createRoom();
  });
  document.getElementById('join-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom();
  });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('active');
}

function showMobileView(view) {
  const panel = document.getElementById('channel-panel') || document.querySelector('.channel-panel');
  const navChat = document.getElementById('nav-chat-btn');
  const navRooms = document.getElementById('nav-rooms-btn');

  if (view === 'rooms') {
    if (panel) panel.classList.add('mobile-visible');
    navRooms?.classList.add('active');
    navChat?.classList.remove('active');
  } else {
    if (panel) panel.classList.remove('mobile-visible');
    navChat?.classList.add('active');
    navRooms?.classList.remove('active');
  }
}

// ============================================================
// SOCKET
// ============================================================
function connectSocket() {
  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    console.error('Socket error:', err.message);
    if (err.message === 'Auth failed') {
      // Token expiré ou invalide — déconnecter proprement
      localStorage.removeItem('sc_token');
      localStorage.removeItem('sc_user');
      token = null; me = null;
      showAuth();
      setTimeout(() => {
        document.getElementById('auth-error').textContent = 'Session expirée — reconnecte-toi.';
      }, 100);
    }
  });

  socket.on('new-message', (msg) => {
    // Si c'est notre propre message optimistic, on ignore (déjà affiché)
    if (msg.userId === me.id && pendingMsgIds.size > 0) {
      const firstPending = [...pendingMsgIds][0];
      pendingMsgIds.delete(firstPending);
      return;
    }
    appendMessage(msg);
  });

  socket.on('user-joined', ({ username }) => {
    if (username !== me.username) {
      appendSystem(`${username} a rejoint le salon.`);
    }
  });

  socket.on('user-left', ({ username }) => {
    appendSystem(`${username} a quitté le salon.`);
  });

  socket.on('online-users', (users) => {
    renderOnlineMembers(users);
  });

  socket.on('user-typing', ({ username }) => {
    if (username !== me.username) {
      typingUsers.add(username);
      updateTypingIndicator();
    }
  });

  socket.on('user-stop-typing', ({ username }) => {
    typingUsers.delete(username);
    updateTypingIndicator();
  });

  // WebRTC signaling
  socket.on('call-incoming', handleIncomingCall);
  socket.on('call-answered', async ({ answer }) => {
    if (peerConnection) await peerConnection.setRemoteDescription(answer);
  });
  socket.on('call-ice-candidate', async ({ candidate }) => {
    if (peerConnection && candidate) {
      try { await peerConnection.addIceCandidate(candidate); } catch(e) {}
    }
  });
  socket.on('call-ended', () => {
    cleanupCall();
    toast('Appel terminé');
  });
  socket.on('call-rejected', () => {
    cleanupCall();
    toast('Appel refusé');
  });
}

// ============================================================
// ROOMS
// ============================================================
async function loadRooms() {
  let res;
  try { res = await apiFetch('/api/rooms'); } catch { return; }
  if (!res.ok) return;
  const data = await res.json();
  rooms = {};
  data.forEach(r => rooms[r.id] = r);
  renderRooms();

  // Rouvrir le dernier salon automatiquement
  const lastRoom = localStorage.getItem('sc_last_room');
  if (lastRoom && rooms[lastRoom]) {
    selectRoom(lastRoom);
  }
}

function renderRooms() {
  const channelList = document.getElementById('channel-list');
  const roomsList = document.getElementById('rooms-list');
  channelList.innerHTML = '';
  roomsList.innerHTML = '';

  Object.values(rooms).forEach(room => {
    // Channel item
    const item = document.createElement('div');
    item.className = 'channel-item' + (room.id === currentRoomId ? ' active' : '');
    item.dataset.roomId = room.id;
    item.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
      </svg>
      <span>${room.name}</span>
    `;
    item.addEventListener('click', () => selectRoom(room.id));
    channelList.appendChild(item);

    // Sidebar icon
    const icon = document.createElement('div');
    icon.className = 'room-icon' + (room.id === currentRoomId ? ' active' : '');
    icon.title = room.name;
    icon.textContent = room.name[0].toUpperCase();
    icon.addEventListener('click', () => selectRoom(room.id));
    roomsList.appendChild(icon);
  });
}

async function selectRoom(roomId) {
  currentRoomId = roomId;
  const room = rooms[roomId];
  currentRoomCode = room.code;

  document.getElementById('current-room-name').textContent = '#' + room.name;
  document.getElementById('room-code-display').style.display = 'flex';
  document.getElementById('room-code-text').textContent = room.code;
  document.getElementById('chat-input-area').style.display = 'flex';

  renderRooms();
  typingUsers.clear();
  updateTypingIndicator();

  // Rejoindre la room socket EN PREMIER pour ne rater aucun message
  socket.emit('join-room', { roomId });

  // Sauvegarder le salon actif
  localStorage.setItem('sc_last_room', roomId);

  // Polling membres en ligne toutes les secondes
  if (onlinePollInterval) clearInterval(onlinePollInterval);
  onlinePollInterval = setInterval(async () => {
    if (!currentRoomId) return;
    try {
      const r = await apiFetch(`/api/rooms/${currentRoomId}/online`);
      if (r.ok) renderOnlineMembers(await r.json());
    } catch {}
  }, 1000);

  // Load messages
  let res;
  try { res = await apiFetch(`/api/rooms/${roomId}/messages`); } catch { return; }
  if (res.ok) {
    const msgs = await res.json();
    renderMessages(msgs);
  }

  // Sur mobile : afficher le chat
  showMobileView('chat');
}

async function createRoom() {
  const name = document.getElementById('room-name-input').value.trim();
  if (!name) return;

  let res;
  try {
    res = await apiFetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
  } catch { return; }
  const room = await res.json();
  if (!res.ok) return;

  rooms[room.id] = room;
  closeModal();
  renderRooms();
  selectRoom(room.id);
  toast(`Salon "${room.name}" créé ! Code : ${room.code}`);
  document.getElementById('room-name-input').value = '';
}

async function joinRoom() {
  const code = document.getElementById('join-code-input').value.trim();
  const errorEl = document.getElementById('join-error');
  if (!code) return;

  let res;
  try {
    res = await apiFetch('/api/rooms/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    });
  } catch { return; }
  const room = await res.json();
  if (!res.ok) { errorEl.textContent = room.error; return; }

  rooms[room.id] = room;
  closeModal();
  renderRooms();
  selectRoom(room.id);
  toast(`Rejoint "${room.name}" !`);
}

// ============================================================
// MESSAGES
// ============================================================
function renderMessages(msgs) {
  const area = document.getElementById('messages-area');
  area.innerHTML = '';

  if (msgs.length === 0) {
    area.innerHTML = `<div class="welcome-msg">
      <div class="welcome-icon">💬</div>
      <h2>Début du salon #${rooms[currentRoomId]?.name}</h2>
      <p>Sois le premier à écrire quelque chose !</p>
    </div>`;
    return;
  }

  let lastDate = null;
  msgs.forEach(msg => {
    const msgDate = new Date(msg.timestamp).toDateString();
    if (msgDate !== lastDate) {
      lastDate = msgDate;
      const sep = document.createElement('div');
      sep.className = 'date-separator';
      sep.textContent = formatDate(msg.timestamp);
      area.appendChild(sep);
    }
    area.appendChild(buildMessageEl(msg));
  });

  area.scrollTop = area.scrollHeight;
}

function appendMessage(msg) {
  // Les messages socket n'ont pas de roomId (on est déjà dans la bonne room)
  const area = document.getElementById('messages-area');

  // Clear welcome
  if (area.querySelector('.welcome-msg')) area.innerHTML = '';

  area.appendChild(buildMessageEl(msg));
  area.scrollTop = area.scrollHeight;
}

function appendSystem(text) {
  const area = document.getElementById('messages-area');
  const div = document.createElement('div');
  div.className = 'system-msg';
  div.textContent = text;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

function buildMessageEl(msg) {
  const isOwn = msg.userId === me.id;
  const div = document.createElement('div');
  div.className = 'message' + (isOwn ? ' msg-own' : '');

  const avatar = makeAvatar(msg.username);
  div.appendChild(avatar);

  const content = document.createElement('div');
  content.className = 'msg-content';

  const header = document.createElement('div');
  header.className = 'msg-header';
  header.innerHTML = `<span class="msg-username">${escHtml(msg.username)}</span><span class="msg-time">${formatTime(msg.timestamp)}</span>`;
  content.appendChild(header);

  // Render content based on type
  if (msg.type === 'text') {
    const p = document.createElement('div');
    p.className = 'msg-text';
    p.textContent = msg.content;
    content.appendChild(p);
  } else if (msg.type === 'image') {
    const img = document.createElement('img');
    img.className = 'msg-image';
    img.src = msg.fileUrl;
    img.alt = msg.filename;
    img.addEventListener('click', () => openLightbox(msg.fileUrl));
    content.appendChild(img);
  } else if (msg.type === 'video') {
    const vid = document.createElement('video');
    vid.className = 'msg-video';
    vid.src = msg.fileUrl;
    vid.controls = true;
    vid.style.maxWidth = '400px';
    content.appendChild(vid);
  } else if (msg.type === 'audio') {
    const aud = document.createElement('audio');
    aud.className = 'msg-audio';
    aud.src = msg.fileUrl;
    aud.controls = true;
    content.appendChild(aud);
  } else if (msg.type === 'file') {
    const link = document.createElement('a');
    link.className = 'msg-file';
    link.href = msg.fileUrl;
    link.download = msg.filename;
    link.target = '_blank';
    link.innerHTML = `
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
      </svg>
      <div class="file-info">
        <div class="file-name">${escHtml(msg.filename)}</div>
      </div>
    `;
    content.appendChild(link);
  }

  div.appendChild(content);
  return div;
}

function openLightbox(src) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${src}">`;
  lb.addEventListener('click', () => lb.remove());
  document.body.appendChild(lb);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
// SEND
// ============================================================
function sendMessage() {
  const input = document.getElementById('message-input');
  const content = input.value.trim();
  if (!content || !currentRoomId || !socket?.connected) return;

  const tempId = 'tmp_' + Date.now();
  pendingMsgIds.add(tempId);

  // Afficher immédiatement (optimistic)
  appendMessage({ id: tempId, userId: me.id, username: me.username, content, type: 'text', timestamp: Date.now() });

  socket.emit('send-message', { roomId: currentRoomId, content, type: 'text' });
  socket.emit('stop-typing', { roomId: currentRoomId });

  input.value = '';
  input.style.height = 'auto';
}

async function uploadAndSend(file) {
  if (!currentRoomId || !socket?.connected) return;

  toast('📎 Envoi en cours...');
  const formData = new FormData();
  formData.append('file', file);

  let res;
  try {
    res = await apiFetch('/api/upload', { method: 'POST', body: formData });
  } catch { return; }

  if (!res.ok) { toast('Erreur upload'); return; }
  const data = await res.json();

  let type = 'file';
  if (data.mimetype.startsWith('image/')) type = 'image';
  else if (data.mimetype.startsWith('video/')) type = 'video';
  else if (data.mimetype.startsWith('audio/')) type = 'audio';

  socket.emit('send-message', {
    roomId: currentRoomId,
    content: data.filename,
    type,
    fileUrl: data.url,
    filename: data.filename,
    mimetype: data.mimetype
  });

  toast('Fichier envoyé !');
}

// ============================================================
// TYPING
// ============================================================
function updateTypingIndicator() {
  const el = document.getElementById('typing-indicator');
  if (typingUsers.size === 0) { el.textContent = ''; return; }
  const names = [...typingUsers].join(', ');
  el.textContent = `${names} est en train d'écrire...`;
}

// ============================================================
// MEMBERS
// ============================================================
function renderOnlineMembers(users) {
  const list = document.getElementById('members-sidebar-list');
  const panel = document.getElementById('members-list');
  list.innerHTML = '';
  panel.innerHTML = '';

  users.forEach(u => {
    // Sidebar members
    const item = document.createElement('div');
    item.className = 'member-item';

    const av = makeAvatar(u.username, 32);
    item.appendChild(av);

    const span = document.createElement('span');
    span.textContent = u.username;
    item.appendChild(span);

    if (u.userId !== me.id) {
      // Audio call button
      const btnA = document.createElement('button');
      btnA.className = 'icon-btn small';
      btnA.title = 'Appel audio';
      btnA.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z"/>
      </svg>`;
      btnA.addEventListener('click', () => startCall(u.userId, u.username, 'audio'));

      // Video call button
      const btnV = document.createElement('button');
      btnV.className = 'icon-btn small';
      btnV.title = 'Appel vidéo';
      btnV.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17 10.5V7a1 1 0 00-1-1H4a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1v-3.5l4 4v-11l-4 4z"/>
      </svg>`;
      btnV.addEventListener('click', () => startCall(u.userId, u.username, 'video'));

      item.appendChild(btnA);
      item.appendChild(btnV);
    }

    list.appendChild(item.cloneNode(true));

    // Re-attach events for sidebar
    const item2 = item;
    panel.appendChild(item2);
  });
}

// ============================================================
// WebRTC - CALLS
// ============================================================
let incomingCallData = null;

async function startCall(targetUserId, targetUsername, type) {
  callTarget = { userId: targetUserId, username: targetUsername };
  callType = type;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video'
    });
  } catch {
    toast('Impossible d\'accéder au micro/caméra');
    return;
  }

  setupPeerConnection();

  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  if (type === 'video') {
    document.getElementById('local-video').srcObject = localStream;
    document.getElementById('active-call').style.display = 'flex';
    document.getElementById('active-call').style.flexDirection = 'column';
  }

  document.getElementById('call-peer-name').textContent = targetUsername;
  document.getElementById('active-call').style.display = 'flex';

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('call-offer', {
    roomId: currentRoomId,
    targetUserId,
    offer,
    callType: type
  });

  toast(`Appel vers ${targetUsername}...`);
}

function handleIncomingCall(data) {
  incomingCallData = data;
  callType = data.callType;

  document.getElementById('call-avatar').textContent = data.fromUsername[0].toUpperCase();
  document.getElementById('call-name').textContent = data.fromUsername;
  document.getElementById('call-status').textContent =
    data.callType === 'video' ? 'Appel vidéo entrant...' : 'Appel audio entrant...';
  document.getElementById('call-overlay').style.display = 'flex';
}

async function acceptCall() {
  document.getElementById('call-overlay').style.display = 'none';
  if (!incomingCallData) return;

  callTarget = { userId: incomingCallData.fromUserId, username: incomingCallData.fromUsername };

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: callType === 'video'
    });
  } catch {
    toast('Impossible d\'accéder au micro/caméra');
    return;
  }

  setupPeerConnection();
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  if (callType === 'video') {
    document.getElementById('local-video').srcObject = localStream;
  }

  document.getElementById('call-peer-name').textContent = incomingCallData.fromUsername;
  document.getElementById('active-call').style.display = 'flex';

  await peerConnection.setRemoteDescription(incomingCallData.offer);
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('call-answer', {
    targetUserId: incomingCallData.fromUserId,
    answer
  });

  incomingCallData = null;
}

function rejectCall() {
  document.getElementById('call-overlay').style.display = 'none';
  if (incomingCallData) {
    socket.emit('call-reject', { targetUserId: incomingCallData.fromUserId });
    incomingCallData = null;
  }
}

function setupPeerConnection() {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  peerConnection.onicecandidate = (e) => {
    if (e.candidate && callTarget) {
      socket.emit('call-ice-candidate', {
        targetUserId: callTarget.userId,
        candidate: e.candidate
      });
    }
  };

  peerConnection.ontrack = (e) => {
    const remoteVideo = document.getElementById('remote-video');
    if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
    remoteVideo.srcObject.addTrack(e.track);
  };

  peerConnection.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(peerConnection?.connectionState)) {
      cleanupCall();
    }
  };
}

function endCall() {
  if (callTarget) {
    socket.emit('call-end', { targetUserId: callTarget.userId });
  }
  cleanupCall();
}

function cleanupCall() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  callTarget = null;
  document.getElementById('active-call').style.display = 'none';
  document.getElementById('call-overlay').style.display = 'none';
  document.getElementById('remote-video').srcObject = null;
  document.getElementById('local-video').srcObject = null;
}

let micMuted = false;
let camOff = false;

function toggleMute() {
  if (!localStream) return;
  micMuted = !micMuted;
  localStream.getAudioTracks().forEach(t => t.enabled = !micMuted);
  const btn = document.getElementById('mute-btn');
  btn.classList.toggle('off', micMuted);
  btn.title = micMuted ? 'Activer le micro' : 'Couper le micro';
}

function toggleCam() {
  if (!localStream) return;
  camOff = !camOff;
  localStream.getVideoTracks().forEach(t => t.enabled = !camOff);
  const btn = document.getElementById('cam-btn');
  btn.classList.toggle('off', camOff);
  btn.title = camOff ? 'Activer la caméra' : 'Désactiver la caméra';
}
