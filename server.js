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
  maxHttpBufferSize: 50 * 1024 * 1024
});

const JWT_SECRET = process.env.JWT_SECRET || 'secure-chat-fallback-secret-change-me';
const PORT = process.env.PORT || 3000;

// --- Persistance fichier JSON dans /tmp (fonctionne sur Vercel/Railway/Render) ---
const DATA_FILE = process.env.DATA_FILE || path.join(require('os').tmpdir(), 'securechat_data.json');

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Re-créer les Sets
      if (raw.rooms) {
        Object.values(raw.rooms).forEach(r => {
          r.members = new Set(r.members || []);
        });
      }
      return raw;
    }
  } catch (e) {
    console.error('Erreur lecture data:', e.message);
  }
  return { users: {}, rooms: {}, messages: {} };
}

function saveData() {
  try {
    const toSave = {
      users: db.users,
      rooms: {},
      messages: db.messages
    };
    // Convertir les Sets en arrays pour JSON
    Object.entries(db.rooms).forEach(([id, r]) => {
      toSave.rooms[id] = { ...r, members: [...r.members] };
    });
    fs.writeFileSync(DATA_FILE, JSON.stringify(toSave));
  } catch (e) {
    console.error('Erreur sauvegarde data:', e.message);
  }
}

const db = loadData();

// RAM uniquement (reset ok à chaque démarrage)
const onlineUsers = {}; // socketId -> { userId, username, roomId }
const userSockets = {}; // userId -> socketId

// --- Multer config (mémoire pour Vercel, /tmp pour autres) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'public/uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
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
    res.status(401).json({ error: 'Token invalide — reconnecte-toi' });
  }
}

// --- Routes ---

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs requis' });
  if (username.length < 3) return res.status(400).json({ error: 'Pseudo trop court (min 3 caractères)' });
  if (password.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });

  const existing = Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (existing) return res.status(400).json({ error: 'Ce pseudo est déjà pris' });

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  db.users[id] = { id, username, passwordHash, createdAt: Date.now() };
  saveData();

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id, username } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Champs requis' });

  const user = Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Identifiants incorrects' });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: 'Identifiants incorrects' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username } });
});

app.post('/api/rooms', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom du salon requis' });

  const id = uuidv4();
  // Code 6 chiffres seulement pour éviter ambiguïté lettres
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.rooms[id] = {
    id,
    name: name.trim(),
    code,
    ownerId: req.user.id,
    members: new Set([req.user.id]),
    createdAt: Date.now()
  };
  db.messages[id] = [];
  saveData();

  res.json({ id, name: name.trim(), code, ownerId: req.user.id });
});

app.post('/api/rooms/join', authMiddleware, (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code requis' });

  const clean = String(code).trim();
  const room = Object.values(db.rooms).find(r => r.code === clean);
  if (!room) return res.status(404).json({ error: `Code "${clean}" invalide — vérifie le code` });

  room.members.add(req.user.id);
  if (!db.messages[room.id]) db.messages[room.id] = [];
  saveData();

  res.json({ id: room.id, name: room.name, code: room.code, ownerId: room.ownerId });
});

app.get('/api/rooms', authMiddleware, (req, res) => {
  const myRooms = Object.values(db.rooms)
    .filter(r => r.members.has(req.user.id))
    .map(r => ({ id: r.id, name: r.name, code: r.code, ownerId: r.ownerId }));
  res.json(myRooms);
});

app.get('/api/rooms/:roomId/messages', authMiddleware, (req, res) => {
  const room = db.rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: 'Salon introuvable' });
  if (!room.members.has(req.user.id)) return res.status(403).json({ error: 'Accès refusé' });
  res.json(db.messages[req.params.roomId] || []);
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

// Health check
app.get('/api/ping', (req, res) => res.json({ ok: true, rooms: Object.keys(db.rooms).length, users: Object.keys(db.users).length }));

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

  socket.on('join-room', ({ roomId }) => {
    const room = db.rooms[roomId];
    if (!room || !room.members.has(userId)) return;

    // Quitter les rooms précédentes
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
    const room = db.rooms[roomId];
    if (!room || !room.members.has(userId)) return;

    const msg = { id: uuidv4(), userId, username, content, type, fileUrl, filename, mimetype, timestamp: Date.now() };
    if (!db.messages[roomId]) db.messages[roomId] = [];
    db.messages[roomId].push(msg);
    if (db.messages[roomId].length > 200) db.messages[roomId].shift();
    saveData();

    io.to(roomId).emit('new-message', msg);
  });

  socket.on('typing', ({ roomId }) => socket.to(roomId).emit('user-typing', { username }));
  socket.on('stop-typing', ({ roomId }) => socket.to(roomId).emit('user-stop-typing', { username }));

  // WebRTC
  socket.on('call-offer', ({ targetUserId, offer, callType }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-incoming', { fromUserId: userId, fromUsername: username, offer, callType });
  });
  socket.on('call-answer', ({ targetUserId, answer }) => {
    const s = userSockets[targetUserId];
    if (s) io.to(s).emit('call-answered', { answer, fromUserId: userId });
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
