const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

const CANVAS_W = 900, CANVAS_H = 600;
const PLAYER_SPEED = 3, PLAYER_SIZE = 36;
const TICK_RATE = 60;

const ORDER_TYPES = [
  { name: 'Tomato Salad',  items: ['tomato'],           score: 100, time: 35 },
  { name: 'Lettuce Salad', items: ['lettuce'],          score: 100, time: 35 },
  { name: 'Mixed Salad',   items: ['tomato','lettuce'], score: 200, time: 50 },
];

const STATIONS = {
  tomatoCrate:  { x: 40,  y: 80,  w: 70, h: 70, type: 'crate',   item: 'tomato_raw',  label: 'Tomato',  color: '#c0392b' },
  lettuceCrate: { x: 40,  y: 200, w: 70, h: 70, type: 'crate',   item: 'lettuce_raw', label: 'Lettuce', color: '#27ae60' },
  board1:       { x: 280, y: 80,  w: 80, h: 80, type: 'board',   id: 'board1',        label: 'CHOP',    color: '#d35400' },
  board2:       { x: 420, y: 80,  w: 80, h: 80, type: 'board',   id: 'board2',        label: 'CHOP',    color: '#d35400' },
  plate:        { x: 300, y: 460, w: 80, h: 80, type: 'plate',   label: 'PLATE',      color: '#bdc3c7' },
  service:      { x: 730, y: 50,  w: 130,h: 90, type: 'service', label: 'SERVE',      color: '#8e44ad' },
  trash:        { x: 730, y: 460, w: 80, h: 80, type: 'trash',   label: 'TRASH',      color: '#7f8c8d' },
};

let rooms = {};
const ROOM_ID = 'kitchen1';

function createRoom(id) {
  return {
    roomId: id, players: {},
    boards: {
      board1: { item: null, progress: 0 },
      board2: { item: null, progress: 0 },
    },
    plate: { items: [] }, orders: [], score: 0,
    timeLeft: 180, started: false,
    timerInterval: null, orderInterval: null,
  };
}

function spawnOrder(room) {
  if (room.orders.length >= 4) return;
  const tpl = ORDER_TYPES[Math.floor(Math.random() * ORDER_TYPES.length)];
  room.orders.push({ ...tpl, id: Date.now() + Math.random(), timeLeft: tpl.time });
}

function startGame(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  room.started = true;
  spawnOrder(room);
  io.to(roomId).emit('gameStarted');

  room.timerInterval = setInterval(() => {
    if (!rooms[roomId]) return clearInterval(room.timerInterval);
    room.timeLeft--;
    room.orders.forEach(o => {
      o.timeLeft--;
      if (o.timeLeft <= 0) {
        room.score = Math.max(0, room.score - 50);
        room.orders = room.orders.filter(x => x.id !== o.id);
        spawnOrder(room);
      }
    });
    if (room.timeLeft <= 0) {
      clearInterval(room.timerInterval);
      clearInterval(room.orderInterval);
      io.to(roomId).emit('gameOver', { score: room.score });
    }
  }, 1000);

  room.orderInterval = setInterval(() => {
    if (!rooms[roomId]) return;
    spawnOrder(room);
  }, 20000);
}

function getStationAt(px, py) {
  const hs = PLAYER_SIZE / 2;
  for (const [key, s] of Object.entries(STATIONS)) {
    if (px+hs > s.x && px-hs < s.x+s.w && py+hs > s.y && py-hs < s.y+s.h)
      return { key, ...s };
  }
  return null;
}

function tryServeFromPlate(room, socket) {
  const cutItems = room.plate.items
    .filter(i => i.endsWith('_cut'))
    .map(i => i.replace('_cut',''))
    .sort();
  if (!cutItems.length) return;
  for (let i = 0; i < room.orders.length; i++) {
    const o = room.orders[i];
    if (JSON.stringify([...o.items].sort()) === JSON.stringify(cutItems)) {
      room.score += o.score;
      room.orders.splice(i, 1);
      room.plate.items = [];
      spawnOrder(room);
      io.to(room.roomId).emit('scored', { score: room.score, order: o.name });
      return;
    }
  }
  socket.emit('wrongDish');
}

