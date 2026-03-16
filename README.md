# Discord Clone - Real-Time Chat

A Discord-like real-time multi-user chat app built with Node.js, Socket.io, and vanilla HTML/CSS/JS.

## Features
- Real-time messaging across multiple users
- Multiple channels
- Message reactions (hover a message to react)
- Emoji picker
- Dark / Light mode toggle
- Typing indicators
- Online member list
- Sound effects
- Unread message badges

---

## Deploy to Railway (Free)

### Step 1 — Create a Railway account
Go to https://railway.app and sign up (free).

### Step 2 — Deploy
1. Go to https://railway.app/new
2. Click **"Deploy from GitHub repo"** (or use the Railway CLI)
3. Upload / connect this project folder
4. Railway auto-detects Node.js and runs `npm start`

### Step 3 — Get your URL
Railway gives you a public URL like `https://your-app.up.railway.app`.
Share it with friends — they open it in a browser and can chat in real time!

---

## Run Locally (optional)

```bash
npm install
npm start
```

Then open http://localhost:3000 in multiple browser tabs to test multi-user chat.

---

## Project Structure

```
discord-clone/
├── server.js          # Node.js + Socket.io backend
├── package.json       # Dependencies
├── public/
│   └── index.html     # Full frontend UI
└── README.md
```
