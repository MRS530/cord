const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
 
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
 
// ── PostgreSQL ────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});
 
// ── Helpers ───────────────────────────────────────────────────
function uid() { return crypto.randomBytes(8).toString('hex'); }
function hash(p) { return crypto.createHash('sha256').update(p).digest('hex'); }
function token() { return crypto.randomBytes(24).toString('hex'); }
function colorFor(name) {
  const cols = ['#5865f2','#3ba55d','#ed4245','#faa61a','#eb459e','#00b0f4','#9b59b6','#e67e22'];
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return cols[Math.abs(h) % cols.length];
}
 
// ── DB Setup ──────────────────────────────────────────────────
async function setupDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      color TEXT NOT NULL,
      avatar TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
    );
    CREATE TABLE IF NOT EXISTS servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🏠',
      owner_id TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL
    );
    CREATE TABLE IF NOT EXISTS server_members (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (server_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      position INT NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      color TEXT NOT NULL,
      avatar TEXT NOT NULL,
      text TEXT NOT NULL,
      reactions JSONB NOT NULL DEFAULT '{}',
      timestamp BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, friend_id)
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      from_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (from_id, to_id)
    );
    CREATE TABLE IF NOT EXISTS dm_messages (
      id TEXT PRIMARY KEY,
      dm_key TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      color TEXT NOT NULL,
      avatar TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS dm_messages_key_idx ON dm_messages(dm_key);
    CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages(channel_id, timestamp);
  `);
 
  // Seed default Lounge server if not exists
  const existing = await pool.query(`SELECT id FROM servers WHERE invite_code = 'lounge'`);
  if (!existing.rows.length) {
    const sid = uid();
    await pool.query(
      `INSERT INTO servers (id, name, icon, owner_id, invite_code) VALUES ($1,$2,$3,$4,$5)`,
      [sid, 'Lounge', '🛋️', 'system', 'lounge']
    );
    const channels = [
      { name: 'general', topic: 'General chat' },
      { name: 'announcements', topic: 'News & updates' },
      { name: 'coding', topic: 'Talk code' },
      { name: 'off-topic', topic: 'Random stuff' },
    ];
    for (let i = 0; i < channels.length; i++) {
      await pool.query(
        `INSERT INTO channels (id, server_id, name, topic, position) VALUES ($1,$2,$3,$4,$5)`,
        [uid(), sid, channels[i].name, channels[i].topic, i]
      );
    }
    console.log('Seeded default Lounge server');
  }
}
 
// ── In-memory caches ──────────────────────────────────────────
const sessionCache = {};
const presenceMap = {};
 
// ── Auth middleware ───────────────────────────────────────────
async function auth(req, res, next) {
  try {
    const tok = req.headers.authorization?.split(' ')[1];
    if (!tok) return res.status(401).json({ error: 'Unauthorized' });
    let userId = sessionCache[tok];
    if (!userId) {
      const r = await pool.query(`SELECT user_id FROM sessions WHERE token = $1`, [tok]);
      if (!r.rows.length) return res.status(401).json({ error: 'Unauthorized' });
      userId = r.rows[0].user_id;
      sessionCache[tok] = userId;
    }
    const r = await pool.query(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (!r.rows.length) return res.status(401).json({ error: 'Unauthorized' });
    req.user = r.rows[0];
    next();
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
}
 
function safeUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name,
    color: u.color, avatar: u.avatar,
    status: presenceMap[u.id] || 'offline',
    friends: [], servers: [],
  };
}
 
// ── Register ──────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
    if (username.length < 2 || username.length > 32) return res.status(400).json({ error: 'Username 2-32 chars' });
    const existing = await pool.query(`SELECT id FROM users WHERE LOWER(username)=LOWER($1)`, [username]);
    if (existing.rows.length) return res.status(400).json({ error: 'Username taken' });
    const id = uid();
    await pool.query(
      `INSERT INTO users (id,username,display_name,password_hash,color,avatar,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, username, displayName || username, hash(password), colorFor(username), username.slice(0,2).toUpperCase(), Date.now()]
    );
    const lounge = await pool.query(`SELECT id FROM servers WHERE invite_code='lounge'`);
    if (lounge.rows.length) {
      await pool.query(`INSERT INTO server_members VALUES ($1,$2) ON CONFLICT DO NOTHING`, [lounge.rows[0].id, id]);
    }
    const tok = token();
    await pool.query(`INSERT INTO sessions (token,user_id) VALUES ($1,$2)`, [tok, id]);
    sessionCache[tok] = id;
    const user = (await pool.query(`SELECT * FROM users WHERE id=$1`, [id])).rows[0];
    res.json({ token: tok, user: safeUser(user) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
// ── Login ─────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const r = await pool.query(`SELECT * FROM users WHERE LOWER(username)=LOWER($1)`, [username || '']);
    if (!r.rows.length || r.rows[0].password_hash !== hash(password))
      return res.status(401).json({ error: 'Invalid username or password' });
    const tok = token();
    await pool.query(`INSERT INTO sessions (token,user_id) VALUES ($1,$2)`, [tok, r.rows[0].id]);
    sessionCache[tok] = r.rows[0].id;
    res.json({ token: tok, user: safeUser(r.rows[0]) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
// ── Servers ───────────────────────────────────────────────────
app.get('/api/servers', auth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT s.id,s.name,s.icon,s.invite_code FROM servers s
      JOIN server_members sm ON sm.server_id=s.id WHERE sm.user_id=$1
    `, [req.user.id]);
    const servers = await Promise.all(r.rows.map(async s => {
      const ch = await pool.query(`SELECT id,name,topic FROM channels WHERE server_id=$1 ORDER BY position`, [s.id]);
      return { id: s.id, name: s.name, icon: s.icon, inviteCode: s.invite_code, channels: ch.rows };
    }));
    res.json(servers);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
app.post('/api/servers', auth, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const id = uid();
    const inviteCode = name.toLowerCase().replace(/\s+/g,'-') + '-' + uid().slice(0,4);
    await pool.query(`INSERT INTO servers (id,name,icon,owner_id,invite_code) VALUES ($1,$2,$3,$4,$5)`, [id, name, '🏠', req.user.id, inviteCode]);
    await pool.query(`INSERT INTO server_members VALUES ($1,$2)`, [id, req.user.id]);
    const chDefs = [{ name:'general', topic:'General chat' }, { name:'off-topic', topic:'Random stuff' }];
    const chRows = [];
    for (let i = 0; i < chDefs.length; i++) {
      const cid = uid();
      await pool.query(`INSERT INTO channels (id,server_id,name,topic,position) VALUES ($1,$2,$3,$4,$5)`, [cid, id, chDefs[i].name, chDefs[i].topic, i]);
      chRows.push({ id: cid, name: chDefs[i].name, topic: chDefs[i].topic });
    }
    res.json({ id, name, icon: '🏠', inviteCode, channels: chRows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
app.post('/api/servers/join', auth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    const r = await pool.query(`SELECT * FROM servers WHERE invite_code=$1`, [inviteCode]);
    if (!r.rows.length) return res.status(404).json({ error: 'Invalid invite code' });
    const s = r.rows[0];
    await pool.query(`INSERT INTO server_members VALUES ($1,$2) ON CONFLICT DO NOTHING`, [s.id, req.user.id]);
    const ch = await pool.query(`SELECT id,name,topic FROM channels WHERE server_id=$1 ORDER BY position`, [s.id]);
    const userSockets = await io.in('user:' + req.user.id).fetchSockets();
    userSockets.forEach(sock => ch.rows.forEach(c => sock.join('ch:' + c.id)));
    res.json({ id: s.id, name: s.name, icon: s.icon, inviteCode: s.invite_code, channels: ch.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
app.post('/api/servers/:sid/channels', auth, async (req, res) => {
  try {
    const s = await pool.query(`SELECT * FROM servers WHERE id=$1`, [req.params.sid]);
    if (!s.rows.length) return res.status(404).json({ error: 'Server not found' });
    if (s.rows[0].owner_id !== req.user.id) return res.status(403).json({ error: 'Not owner' });
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const pos = parseInt((await pool.query(`SELECT COUNT(*) FROM channels WHERE server_id=$1`, [req.params.sid])).rows[0].count);
    const cid = uid();
    await pool.query(`INSERT INTO channels (id,server_id,name,topic,position) VALUES ($1,$2,$3,$4,$5)`, [cid, req.params.sid, name, '', pos]);
    res.json({ id: cid, name, topic: '' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
// ── Messages ──────────────────────────────────────────────────
app.get('/api/servers/:sid/channels/:cid/messages', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM messages WHERE channel_id=$1 ORDER BY timestamp ASC LIMIT 100`, [req.params.cid]
    );
    res.json(r.rows.map(m => ({
      id: m.id, userId: m.user_id, username: m.username,
      color: m.color, avatar: m.avatar, text: m.text,
      reactions: m.reactions, timestamp: Number(m.timestamp)
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
// ── Friends ───────────────────────────────────────────────────
app.get('/api/friends', auth, async (req, res) => {
  try {
    const friends = await pool.query(`SELECT u.* FROM users u JOIN friends f ON f.friend_id=u.id WHERE f.user_id=$1`, [req.user.id]);
    const incoming = await pool.query(`SELECT u.* FROM users u JOIN friend_requests fr ON fr.from_id=u.id WHERE fr.to_id=$1`, [req.user.id]);
    const outgoing = await pool.query(`SELECT u.* FROM users u JOIN friend_requests fr ON fr.to_id=u.id WHERE fr.from_id=$1`, [req.user.id]);
    res.json({ friends: friends.rows.map(safeUser), incoming: incoming.rows.map(safeUser), outgoing: outgoing.rows.map(safeUser) });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
app.post('/api/friends/request', auth, async (req, res) => {
  try {
    const { username } = req.body;
    const t = (await pool.query(`SELECT * FROM users WHERE LOWER(username)=LOWER($1)`, [username || ''])).rows[0];
    if (!t) return res.status(404).json({ error: 'User not found' });
    if (t.id === req.user.id) return res.status(400).json({ error: "Can't add yourself" });
    if ((await pool.query(`SELECT 1 FROM friends WHERE user_id=$1 AND friend_id=$2`, [req.user.id, t.id])).rows.length)
      return res.status(400).json({ error: 'Already friends' });
    if ((await pool.query(`SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2`, [req.user.id, t.id])).rows.length)
      return res.status(400).json({ error: 'Request already sent' });
    // Auto-accept if they already sent us one
    if ((await pool.query(`SELECT 1 FROM friend_requests WHERE from_id=$1 AND to_id=$2`, [t.id, req.user.id])).rows.length) {
      await pool.query(`DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2`, [t.id, req.user.id]);
      await pool.query(`INSERT INTO friends VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING`, [req.user.id, t.id]);
      return res.json({ status: 'accepted' });
    }
    await pool.query(`INSERT INTO friend_requests VALUES ($1,$2)`, [req.user.id, t.id]);
    io.to('user:' + t.id).emit('friend_request', safeUser(req.user));
    res.json({ status: 'sent' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
app.post('/api/friends/accept', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    const r = await pool.query(`DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2 RETURNING *`, [userId, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'No request found' });
    await pool.query(`INSERT INTO friends VALUES ($1,$2),($2,$1) ON CONFLICT DO NOTHING`, [req.user.id, userId]);
    io.to('user:' + userId).emit('friend_accepted', safeUser(req.user));
    res.json({ status: 'ok' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
app.post('/api/friends/decline', auth, async (req, res) => {
  try {
    const { userId } = req.body;
    await pool.query(`DELETE FROM friend_requests WHERE from_id=$1 AND to_id=$2`, [userId, req.user.id]);
    res.json({ status: 'ok' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
// ── DMs ───────────────────────────────────────────────────────
app.get('/api/dm/:userId/messages', auth, async (req, res) => {
  try {
    const key = [req.user.id, req.params.userId].sort().join(':');
    const r = await pool.query(`SELECT * FROM dm_messages WHERE dm_key=$1 ORDER BY timestamp ASC LIMIT 100`, [key]);
    res.json(r.rows.map(m => ({
      id: m.id, userId: m.user_id, username: m.username,
      color: m.color, avatar: m.avatar, text: m.text, timestamp: Number(m.timestamp)
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Server error' }); }
});
 
// ── Socket.io ─────────────────────────────────────────────────
io.use(async (socket, next) => {
  try {
    const tok = socket.handshake.auth.token;
    let userId = sessionCache[tok];
    if (!userId) {
      const r = await pool.query(`SELECT user_id FROM sessions WHERE token=$1`, [tok]);
      if (!r.rows.length) return next(new Error('Unauthorized'));
      userId = r.rows[0].user_id;
      sessionCache[tok] = userId;
    }
    const r = await pool.query(`SELECT * FROM users WHERE id=$1`, [userId]);
    if (!r.rows.length) return next(new Error('Unauthorized'));
    socket.userId = userId;
    socket.user = r.rows[0];
    next();
  } catch (e) { next(new Error('Server error')); }
});
 
io.on('connection', async (socket) => {
  const user = socket.user;
  presenceMap[user.id] = 'online';
  socket.join('user:' + user.id);
 
  // Join all channel rooms this user has access to
  const chs = await pool.query(`
    SELECT c.id FROM channels c
    JOIN server_members sm ON sm.server_id=c.server_id
    WHERE sm.user_id=$1
  `, [user.id]);
  chs.rows.forEach(r => socket.join('ch:' + r.id));
 
  io.emit('presence_update', { userId: user.id, status: 'online' });
 
  socket.on('send_message', async ({ channelId, serverId, text }) => {
    if (!text?.trim()) return;
    const mem = await pool.query(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, user.id]);
    if (!mem.rows.length) return;
    const ch = await pool.query(`SELECT 1 FROM channels WHERE id=$1 AND server_id=$2`, [channelId, serverId]);
    if (!ch.rows.length) return;
    const msg = {
      id: uid(), userId: user.id, username: user.display_name,
      color: user.color, avatar: user.avatar,
      text: text.trim(), timestamp: Date.now(), reactions: {}
    };
    await pool.query(
      `INSERT INTO messages (id,channel_id,user_id,username,color,avatar,text,reactions,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [msg.id, channelId, msg.userId, msg.username, msg.color, msg.avatar, msg.text, JSON.stringify({}), msg.timestamp]
    );
    // Trim to last 200 messages
    await pool.query(`
      DELETE FROM messages WHERE id IN (
        SELECT id FROM messages WHERE channel_id=$1 ORDER BY timestamp ASC OFFSET 200
      )
    `, [channelId]);
    io.to('ch:' + channelId).emit('new_message', { channelId, serverId, message: msg });
  });
 
  socket.on('send_dm', async ({ toUserId, text }) => {
    if (!text?.trim()) return;
    const target = await pool.query(`SELECT * FROM users WHERE id=$1`, [toUserId]);
    if (!target.rows.length) return;
    const key = [user.id, toUserId].sort().join(':');
    const msg = {
      id: uid(), userId: user.id, username: user.display_name,
      color: user.color, avatar: user.avatar,
      text: text.trim(), timestamp: Date.now()
    };
    await pool.query(
      `INSERT INTO dm_messages (id,dm_key,user_id,username,color,avatar,text,timestamp) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [msg.id, key, msg.userId, msg.username, msg.color, msg.avatar, msg.text, msg.timestamp]
    );
    io.to('user:' + toUserId).emit('new_dm', { fromUserId: user.id, message: msg });
    socket.emit('new_dm', { fromUserId: user.id, message: msg });
  });
 
  socket.on('add_reaction', async ({ serverId, channelId, messageId, emoji }) => {
    const r = await pool.query(`SELECT * FROM messages WHERE id=$1 AND channel_id=$2`, [messageId, channelId]);
    if (!r.rows.length) return;
    const reactions = r.rows[0].reactions || {};
    if (!reactions[emoji]) reactions[emoji] = [];
    const idx = reactions[emoji].indexOf(user.id);
    if (idx >= 0) reactions[emoji].splice(idx, 1); else reactions[emoji].push(user.id);
    if (!reactions[emoji].length) delete reactions[emoji];
    await pool.query(`UPDATE messages SET reactions=$1 WHERE id=$2`, [JSON.stringify(reactions), messageId]);
    io.to('ch:' + channelId).emit('reaction_update', { channelId, messageId, reactions });
  });
 
  socket.on('typing', ({ channelId }) => {
    socket.to('ch:' + channelId).emit('typing', { channelId, username: user.display_name });
  });
 
  socket.on('join_server_room', async ({ serverId }) => {
    const mem = await pool.query(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, user.id]);
    if (!mem.rows.length) return;
    const chs = await pool.query(`SELECT id FROM channels WHERE server_id=$1`, [serverId]);
    chs.rows.forEach(c => socket.join('ch:' + c.id));
  });
 
  socket.on('disconnect', () => {
    presenceMap[user.id] = 'offline';
    io.emit('presence_update', { userId: user.id, status: 'offline' });
  });
});
 
// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
setupDB().then(() => {
  server.listen(PORT, () => console.log(`Running on port ${PORT}`));
}).catch(err => {
  console.error('Failed to setup DB:', err);
  process.exit(1);
});
