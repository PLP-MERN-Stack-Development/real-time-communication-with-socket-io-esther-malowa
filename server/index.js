// server/index.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

// ensure uploads folder exists
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use(express.json());

// dynamic CORS for localhost (dev)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin.startsWith("http://localhost")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// multer upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage });
app.use("/uploads", express.static(uploadsDir));

// In-memory data (replace with DB for production)
let users = {}; // socketId -> {username, room, lastSeen}
let messages = []; // {id, text, sender, timestamp, room, isPrivate, to, reactions:[], readBy:[], deliveredTo:[]}
let rooms = ["global"]; // add rooms dynamically

// file upload endpoint
app.post("/upload", upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });
    const url = `http://localhost:${PORT}/uploads/${req.file.filename}`;
    return res.json({ url });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Upload failed" });
  }
});

// pagination endpoint: GET /messages?room=global&page=1&limit=20&private=false&peer=username
app.get("/messages", (req, res) => {
  const { room = "global", page = 1, limit = 20, private: isPrivate = "false", peer } = req.query;
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  let filtered = messages.filter(m => {
    if (isPrivate === "true") {
      // private messages between sender and peer OR to/from peer
      if (!peer) return false;
      return m.isPrivate && ((m.sender === peer && m.to === req.query.requester) || (m.sender === req.query.requester && m.to === peer) || (m.sender === peer && m.to === req.query.requester));
    } else {
      return !m.isPrivate && m.room === room;
    }
  });

  // newest last; return older pages first
  filtered = filtered.sort((a,b) => new Date(a.timestamp) - new Date(b.timestamp));
  const start = Math.max(0, filtered.length - pageNum * lim);
  const end = filtered.length - (pageNum - 1) * lim;
  const pageItems = filtered.slice(start, end);
  res.json({ messages: pageItems, total: filtered.length });
});

// create rooms endpoint (optional)
app.post("/rooms", (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "room name required" });
  if (!rooms.includes(name)) rooms.push(name);
  res.json({ rooms });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || origin.startsWith("http://localhost")) callback(null, true);
      else callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST"],
  }
});

// helper to get online users in a room
const onlineUsersInRoom = (room) => Object.values(users).filter(u => u.room === room);

// Socket.io handlers
io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  // client sends: join { username, room }
  socket.on("join", ({ username, room = "global" }, cb) => {
    if (!username) return cb && cb({ error: "Username required" });
    users[socket.id] = { username, room, lastSeen: new Date().toISOString() };
    if (!rooms.includes(room)) rooms.push(room);
    socket.join(room);
    io.to(room).emit("onlineUsers", onlineUsersInRoom(room));
    io.to(room).emit("notification", `${username} joined ${room}`);
    console.log(`${username} joined ${room}`);
    cb && cb({ status: "ok" });
  });

  // change room / join new room
  socket.on("joinRoom", ({ room }, cb) => {
    const u = users[socket.id];
    if (!u) return cb && cb({ error: "Not joined" });
    socket.leave(u.room);
    u.room = room;
    socket.join(room);
    io.to(u.room).emit("onlineUsers", onlineUsersInRoom(u.room));
    io.to(room).emit("onlineUsers", onlineUsersInRoom(room));
    io.to(room).emit("notification", `${u.username} joined ${room}`);
    cb && cb({ status: "ok" });
  });

  // send message (public or private)
  // data: { text, isPrivate=false, to (username if private), fileUrl? }
  socket.on("sendMessage", (data, cb) => {
    const user = users[socket.id];
    if (!user) return cb && cb({ error: "Not joined" });

    const msg = {
      id: uuidv4(),
      text: data.text || "",
      file: data.file || null, // url
      sender: user.username,
      timestamp: new Date().toISOString(),
      room: user.room,
      isPrivate: !!data.isPrivate,
      to: data.to || null, // recipient username
      reactions: [],
      readBy: [],
      deliveredTo: []
    };

    messages.push(msg);

    if (msg.isPrivate && msg.to) {
      // find socket(s) for recipient
      const recipients = Object.entries(users).filter(([sid,u]) => u.username === msg.to);
      recipients.forEach(([sid]) => {
        io.to(sid).emit("privateMessage", msg);
      });
      // also send back to sender
      socket.emit("privateMessage", msg);
    } else {
      io.to(msg.room).emit("receiveMessage", msg);
    }

    // delivery ack via callback
    cb && cb({ status: "delivered", id: msg.id });
  });

  // typing indicator: broadcast to room (or to user if private)
  // data: { isTyping, isPrivate, to }
  socket.on("typing", (data) => {
    const user = users[socket.id];
    if (!user) return;
    if (data.isPrivate && data.to) {
      // send to recipient only
      const recipientSockets = Object.entries(users).filter(([sid,u]) => u.username === data.to).map(([sid]) => sid);
      recipientSockets.forEach(sid => io.to(sid).emit("typing", { username: user.username, isTyping: data.isTyping, isPrivate: true }));
    } else {
      socket.to(user.room).emit("typing", { username: user.username, isTyping: data.isTyping });
    }
  });

  // reaction
  socket.on("react", ({ messageId, reaction }, cb) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return cb && cb({ error: "Message not found" });
    msg.reactions.push({ user: users[socket.id].username, reaction });
    // broadcast update
    if (msg.isPrivate && msg.to) {
      // send to both participants
      const targets = Object.entries(users).filter(([sid,u]) => u.username === msg.to || u.username === msg.sender).map(([sid]) => sid);
      targets.forEach(sid => io.to(sid).emit("reactionUpdate", msg));
    } else {
      io.to(msg.room).emit("reactionUpdate", msg);
    }
    cb && cb({ status: "ok" });
  });

  // read receipt
  socket.on("readMessage", ({ messageId }, cb) => {
    const msg = messages.find(m => m.id === messageId);
    if (!msg) return cb && cb({ error: "Message not found" });
    const username = users[socket.id]?.username;
    if (username && !msg.readBy.includes(username)) {
      msg.readBy.push(username);
    }
    if (msg.isPrivate && msg.to) {
      // notify participants
      const targets = Object.entries(users).filter(([sid,u]) => u.username === msg.to || u.username === msg.sender).map(([sid]) => sid);
      targets.forEach(sid => io.to(sid).emit("readUpdate", msg));
    } else {
      io.to(msg.room).emit("readUpdate", msg);
    }
    cb && cb({ status: "ok" });
  });

  // unread counts for a user (simple count)
  socket.on("getUnreadCounts", (cb) => {
    const u = users[socket.id];
    if (!u) return cb && cb({ error: "Not joined" });
    const counts = {};
    messages.forEach(m => {
      if (m.isPrivate) {
        if (m.to === u.username && !m.readBy.includes(u.username)) {
          counts[m.sender] = (counts[m.sender] || 0) + 1;
        }
      } else {
        if (m.room === u.room && !m.readBy.includes(u.username)) {
          counts[m.room] = (counts[m.room] || 0) + 1;
        }
      }
    });
    cb && cb(counts);
  });

  // disconnect
  socket.on("disconnect", () => {
    const u = users[socket.id];
    if (u) {
      const leftRoom = u.room;
      delete users[socket.id];
      io.to(leftRoom).emit("onlineUsers", onlineUsersInRoom(leftRoom));
      io.to(leftRoom).emit("notification", `${u.username} left ${leftRoom}`);
      console.log(`${u.username} disconnected`);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
