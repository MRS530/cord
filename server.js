const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory DB ──────────────────────────────────────────────
const db = {
  users: {},        // id -> user
  servers: {},      // id -> server
  sessions: {},     // token -> userId
  friendReqs: [],   // {from, to}
};

function uid() { return crypto.randomBytes(8).toString('hex'); }
function hash(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
function token() { return crypto.randomBytes(24).toString('hex'); }

function colorFor(name) {
  const cols = ['#5865f2','#3ba55d','#ed4245','#faa61a','#eb459e','#00b0f4','#9b59b6','#e67e22'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return cols[Math.abs(h) % cols.length];
}

// seed a default server
const defaultServerId = uid();
db.servers[defaultServerId] = {
  id: defaultServerId,
  name: 'Lounge',
  icon: '🛋️',
  ownerId: 'system',
  inviteCode: 'lounge',
  members: [],
  channels: [
    { id: uid(), name: 'general', topic: 'General chat', messages: [] },
    { id: uid(), name: 'announcements', topic: 'News & updates', messages: [] },
    { id: uid(), name: 'coding', topic: 'Talk code', messages: [] },
    { id: uid(), name: 'off-topic', topic: 'Random stuff', messages: [] },
  ]
};

// ── Auth REST ─────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Username 2-32 chars' });
  if (Object.values(db.users).find(u => u.username.toLowerCase() === username.toLowerCase()))
    return res.status(400).json({ error: 'Username taken' });
  const id = uid();
  db.users[id] = {
    id, username, displayName: displayName || username,
    passwordHash: hash(password),
    color: colorFor(username),
    avatar: username.slice(0,2).toUpperCase(),
    friends: [], servers: [defaultServerId],
    dmChannels: {}, status: 'online', createdAt: Date.now()
  };
  db.servers[defaultServerId].members.push(id);
  const tok = token();
  db.sessions[tok] = id;
  res.json({ token: tok, user: safeUser(db.users[id]) });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = Object.values(db.users).find(u => u.username.toLowerCase() === username?.toLowerCase());
  if (!user || user.passwordHash !== hash(password))
    return res.status(401).json({ error: 'Invalid username or password' });
  const tok = token();
  db.sessions[tok] = user.id;
  user.status = 'online';
  res.json({ token: tok, user: safeUser(user) });
});

function auth(req, res, next) {
  const tok = req.headers.authorization?.split(' ')[1];
  const userId = db.sessions[tok];
  if (!userId || !db.users[userId]) return res.status(401).json({ error: 'Unauthorized' });
  req.user = db.users[userId];
  next();
}

function safeUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName, color: u.color, avatar: u.avatar, status: u.status, friends: u.friends, servers: u.servers };
}

// servers
app.get('/api/servers', auth, (req, res) => {
  const servers = req.user.servers.map(sid => {
    const s = db.servers[sid];
    if (!s) return null;
    return { id: s.id, name: s.name, icon: s.icon, inviteCode: s.inviteCode, channels: s.channels.map(c => ({ id: c.id, name: c.name, topic: c.topic })) };
  }).filter(Boolean);
  res.json(servers);
});

app.post('/api/servers', auth, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const id = uid();
  const inviteCode = name.toLowerCase().replace(/\s+/g,'-') + '-' + uid().slice(0,4);
  db.servers[id] = {
    id, name, icon: '🏠', ownerId: req.user.id,
    inviteCode, members: [req.user.id],
    channels: [
      { id: uid(), name: 'general', topic: 'General chat', messages: [] },
      { id: uid(), name: 'off-topic', topic: 'Random stuff', messages: [] },
    ]
  };
  req.user.servers.push(id);
  res.json({ id, name, icon: '🏠', inviteCode, channels: db.servers[id].channels.map(c => ({ id: c.id, name: c.name, topic: c.topic })) });
});

app.post('/api/servers/join', auth, (req, res) => {
  const { inviteCode } = req.body;
  const s = Object.values(db.servers).find(s => s.inviteCode === inviteCode);
  if (!s) return res.status(404).json({ error: 'Invalid invite code' });
  if (!s.members.includes(req.user.id)) {
    s.members.push(req.user.id);
    req.user.servers.push(s.id);
  }
  res.json({ id: s.id, name: s.name, icon: s.icon, inviteCode: s.inviteCode, channels: s.channels.map(c => ({ id: c.id, name: c.name, topic: c.topic })) });
});

app.post('/api/servers/:sid/channels', auth, (req, res) => {
  const s = db.servers[req.params.sid];
  if (!s) return res.status(404).json({ error: 'Server not found' });
  if (s.ownerId !== req.user.id) return res.status(403).json({ error: 'Not owner' });
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const ch = { id: uid(), name, topic: '', messages: [] };
  s.channels.push(ch);
  res.json({ id: ch.id, name: ch.name, topic: ch.topic });
});

// channel history
app.get('/api/servers/:sid/channels/:cid/messages', auth, (req, res) => {
  const s = db.servers[req.params.sid];
  if (!s) return res.status(404).json({ error: 'Not found' });
  const ch = s.channels.find(c => c.id === req.params.cid);
  if (!ch) return res.status(404).json({ error: 'Not found' });
  res.json(ch.messages.slice(-100));
});

