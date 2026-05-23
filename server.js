const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 100 * 1024 * 1024 // 100MB
});

const JWT_SECRET = 'secure-chat-secret-' + Math.random().toString(36);
const PORT = 3000;

// --- In-memory storage ---
const users = {};     // id -> { id, username, passwordHash, avatar }
const rooms = {};     // roomId -> { id, name, code, ownerId, members: Set }
const messages = {};  // roomId -> [{ id, userId, username, content, type, filename, timestamp }]
const onlineUsers = {}; // socketId -> { userId, username, roomId }
const userSockets = {}; // userId -> socketId

// --- Multer config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/uploads')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|webm|mov|mp3|ogg|wav|pdf|txt|zip/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype);
    cb(null, ext || mime);
  }
});

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
    res.status(401).json({ error: 'Token invalide' });
  }
}

// --- Routes ---

// Register
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs requis' });
  if (username.length < 3) return res.status(400).json({ error: 'Pseudo trop court (min 3)' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6)' });

  const existing = Object.values(users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Pseudo déjà pris' });

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 12);
  users[id] = { id, username, passwordHash, avatar: null, createdAt: Date.now() };

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id, username } });
});

// Login
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = Object.values(users).find(u => u.username.toLowerCase() === username?.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, username: user.username, avatar: user.avatar } });
});

// Create room
app.post('/api/rooms', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });

  const id = uuidv4();
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[id] = { id, name, code, ownerId: req.user.id, members: new Set([req.user.id]), createdAt: Date.now() };
  messages[id] = [];

  res.json({ id, name, code, ownerId: req.user.id });
});

// Join room by code
app.post('/api/rooms/join', authMiddleware, (req, res) => {
  const { code } = req.body;
  const room = Object.values(rooms).find(r => r.code === code?.toUpperCase());
  if (!room) return res.status(404).json({ error: 'Code invalide' });

  room.members.add(req.user.id);
  res.json({ id: room.id, name: room.name, code: room.code, ownerId: room.ownerId });
});

// Get my rooms
app.get('/api/rooms', authMiddleware, (req, res) => {
  const myRooms = Object.values(rooms)
    .filter(r => r.members.has(req.user.id))
    .map(r => ({ id: r.id, name: r.name, code: r.code, ownerId: r.ownerId }));
  res.json(myRooms);
});

// Get room messages
app.get('/api/rooms/:roomId/messages', authMiddleware, (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Salon introuvable' });
  if (!room.members.has(req.user.id)) return res.status(403).json({ error: 'Accès refusé' });

  res.json(messages[req.params.roomId] || []);
});

// Upload file
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  res.json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

// Get room members online
app.get('/api/rooms/:roomId/online', authMiddleware, (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Salon introuvable' });

  const online = Object.values(onlineUsers)
    .filter(u => u.roomId === req.params.roomId)
    .map(u => ({ userId: u.userId, username: u.username }));
  res.json(online);
});

// --- Socket.IO ---
function verifySocketToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const user = verifySocketToken(token);
  if (!user) return next(new Error('Auth failed'));
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const { id: userId, username } = socket.user;
  userSockets[userId] = socket.id;

  socket.on('join-room', ({ roomId }) => {
    const room = rooms[roomId];
    if (!room || !room.members.has(userId)) return;

    // Leave previous rooms
    Object.keys(onlineUsers).forEach(sid => {
      if (onlineUsers[sid]?.userId === userId) delete onlineUsers[sid];
    });

    onlineUsers[socket.id] = { userId, username, roomId };
    socket.join(roomId);

    io.to(roomId).emit('user-joined', { userId, username });
    io.to(roomId).emit('online-users',
      Object.values(onlineUsers).filter(u => u.roomId === roomId).map(u => ({ userId: u.userId, username: u.username }))
    );
  });

  socket.on('send-message', ({ roomId, content, type = 'text', fileUrl, filename, mimetype }) => {
    const room = rooms[roomId];
    if (!room || !room.members.has(userId)) return;

    const msg = {
      id: uuidv4(),
      userId,
      username,
      content,
      type,
      fileUrl,
      filename,
      mimetype,
      timestamp: Date.now()
    };

    if (!messages[roomId]) messages[roomId] = [];
    messages[roomId].push(msg);

    // Keep last 500 messages
    if (messages[roomId].length > 500) messages[roomId].shift();

    io.to(roomId).emit('new-message', msg);
  });

  socket.on('typing', ({ roomId }) => {
    socket.to(roomId).emit('user-typing', { username });
  });

  socket.on('stop-typing', ({ roomId }) => {
    socket.to(roomId).emit('user-stop-typing', { username });
  });

  // WebRTC signaling
  socket.on('call-offer', ({ roomId, targetUserId, offer, callType }) => {
    const targetSocket = userSockets[targetUserId];
    if (targetSocket) {
      io.to(targetSocket).emit('call-incoming', {
        fromUserId: userId,
        fromUsername: username,
        offer,
        callType,
        roomId
      });
    }
  });

  socket.on('call-answer', ({ targetUserId, answer }) => {
    const targetSocket = userSockets[targetUserId];
    if (targetSocket) io.to(targetSocket).emit('call-answered', { answer, fromUserId: userId });
  });

  socket.on('call-ice-candidate', ({ targetUserId, candidate }) => {
    const targetSocket = userSockets[targetUserId];
    if (targetSocket) io.to(targetSocket).emit('call-ice-candidate', { candidate, fromUserId: userId });
  });

  socket.on('call-end', ({ targetUserId }) => {
    const targetSocket = userSockets[targetUserId];
    if (targetSocket) io.to(targetSocket).emit('call-ended', { fromUserId: userId });
  });

  socket.on('call-reject', ({ targetUserId }) => {
    const targetSocket = userSockets[targetUserId];
    if (targetSocket) io.to(targetSocket).emit('call-rejected', { fromUserId: userId });
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

server.listen(PORT, () => {
  console.log(`Secure Chat running on http://localhost:${PORT}`);
});
