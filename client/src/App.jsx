import { useEffect, useState, useRef, useCallback } from "react";
import { io } from "socket.io-client";
import axios from "axios";

const socket = io("http://localhost:4000", { autoConnect: false });

function App() {
  const [username, setUsername] = useState(localStorage.getItem("username") || "");
  const [loggedIn, setLoggedIn] = useState(!!localStorage.getItem("username"));
  const [room, setRoom] = useState(localStorage.getItem("room") || "global");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [onlineUsers, setOnlineUsers] = useState([]);
  const [typingUser, setTypingUser] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [page, setPage] = useState(1);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnected, setIsConnected] = useState(true);
  const messagesEndRef = useRef(null);
  const containerRef = useRef(null);
  const loadingRef = useRef(false);

  const MESSAGES_PER_PAGE = 20;
  const audio = new Audio("/notification.mp3");

  // --- Login and Socket Setup ---
  const handleLogin = () => {
    if (!username.trim()) return alert("Enter username");
    localStorage.setItem("username", username);
    localStorage.setItem("room", room);
    socket.connect();
    socket.emit("join", { username, room });
    setLoggedIn(true);
    Notification.requestPermission();
  };

  const handleLogout = () => {
    localStorage.clear();
    socket.disconnect();
    setLoggedIn(false);
  };

  useEffect(() => {
    socket.on("connect", () => setIsConnected(true));
    socket.on("disconnect", () => setIsConnected(false));
    socket.on("receiveMessage", (msg) => {
      setMessages((prev) => [...prev, msg]);
      setUnreadCount((prev) => prev + 1);
      showNotification(msg);
    });
    socket.on("onlineUsers", setOnlineUsers);
    socket.on("typing", ({ username, isTyping }) => setTypingUser(isTyping ? username : ""));
    socket.on("reactionUpdate", (msg) =>
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)))
    );
    return () => socket.off();
  }, []);

  const showNotification = (msg) => {
    if (Notification.permission === "granted") {
      new Notification(`${msg.sender}`, { body: msg.text });
      audio.play().catch(() => {});
    }
  };

  // --- Pagination ---
  const fetchOlderMessages = async (page) => {
    return new Array(MESSAGES_PER_PAGE).fill(0).map((_, i) => ({
      id: `old-${page}-${i}`,
      sender: "User" + ((page * MESSAGES_PER_PAGE + i) % 5 + 1),
      text: `Older message ${page * MESSAGES_PER_PAGE + i}`,
      timestamp: Date.now() - (page * MESSAGES_PER_PAGE + i) * 60000,
      reactions: [],
    }));
  };

  const handleScroll = useCallback(async () => {
    const container = containerRef.current;
    if (container.scrollTop === 0 && !loadingRef.current) {
      loadingRef.current = true;
      const olderMessages = await fetchOlderMessages(page);
      if (olderMessages.length > 0) {
        setMessages((prev) => [...olderMessages, ...prev]);
        setPage((prev) => prev + 1);
        container.scrollTop = 50;
      }
      loadingRef.current = false;
    }
  }, [page]);

  useEffect(() => {
    const container = containerRef.current;
    if (container) container.addEventListener("scroll", handleScroll);
    return () => container?.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    if (!loadingRef.current)
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // --- Message actions ---
  const sendMessage = () => {
    if (!message.trim()) return;
    socket.emit("sendMessage", { text: message }, () => setMessage(""));
    setUnreadCount(0);
  };

  const handleTyping = (e) => {
    setMessage(e.target.value);
    socket.emit("typing", e.target.value.length > 0);
  };

  const handleFileUpload = async (e) => {
    const formData = new FormData();
    formData.append("file", e.target.files[0]);
    const res = await axios.post("http://localhost:4000/upload", formData);
    socket.emit("sendMessage", { text: `[File] ${res.data.url}` });
  };

  const handleReaction = (msgId, reaction) => {
    socket.emit("react", { messageId: msgId, reaction });
  };

  const handleRoomChange = (e) => {
    const newRoom = e.target.value;
    setRoom(newRoom);
    setMessages([]);
    localStorage.setItem("room", newRoom);
    socket.emit("join", { username, room: newRoom });
  };

  const filteredMessages = messages.filter((m) =>
    m.text.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // --- UI ---
  return (
    <div className="flex justify-center items-center min-h-screen bg-gradient-to-r from-blue-100 via-white to-blue-50">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-5">
        {!loggedIn ? (
          <div className="space-y-3">
            <h1 className="text-2xl font-bold text-center text-blue-600">Welcome to Socket Chat 💬</h1>
            <input
              type="text"
              placeholder="Enter username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="border rounded-lg p-2 w-full focus:ring-2 focus:ring-blue-500 outline-none"
            />
            <select
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              className="border rounded-lg p-2 w-full focus:ring-2 focus:ring-blue-500 outline-none"
            >
              <option value="global">🌍 Global Chat</option>
              <option value="developers">💻 Developers</option>
              <option value="designers">🎨 Designers</option>
              <option value="support">🛠️ Support</option>
            </select>
            <button
              onClick={handleLogin}
              className="bg-blue-600 hover:bg-blue-700 text-white p-2 rounded-lg w-full transition"
            >
              Join Chat
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <h2 className="font-semibold text-blue-700">Room: {room}</h2>
              <button
                onClick={handleLogout}
                className="text-red-500 hover:underline text-sm"
              >
                Logout
              </button>
            </div>

            {!isConnected && (
              <div className="text-red-500 text-sm mb-2">Reconnecting...</div>
            )}

            <div className="bg-gray-50 rounded-lg p-3">
              <h3 className="text-sm font-medium mb-1 text-gray-700">
                Online Users ({onlineUsers.length})
              </h3>
              <div className="flex flex-wrap gap-2">
                {onlineUsers.map((u, i) => (
                  <span
                    key={i}
                    className="text-sm bg-blue-100 text-blue-700 px-2 py-1 rounded-full"
                  >
                    {u.username}
                  </span>
                ))}
              </div>
            </div>

            <input
              type="text"
              placeholder="Search messages..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="border rounded-lg p-2 w-full focus:ring-2 focus:ring-blue-500 outline-none"
            />

            <div
              ref={containerRef}
              className="border rounded-lg p-3 h-72 overflow-y-auto bg-gray-50"
            >
              {filteredMessages.map((m, i) => {
                const isMine = m.sender === username;
                return (
                  <div
                    key={m.id}
                    className={`mb-2 flex ${
                      isMine ? "justify-end" : "justify-start"
                    }`}
                  >
                    <div
                      className={`p-2 max-w-[80%] rounded-lg ${
                        isMine
                          ? "bg-blue-600 text-white rounded-br-none"
                          : "bg-gray-200 text-gray-800 rounded-bl-none"
                      }`}
                    >
                      <p className="text-sm">
                        <span className="font-semibold">{m.sender}</span>:{" "}
                        {m.text.startsWith("[File]") ? (
                          <a
                            href={m.text.split(" ")[1]}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline"
                          >
                            File
                          </a>
                        ) : (
                          m.text
                        )}
                      </p>
                      <p className="text-xs text-gray-300 mt-1">
                        {new Date(m.timestamp).toLocaleTimeString()}
                      </p>
                      <div className="mt-1 flex space-x-1 text-sm">
                        {m.reactions?.map((r, i) => (
                          <span key={i}>{r.reaction}</span>
                        ))}
                        <button
                          onClick={() => handleReaction(m.id, "❤️")}
                          className="hover:scale-110 transition"
                        >
                          ❤️
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
              <div ref={messagesEndRef}></div>
            </div>

            {typingUser && (
              <p className="text-gray-500 text-sm italic">{typingUser} is typing...</p>
            )}

            {unreadCount > 0 && (
              <p className="text-green-600 text-sm">
                🔔 {unreadCount} new messages
              </p>
            )}

            <div className="flex flex-col space-y-2">
              <input
                type="text"
                value={message}
                onChange={handleTyping}
                onKeyDown={(e) => e.key === "Enter" && sendMessage()}
                className="border rounded-lg p-2 w-full focus:ring-2 focus:ring-blue-500 outline-none"
                placeholder="Type a message..."
              />
              <input
                type="file"
                onChange={handleFileUpload}
                className="text-sm text-gray-500"
              />
              <button
                onClick={sendMessage}
                className="bg-blue-600 hover:bg-blue-700 text-white font-semibold p-2 rounded-lg transition"
              >
                Send
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