io.on('connection', (socket) => {
  if (!rooms[ROOM_ID]) rooms[ROOM_ID] = createRoom(ROOM_ID);
  const room = rooms[ROOM_ID];

  if (Object.keys(room.players).length >= 2) {
    socket.emit('roomFull');
    return;
  }

  socket.join(ROOM_ID);
  const pNum = Object.keys(room.players).length === 0 ? 1 : 2;
  room.players[socket.id] = {
    id: socket.id, num: pNum,
    x: pNum === 1 ? 160 : 620, y: 320,
    held: null,
    color: pNum === 1 ? '#3498db' : '#e91e63',
    keys: { up:false, down:false, left:false, right:false, action:false },
  };

  socket.emit('init', { playerNum: pNum, stations: STATIONS, CANVAS_W, CANVAS_H, PLAYER_SIZE });
  io.to(ROOM_ID).emit('playerJoined', { num: pNum, total: Object.keys(room.players).length });

  if (Object.keys(room.players).length === 2 && !room.started)
    setTimeout(() => startGame(ROOM_ID), 2000);

  // Physics + cutting (server-side)
  const moveLoop = setInterval(() => {
    const p = room.players[socket.id];
    if (!p || !room.started) return;
    if (p.keys.left)  p.x = Math.max(PLAYER_SIZE/2, p.x - PLAYER_SPEED);
    if (p.keys.right) p.x = Math.min(CANVAS_W - PLAYER_SIZE/2, p.x + PLAYER_SPEED);
    if (p.keys.up)    p.y = Math.max(PLAYER_SIZE/2, p.y - PLAYER_SPEED);
    if (p.keys.down)  p.y = Math.min(CANVAS_H - PLAYER_SIZE/2, p.y + PLAYER_SPEED);

    if (p.keys.action) {
      const st = getStationAt(p.x, p.y);
      if (st && st.type === 'board') {
        const b = room.boards[st.id];
        if (b && b.item && b.item.endsWith('_raw')) {
          b.progress = Math.min(100, b.progress + 1.0);
          if (b.progress >= 100) b.item = b.item.replace('_raw', '_cut');
        }
      }
    }
  }, 1000 / TICK_RATE);

  // Broadcast at 20fps
  const broadcastLoop = setInterval(() => {
    if (rooms[ROOM_ID] && room.started) {
      io.to(ROOM_ID).emit('state', {
        players: room.players, boards: room.boards,
        plate: room.plate, orders: room.orders,
        score: room.score, timeLeft: room.timeLeft,
      });
    }
  }, 50);

  socket.on('keys', (k) => {
    if (room.players[socket.id]) room.players[socket.id].keys = k;
  });

  socket.on('interact', () => {
    const p = room.players[socket.id];
    if (!p || !room.started) return;
    const st = getStationAt(p.x, p.y);
    if (!st) { p.held = null; return; }

    if (st.type === 'crate') {
      if (!p.held) p.held = st.item;

    } else if (st.type === 'board') {
      const b = room.boards[st.id];
      if (!b) return;
      if (p.held && !b.item)      { b.item = p.held; b.progress = 0; p.held = null; }
      else if (!p.held && b.item) { p.held = b.item; b.item = null; b.progress = 0; }

    } else if (st.type === 'plate') {
      if (p.held && p.held.endsWith('_cut'))     { room.plate.items.push(p.held); p.held = null; }
      else if (!p.held && room.plate.items.length) p.held = room.plate.items.pop();

    } else if (st.type === 'service') {
      if (p.held && p.held.endsWith('_cut')) {
        const itemName = p.held.replace('_cut','');
        for (let i = 0; i < room.orders.length; i++) {
          const o = room.orders[i];
          if (o.items.length === 1 && o.items[0] === itemName) {
            room.score += o.score; room.orders.splice(i,1); p.held = null;
            spawnOrder(room);
            io.to(ROOM_ID).emit('scored', { score: room.score, order: o.name });
            return;
          }
        }
        socket.emit('wrongDish');
      } else if (!p.held) {
        tryServeFromPlate(room, socket);
      }

    } else if (st.type === 'trash') {
      p.held = null; room.plate.items = [];
    }
  });

  socket.on('disconnect', () => {
    clearInterval(moveLoop); clearInterval(broadcastLoop);
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.timerInterval); clearInterval(room.orderInterval);
      delete rooms[ROOM_ID];
    } else {
      io.to(ROOM_ID).emit('playerLeft', { num: pNum });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🍳 Cooking Game on port ${PORT}`));