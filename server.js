const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 50 * 1024 * 1024
});

const JWT_SECRET = process.env.JWT_SECRET || 'securechat-dev-secret-change-in-prod';
const PORT = process.env.PORT || 3000;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://akbaqaotgnelfidhwktv.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrYmFxYW90Z25lbGZpZGh3a3R2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgwNjAzNTAsImV4cCI6MjA5MzYzNjM1MH0.taQiSLTeDToot4EdUdqopOEp5fkhRjd03EOKZYMGeWI';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// RAM uniquement — reset OK, c'est juste les sockets en ligne
const onlineUsers = {}; // socketId -> { userId, username, roomId }
const userSockets = {}; // userId -> socketId

// --- Multer ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Session expirée — reconnecte-toi' });
  }
}

// --- Routes ---

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Champs requis' });
  if (username.trim().length < 3) return res.status(400).json({ error: 'Pseudo trop court (min 3)' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6)' });

  const { data: existing } = await supabase.from('users').select('id').ilike('username', username.trim()).maybeSingle();
  if (existing) return res.status(400).json({ error: 'Ce pseudo est déjà pris' });

  const passwordHash = await bcrypt.hash(password, 10);
  const { data: user, error } = await supabase.from('users').insert({ username: username.trim(), password_hash: passwordHash }).select('id, username').single();
  if (error) return res.status(500).json({ error: 'Erreur serveur' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs requis' });

  const { data: user } = await supabase.from('users').select('id, username, password_hash').ilike('username', username).maybeSingle();
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/rooms', authMiddleware, async (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nom du salon requis' });

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const { data: room, error } = await supabase.from('rooms').insert({ name: name.trim(), code, owner_id: req.user.id }).select('id, name, code, owner_id').single();
  if (error) return res.status(500).json({ error: 'Erreur création salon' });

  await supabase.from('room_members').insert({ room_id: room.id, user_id: req.user.id });
  res.json({ id: room.id, name: room.name, code: room.code, ownerId: room.owner_id });
});

