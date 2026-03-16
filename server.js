const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.static(path.join(__dirname, 'public')));

const channels = {
  general: { topic: 'General chat for everyone', messages: [] },
  announcements: { topic: 'Server news and updates', messages: [] },
  coding: { topic: 'Talk code, share projects', messages: [] },
  help: { topic: 'Get help from the community', messages: [] },
  projects: { topic: 'Show off your work', messages: [] },
  memes: { topic: 'Post memes here', messages: [] },
  'off-topic': { topic: 'Random stuff', messages: [] }
};

const MAX_MESSAGES = 100;
const onlineUsers = new Map();

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', ({ username, channel }) => {
    socket.username = username;
    socket.currentChannel = channel || 'general';
    socket.join(socket.currentChannel);

    onlineUsers.set(socket.id, { username, channel: socket.currentChannel });
    io.emit('users_update', Array.from(onlineUsers.values()));

    const history = channels[socket.currentChannel]?.messages || [];
    socket.emit('channel_history', { channel: socket.currentChannel, messages: history });

    io.to(socket.currentChannel).emit('user_joined', {
      username,
      channel: socket.currentChannel,
      timestamp: Date.now()
    });
  });

  socket.on('switch_channel', (channel) => {
    if (!channels[channel]) return;
    socket.leave(socket.currentChannel);
    socket.currentChannel = channel;
    socket.join(channel);

    if (onlineUsers.has(socket.id)) {
      onlineUsers.get(socket.id).channel = channel;
      io.emit('users_update', Array.from(onlineUsers.values()));
    }

    socket.emit('channel_history', { channel, messages: channels[channel].messages });
  });

  socket.on('send_message', ({ channel, text }) => {
    if (!channels[channel] || !text?.trim()) return;
    const msg = {
      id: Date.now() + Math.random().toString(36).slice(2),
      username: socket.username,
      text: text.trim(),
      timestamp: Date.now(),
      reactions: {}
    };
    channels[channel].messages.push(msg);
    if (channels[channel].messages.length > MAX_MESSAGES) {
      channels[channel].messages.shift();
    }
    io.to(channel).emit('new_message', { channel, message: msg });
  });

  socket.on('add_reaction', ({ channel, messageId, emoji }) => {
    const ch = channels[channel];
    if (!ch) return;
    const msg = ch.messages.find(m => m.id === messageId);
    if (!msg) return;
    if (!msg.reactions[emoji]) msg.reactions[emoji] = new Set();
    const set = msg.reactions[emoji];
    if (set.has(socket.username)) {
      set.delete(socket.username);
    } else {
      set.add(socket.username);
    }
    if (set.size === 0) delete msg.reactions[emoji];
    const serializable = {};
    for (const [k, v] of Object.entries(msg.reactions)) {
      serializable[k] = Array.from(v);
    }
    io.to(channel).emit('reaction_update', { channel, messageId, reactions: serializable });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    io.emit('users_update', Array.from(onlineUsers.values()));
    if (socket.username && socket.currentChannel) {
      io.to(socket.currentChannel).emit('user_left', {
        username: socket.username,
        channel: socket.currentChannel
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