// friends
app.get('/api/friends', auth, (req, res) => {
  const friends = req.user.friends.map(fid => safeUser(db.users[fid])).filter(Boolean);
  const incoming = db.friendReqs.filter(r => r.to === req.user.id).map(r => safeUser(db.users[r.from])).filter(Boolean);
  const outgoing = db.friendReqs.filter(r => r.from === req.user.id).map(r => safeUser(db.users[r.to])).filter(Boolean);
  res.json({ friends, incoming, outgoing });
});

app.post('/api/friends/request', auth, (req, res) => {
  const { username } = req.body;
  const target = Object.values(db.users).find(u => u.username.toLowerCase() === username?.toLowerCase());
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: "Can't add yourself" });
  if (req.user.friends.includes(target.id)) return res.status(400).json({ error: 'Already friends' });
  if (db.friendReqs.find(r => r.from === req.user.id && r.to === target.id))
    return res.status(400).json({ error: 'Request already sent' });
  // auto-accept if target already sent a request
  const existing = db.friendReqs.find(r => r.from === target.id && r.to === req.user.id);
  if (existing) {
    db.friendReqs = db.friendReqs.filter(r => r !== existing);
    req.user.friends.push(target.id);
    target.friends.push(req.user.id);
    return res.json({ status: 'accepted' });
  }
  db.friendReqs.push({ from: req.user.id, to: target.id });
  io.to('user:' + target.id).emit('friend_request', safeUser(req.user));
  res.json({ status: 'sent' });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const { userId } = req.body;
  const idx = db.friendReqs.findIndex(r => r.from === userId && r.to === req.user.id);
  if (idx === -1) return res.status(404).json({ error: 'No request found' });
  db.friendReqs.splice(idx, 1);
  req.user.friends.push(userId);
  db.users[userId]?.friends.push(req.user.id);
  io.to('user:' + userId).emit('friend_accepted', safeUser(req.user));
  res.json({ status: 'ok' });
});

app.post('/api/friends/decline', auth, (req, res) => {
  const { userId } = req.body;
  db.friendReqs = db.friendReqs.filter(r => !(r.from === userId && r.to === req.user.id));
  res.json({ status: 'ok' });
});

// DMs
app.get('/api/dm/:userId/messages', auth, (req, res) => {
  const key = [req.user.id, req.params.userId].sort().join(':');
  const msgs = (req.user.dmChannels[key] || []);
  res.json(msgs.slice(-100));
});

// ── Socket.io ─────────────────────────────────────────────────
io.use((socket, next) => {
  const tok = socket.handshake.auth.token;
  const userId = db.sessions[tok];
  if (!userId) return next(new Error('Unauthorized'));
  socket.userId = userId;
  socket.user = db.users[userId];
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;
  user.status = 'online';
  socket.join('user:' + user.id);

  // join all server channels
  user.servers.forEach(sid => {
    const s = db.servers[sid];
    if (s) s.channels.forEach(ch => socket.join('ch:' + ch.id));
  });

  io.emit('presence_update', { userId: user.id, status: 'online' });

  socket.on('send_message', ({ channelId, serverId, text }) => {
    if (!text?.trim()) return;
    const s = db.servers[serverId];
    if (!s || !s.members.includes(user.id)) return;
    const ch = s.channels.find(c => c.id === channelId);
    if (!ch) return;
    const msg = { id: uid(), userId: user.id, username: user.displayName, color: user.color, avatar: user.avatar, text: text.trim(), timestamp: Date.now(), reactions: {} };
    ch.messages.push(msg);
    if (ch.messages.length > 200) ch.messages.shift();
    io.to('ch:' + channelId).emit('new_message', { channelId, serverId, message: msg });
  });

  socket.on('send_dm', ({ toUserId, text }) => {
    if (!text?.trim()) return;
    const target = db.users[toUserId];
    if (!target) return;
    const key = [user.id, toUserId].sort().join(':');
    if (!user.dmChannels[key]) user.dmChannels[key] = [];
    if (!target.dmChannels[key]) target.dmChannels[key] = [];
    const msg = { id: uid(), userId: user.id, username: user.displayName, color: user.color, avatar: user.avatar, text: text.trim(), timestamp: Date.now() };
    user.dmChannels[key].push(msg);
    target.dmChannels[key].push(msg);
    if (user.dmChannels[key].length > 200) user.dmChannels[key].shift();
    io.to('user:' + toUserId).emit('new_dm', { fromUserId: user.id, message: msg });
    socket.emit('new_dm', { fromUserId: user.id, message: msg });
  });

  socket.on('add_reaction', ({ serverId, channelId, messageId, emoji }) => {
    const s = db.servers[serverId];
    if (!s) return;
    const ch = s.channels.find(c => c.id === channelId);
    if (!ch) return;
    const msg = ch.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const arr = msg.reactions[emoji];
    const idx = arr.indexOf(user.id);
    if (idx >= 0) arr.splice(idx, 1); else arr.push(user.id);
    if (!arr.length) delete msg.reactions[emoji];
    io.to('ch:' + channelId).emit('reaction_update', { channelId, messageId, reactions: msg.reactions });
  });

  socket.on('typing', ({ channelId }) => {
    socket.to('ch:' + channelId).emit('typing', { channelId, username: user.displayName });
  });

  socket.on('join_server_room', ({ serverId }) => {
    const s = db.servers[serverId];
    if (s && s.members.includes(user.id)) {
      s.channels.forEach(ch => socket.join('ch:' + ch.id));
    }
  });

  socket.on('disconnect', () => {
    user.status = 'offline';
    io.emit('presence_update', { userId: user.id, status: 'offline' });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on port ${PORT}`));