app.post('/api/rooms/join', authMiddleware, async (req, res) => {
  const code = String(req.body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Code requis' });

  const { data: room } = await supabase.from('rooms').select('id, name, code, owner_id').eq('code', code).maybeSingle();
  if (!room) return res.status(404).json({ error: `Code "${code}" invalide` });

  await supabase.from('room_members').upsert({ room_id: room.id, user_id: req.user.id }, { onConflict: 'room_id,user_id' });
  res.json({ id: room.id, name: room.name, code: room.code, ownerId: room.owner_id });
});

app.get('/api/rooms', authMiddleware, async (req, res) => {
  const { data } = await supabase
    .from('room_members')
    .select('rooms(id, name, code, owner_id)')
    .eq('user_id', req.user.id);

  const rooms = (data || []).map(r => ({
    id: r.rooms.id,
    name: r.rooms.name,
    code: r.rooms.code,
    ownerId: r.rooms.owner_id
  }));
  res.json(rooms);
});

app.get('/api/rooms/:roomId/messages', authMiddleware, async (req, res) => {
  // Vérifier membre
  const { data: member } = await supabase.from('room_members').select('user_id').eq('room_id', req.params.roomId).eq('user_id', req.user.id).maybeSingle();
  if (!member) return res.status(403).json({ error: 'Accès refusé' });

  const { data: msgs } = await supabase.from('messages').select('*').eq('room_id', req.params.roomId).order('created_at', { ascending: true }).limit(200);
  res.json((msgs || []).map(m => ({
    id: m.id,
    userId: m.user_id,
    username: m.username,
    content: m.content,
    type: m.type,
    fileUrl: m.file_url,
    filename: m.filename,
    mimetype: m.mimetype,
    timestamp: new Date(m.created_at).getTime()
  })));
});

app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

app.get('/api/rooms/:roomId/online', authMiddleware, async (req, res) => {
  const { data: member } = await supabase.from('room_members').select('user_id').eq('room_id', req.params.roomId).eq('user_id', req.user.id).maybeSingle();
  if (!member) return res.status(403).json({ error: 'Accès refusé' });

  // Considéré en ligne si last_seen < 8 secondes
  const cutoff = new Date(Date.now() - 8000).toISOString();
  const { data } = await supabase.from('presence').select('user_id, username').eq('room_id', req.params.roomId).gte('last_seen', cutoff);
  res.json((data || []).map(u => ({ userId: u.user_id, username: u.username })));
});

app.post('/api/rooms/:roomId/heartbeat', authMiddleware, async (req, res) => {
  const { data: member } = await supabase.from('room_members').select('user_id').eq('room_id', req.params.roomId).eq('user_id', req.user.id).maybeSingle();
  if (!member) return res.status(403).json({ error: 'Accès refusé' });

  await supabase.from('presence').upsert({ user_id: req.user.id, username: req.user.username, room_id: req.params.roomId, last_seen: new Date().toISOString() }, { onConflict: 'user_id' });
  res.json({ ok: true });
});

app.get('/api/ping', async (req, res) => {
  const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
  res.json({ ok: true, users: count });
});

// --- Socket.IO ---
io.use((socket, next) => {
  try {
    socket.user = jwt.verify(socket.handshake.auth.token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Auth failed'));
  }
});

io.on('connection', (socket) => {
  const { id: userId, username } = socket.user;
  userSockets[userId] = socket.id;

  socket.on('join-room', async ({ roomId }) => {
    const { data: member } = await supabase.from('room_members').select('user_id').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
    if (!member) return;

    Object.keys(onlineUsers).forEach(sid => {
      if (onlineUsers[sid]?.userId === userId) {
        const old = onlineUsers[sid];
        socket.leave(old.roomId);
        delete onlineUsers[sid];
      }
    });

    onlineUsers[socket.id] = { userId, username, roomId };
    socket.join(roomId);

    io.to(roomId).emit('user-joined', { userId, username });
    io.to(roomId).emit('online-users',
      Object.values(onlineUsers).filter(u => u.roomId === roomId).map(u => ({ userId: u.userId, username: u.username }))
    );
  });

  socket.on('send-message', async ({ roomId, content, type = 'text', fileUrl, filename, mimetype }) => {
    const { data: member } = await supabase.from('room_members').select('user_id').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
    if (!member) return;

    const { data: msg } = await supabase.from('messages').insert({
      room_id: roomId,
      user_id: userId,
      username,
      content,
      type,
      file_url: fileUrl,
      filename,
      mimetype
    }).select('id, created_at').single();

    if (!msg) return;

    io.to(roomId).emit('new-message', {
      id: msg.id,
      userId,
      username,
      content,
      type,
      fileUrl,
      filename,
      mimetype,
      timestamp: new Date(msg.created_at).getTime()
    });
  });

  socket.on('typing', ({ roomId }) => socket.to(roomId).emit('user-typing', { username }));
  socket.on('stop-typing', ({ roomId }) => socket.to(roomId).emit('user-stop-typing', { username }));

  // WebRTC signaling
  socket.on('call-offer', ({ targetUserId, offer, callType }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-incoming', { fromUserId: userId, fromUsername: username, offer, callType });
  });
  socket.on('call-answer', ({ targetUserId, answer }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-answered', { answer });
  });
  socket.on('call-ice-candidate', ({ targetUserId, candidate }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-ice-candidate', { candidate });
  });
  socket.on('call-end', ({ targetUserId }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-ended');
  });
  socket.on('call-reject', ({ targetUserId }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-rejected');
  });

  socket.on('disconnect', () => {
    const info = onlineUsers[socket.id];
    if (info) {
      delete onlineUsers[socket.id];
      delete userSockets[userId];
      io.to(info.roomId).emit('user-left', { userId, username });
      io.to(info.roomId).emit('online-users',
        Object.values(onlineUsers).filter(u => u.roomId === info.roomId).map(u => ({ userId: u.userId, username: u.username }))
      );
    }
  });
});

server.listen(PORT, () => console.log(`SecureChat on http://localhost:${PORT}`));
