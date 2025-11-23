const words = require('./words');

module.exports = (io, gameRooms) => {
  const rabiscoNamespace = io.of('/rabisco');

  const GAME_CONFIG = {
    ROUNDS: 3, // Rodadas por jogo (cada jogador desenha uma vez por rodada? ou total de desenhos?)
    // Gartic usually: Rounds = number of times everyone draws? Or fixed number of turns?
    // Let's say a "Round" is everyone draws once.
    DRAW_TIME: 80, // seconds
    WORD_SELECTION_TIME: 15,
    HINT_PENALTY: 2,
    MAX_HINTS: 3,
    POINTS_BASE: 10,
    POINTS_DECAY: 1, // Points decrease as more people guess? Or time based? 
    // User says: "pontuacao de acordo com ordem de resposta (quem responde primeiro ganha mais)"
    POINTS_ORDER: [10, 9, 8, 7, 6, 5], // First gets 10, second 9, etc. Min 5.
    DRAWER_POINTS_PER_GUESS: 2,
    COINS_PER_POINT: 1, // 1 point = 1 coin
    SABOTAGE_PRICES: {
      invisible_ink: 15,
      earthquake: 10,
      censorship: 12,
      mirror: 8
    }
  };

  const getRandomWords = (count = 3) => {
    const shuffled = [...words].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, count);
  };

  const generateRoomCode = () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  };

  const getNextDrawer = (room) => {
    const currentDrawerIndex = room.players.findIndex(p => p.id === room.currentDrawerId);
    let nextIndex = currentDrawerIndex + 1;
    if (nextIndex >= room.players.length) {
      nextIndex = 0;
      room.round++;
    }
    return room.players[nextIndex];
  };

  rabiscoNamespace.on('connection', (socket) => {
    console.log('[RABISCO] New connection:', socket.id);

    socket.on('create_room', ({ hostId, nickname, avatar }) => {
      socket.data.userId = hostId; // Store userId in socket session
      const roomCode = generateRoomCode();
      
      gameRooms[roomCode] = {
        code: roomCode,
        hostId,
        status: 'LOBBY', // LOBBY, CHOOSING_WORD, DRAWING, ROUND_END, GAME_END
        round: 1,
        maxRounds: GAME_CONFIG.ROUNDS,
        players: [],
        currentDrawerId: null,
        currentWord: null,
        wordOptions: [],
        hints: [],
        timeLeft: 0,
        timer: null,
        strokes: [],
        guessedPlayers: [], // List of IDs who guessed correctly this turn
        sabotagesActive: {}, // { type: 'earthquake', targetId: '...', expiresAt: timestamp }
        chatMessages: [],
        maxScore: 120, // Pontuação alvo para vencer (customizável)
      };

      // Add host
      const newPlayer = {
        id: hostId,
        nickname,
        avatar,
        score: 0,
        coins: 0,
        socketId: socket.id,
        inventory: [] // ['earthquake', 'mirror']
      };
      gameRooms[roomCode].players.push(newPlayer);

      socket.join(roomCode);
      socket.emit('room_created', { roomCode });
      broadcastState(roomCode);
    });

    socket.on('join_room', ({ roomCode, userId, nickname, avatar }) => {
      socket.data.userId = userId; // Store userId in socket session
      const room = gameRooms[roomCode];
      if (!room) return socket.emit('error', { message: 'Room not found' });

      const existingPlayer = room.players.find(p => p.id === userId);
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.nickname = nickname;
        existingPlayer.avatar = avatar;
      } else {
        if (room.status !== 'LOBBY') return socket.emit('error', { message: 'Game already started' });
        room.players.push({
          id: userId,
          nickname,
          avatar,
          score: 0,
          coins: 0,
          socketId: socket.id,
          inventory: []
        });
      }

      socket.join(roomCode);
      socket.emit('joined_room', { roomCode });
      broadcastState(roomCode);
    });

    socket.on('start_game', ({ roomCode, maxScore }) => {
      const room = gameRooms[roomCode];
      if (!room || room.hostId !== getUserId(socket)) return;

      if (maxScore) room.maxScore = parseInt(maxScore);
      
      room.status = 'CHOOSING_WORD';
      room.round = 1;
      // Shuffle players for turn order
      room.players.sort(() => 0.5 - Math.random());
      
      room.currentDrawerId = room.players[0].id;
      room.wordOptions = getRandomWords(3);
      room.timeLeft = GAME_CONFIG.WORD_SELECTION_TIME;
      
      startTimer(roomCode);
      broadcastState(roomCode);
    });

    socket.on('choose_word', ({ roomCode, wordObj }) => {
      const room = gameRooms[roomCode];
      if (!room || room.currentDrawerId !== getUserId(socket)) return;

      room.currentWord = wordObj.text; // wordObj from the options
      room.status = 'DRAWING';
      room.timeLeft = GAME_CONFIG.DRAW_TIME;
      room.strokes = [];
      room.guessedPlayers = [];
      room.hints = []; // Clear hints
      room.lengthRevealed = false; // Reset length reveal
      room.sabotagesActive = {}; // Clear sabotages? Or keep them? Maybe clear per turn.
      
      // Auto-generate hints placeholder
      // E.g. "Banana" -> "_ _ _ _ _ _"
      // We can reveal randomly later
      
      startTimer(roomCode);
      broadcastState(roomCode);
    });

    socket.on('give_hint', ({ roomCode }) => {
       const room = gameRooms[roomCode];
       if (!room || room.currentDrawerId !== getUserId(socket)) return;
       
       // Find unrevealed indices
       const word = room.currentWord;
       const unrevealed = [];
       for (let i = 0; i < word.length; i++) {
           if (word[i] !== ' ' && !room.hints.includes(i)) {
               unrevealed.push(i);
           }
       }

       // Check if reveal would exceed limit (30%)
       // Total revealable chars (excluding spaces)
       const totalRevealable = word.replace(/ /g, '').length;
       const currentRevealed = room.hints.length;
       const limit = Math.ceil(totalRevealable * 0.3);

       if (currentRevealed >= limit) {
           // Send error to drawer
           const drawerSocketId = room.players.find(p => p.id === room.currentDrawerId)?.socketId;
           if (drawerSocketId) {
                rabiscoNamespace.to(drawerSocketId).emit('chat_message', {
                    id: Date.now(),
                    type: 'system-error',
                    text: 'Máximo de dicas atingido!',
                    author: 'Sistema'
                });
           }
           return;
       }
       
       // First hint reveals the length of the word (effectively just showing the empty slots)
       if (room.hints.length === 0) {
           // Just add a dummy hint marker that doesn't correspond to an index to signal "length revealed"
           // Or better: Use a specific flag or state.
           // Actually, user said "first hint always must be quantity of characters".
           // This implies that BEFORE the first hint, the quantity of characters is HIDDEN.
           // So we need a state `lengthRevealed`.
           room.lengthRevealed = true;
           
           // Penalty for first hint (length reveal)?
           const drawer = room.players.find(p => p.id === room.currentDrawerId);
           if (drawer) {
               drawer.score = Math.max(0, drawer.score - GAME_CONFIG.HINT_PENALTY);
           }
           broadcastState(roomCode);
           return;
       }

       if (unrevealed.length > 0) {
           const idx = unrevealed[Math.floor(Math.random() * unrevealed.length)];
           room.hints.push(idx);
           
           // Penalty?
           const drawer = room.players.find(p => p.id === room.currentDrawerId);
           if (drawer) {
               drawer.score = Math.max(0, drawer.score - GAME_CONFIG.HINT_PENALTY);
           }

           broadcastState(roomCode);
       }
    });

    socket.on('draw_stroke', ({ roomCode, stroke }) => {
      const room = gameRooms[roomCode];
      if (!room || room.status !== 'DRAWING') return;
      // Only drawer can draw
      if (room.currentDrawerId !== getUserId(socket)) return;

      room.strokes.push(stroke);
      // Broadcast stroke to everyone (optimization: avoid full state broadcast)
      socket.to(roomCode).emit('new_stroke', stroke);
    });

    socket.on('undo_stroke', ({ roomCode }) => {
      const room = gameRooms[roomCode];
      if (!room || room.status !== 'DRAWING') return;
      if (room.currentDrawerId !== getUserId(socket)) return;

      if (room.strokes.length > 0) {
          room.strokes.pop();
          // Broadcast full state or specific undo event?
          // Broadcasting full state is safer to ensure sync
          // Or emit 'undo_last_stroke'
          rabiscoNamespace.to(roomCode).emit('stroke_undone');
      }
    });

    socket.on('clear_canvas', ({ roomCode }) => {
      const room = gameRooms[roomCode];
      if (!room || room.currentDrawerId !== getUserId(socket)) return;
      room.strokes = [];
      rabiscoNamespace.to(roomCode).emit('canvas_cleared');
    });

    socket.on('send_message', ({ roomCode, message }) => {
      const room = gameRooms[roomCode];
      if (!room) return;
      const userId = getUserId(socket);
      const player = room.players.find(p => p.id === userId);
      
      if (!player) return;

      // Logic for guessing
      if (room.status === 'DRAWING' && userId !== room.currentDrawerId && !room.guessedPlayers.includes(userId)) {
        const cleanMessage = message.trim().toLowerCase();
        const cleanWord = room.currentWord ? room.currentWord.trim().toLowerCase() : '';
        
        if (cleanMessage === cleanWord) {
          // Correct guess!
          handleCorrectGuess(room, player);
          return; // Don't show message in chat to avoid spoiling, show "Guessed correctly!"
        } else {
           // Check for close guess
           // 1. High similarity (Levenshtein)
           // 2. Word contained in message (e.g. "is it apple?") -> actually we usually want exact word, but Gartic checks if you typed ALMOST the word.
           // Let's stick to:
           // - Similarity > 0.75
           // - Or if the word is short (>3 chars) and the message contains the word or vice versa? No, that reveals it.
           // - Just Levenshtein for typos.
           
           const sim = similarity(cleanMessage, cleanWord);
           
           // Check if substring (e.g. user typed "caval" for "cavalo")
           // Only if word is long enough
           let isSubstring = false;
           if (cleanWord.length >= 4 && cleanWord.includes(cleanMessage) && cleanMessage.length >= cleanWord.length - 2) {
               isSubstring = true;
           }

           if (sim > 0.75 || isSubstring) {
               // Notify ONLY this user
               socket.emit('chat_message', { 
                 id: Date.now(), 
                 text: `Está perto!`, 
                 author: 'Sistema', 
                 type: 'system-near' 
               });
               
               // Also show the message to everyone? 
               // If it's close, usually we show it but tell the user they are close.
               // Or we can hide it from others if it's REALLY close to avoid spoiling.
               // Gartic: Shows message + "Está perto" toast.
           }
        }
      }

      // Broadcast message
      const chatMsg = {
        id: Date.now(),
        text: message,
        author: player.nickname,
        authorId: userId,
        type: 'user'
      };
      
      // If player already guessed, they can only chat with others who guessed (or drawer)
      // But simple version: everyone sees chat except the answer if it's correct.
      
      rabiscoNamespace.to(roomCode).emit('chat_message', chatMsg);
    });

    socket.on('buy_sabotage', ({ roomCode, itemId }) => {
       const room = gameRooms[roomCode];
       if(!room) return;
       const player = room.players.find(p => p.id === getUserId(socket));
       if(!player) return;
       
       const price = GAME_CONFIG.SABOTAGE_PRICES[itemId];
       if (price && player.coins >= price) {
         player.coins -= price;
         player.inventory.push(itemId);
         broadcastState(roomCode);
         // Emit individual update for sound/feedback?
       }
    });

    socket.on('use_sabotage', ({ roomCode, itemId, targetId }) => {
      const room = gameRooms[roomCode];
      if(!room) return;
      const player = room.players.find(p => p.id === getUserId(socket));
      if(!player) return;

      const itemIndex = player.inventory.indexOf(itemId);
      if(itemIndex === -1) return;

      // Apply effect
      // Sabotages target the drawer usually? Or anyone?
      // "Sabotage against current drawer or other guessers"
      
      const target = targetId ? targetId : room.currentDrawerId; // Default to drawer if not specified

      // Remove from inventory
      player.inventory.splice(itemIndex, 1);
      
      // Activate effect
      const sabotageId = Date.now() + Math.random();
      room.sabotagesActive[sabotageId] = {
        type: itemId,
        sourceId: player.id,
        targetId: target,
        startTime: Date.now(),
        duration: 5000 // 5 seconds duration for most
      };
      
      if (itemId === 'invisible_ink') {
          // Special handling?
      }

      rabiscoNamespace.to(roomCode).emit('sabotage_triggered', {
        type: itemId,
        sourceName: player.nickname,
        targetId: target
      });

      // Auto remove after duration
      setTimeout(() => {
         delete room.sabotagesActive[sabotageId];
         // broadcast update?
         rabiscoNamespace.to(roomCode).emit('sabotage_ended', { type: itemId, targetId });
      }, 5000); // 5s duration

      broadcastState(roomCode);
    });

    socket.on('disconnect', () => {
      // Handle disconnect
    });

  });

  // Helper functions
  function getUserId(socket) {
    // Check socket.data (set during join/create) first, then handshake auth
    return socket.data.userId || socket.handshake.auth.userId || null;
  }
  // Just search in rooms for now for simplicity in this hackathon-style code
  function getUserIdFromRoom(room, socketId) {
      const p = room.players.find(p => p.socketId === socketId);
      return p ? p.id : null;
  }
  
  // Override getUserId to use the room context passed implicitly or loop
  // Actually, let's just fix the calls above to use payload userId where trusted,
  // or find player by socketId.
  
  function handleCorrectGuess(room, player) {
     if (room.guessedPlayers.includes(player.id)) return;
     
     room.guessedPlayers.push(player.id);
     
     // Calculate points
     const order = room.guessedPlayers.length - 1;
     let points = GAME_CONFIG.POINTS_ORDER[order] || 5;
     
     // Penalty if hints were revealed
     if (room.hints.length > 0) {
         points = Math.max(1, points - (room.hints.length * 2));
     }
     
     player.score += points;
     player.coins += points * GAME_CONFIG.COINS_PER_POINT;
     
     // Drawer gets points too
     const drawer = room.players.find(p => p.id === room.currentDrawerId);
     if (drawer) {
       drawer.score += GAME_CONFIG.DRAWER_POINTS_PER_GUESS;
       drawer.coins += GAME_CONFIG.DRAWER_POINTS_PER_GUESS;
     }
     
     rabiscoNamespace.to(room.code).emit('player_guessed', { 
       playerId: player.id, 
       nickname: player.nickname,
       score: points 
     });

     // Check if everyone guessed
     const guessersCount = room.players.length - 1;
     if (room.guessedPlayers.length >= guessersCount) {
        endTurn(room);
     } else {
        broadcastState(room.code);
     }
  }

  function startTimer(roomCode) {
    const room = gameRooms[roomCode];
    if (room.timer) clearInterval(room.timer);
    
    room.timer = setInterval(() => {
      room.timeLeft -= 1;
      
      // Always pulse timer
      rabiscoNamespace.to(roomCode).emit('timer_pulse', room.timeLeft);

      if (room.timeLeft <= 0) {
        clearInterval(room.timer);
        if (room.status === 'CHOOSING_WORD') {
            // Player fell asleep: Skip Turn
            handleSkipTurn(room);
        } else if (room.status === 'DRAWING') {
            endTurn(room);
        }
        broadcastState(roomCode);
      }
    }, 1000);
  }

  function handleSkipTurn(room) {
      // Notify everyone
      rabiscoNamespace.to(room.code).emit('chat_message', {
          id: Date.now(),
          type: 'system-error',
          text: 'Jogador dormiu no ponto e perdeu a vez!',
          author: 'Sistema'
      });

      // Move to next drawer without scoring or revealing (since nothing to reveal)
      const nextPlayer = getNextDrawer(room);
      
      // Check for game end conditions
      const winner = room.players.find(p => p.score >= room.maxScore);
      if (winner || room.round > room.maxRounds) {
           room.status = 'GAME_END';
           broadcastState(room.code);
           return;
      }

      // Set up next turn
      room.currentDrawerId = nextPlayer.id;
      room.status = 'CHOOSING_WORD';
      room.wordOptions = getRandomWords(3);
      room.timeLeft = GAME_CONFIG.WORD_SELECTION_TIME;
      room.strokes = [];
      room.guessedPlayers = [];
      room.sabotagesActive = {};
      room.lengthRevealed = false;
      
      startTimer(room.code);
      broadcastState(room.code);
  }

  function endTurn(room) {
    if (room.timer) clearInterval(room.timer);
    room.status = 'ROUND_END';
    
    // Reveal word
    rabiscoNamespace.to(room.code).emit('round_end', { word: room.currentWord });
    
    setTimeout(() => {
       // Prepare next turn
       const nextPlayer = getNextDrawer(room);
       // Check for game end?
       // Check if max score reached or rounds over
       const winner = room.players.find(p => p.score >= room.maxScore);
       if (winner || room.round > room.maxRounds) { // Logic for maxRounds is tricky with index reset
          // Simply check if everyone drew this round? 
          // Let's just use maxScore as main condition for now.
       }
       
       if (winner) {
           room.status = 'GAME_END';
           broadcastState(room.code);
           return;
       }

       room.currentDrawerId = nextPlayer.id;
       room.status = 'CHOOSING_WORD';
       room.wordOptions = getRandomWords(3);
       room.timeLeft = GAME_CONFIG.WORD_SELECTION_TIME;
       room.strokes = [];
       room.guessedPlayers = [];
       room.sabotagesActive = {};
       room.lengthRevealed = false;
       
       startTimer(room.code);
       broadcastState(room.code);
    }, 5000); // 5s intermission
    
    broadcastState(room.code);
  }

  function broadcastState(roomCode) {
    const room = gameRooms[roomCode];
    if (!room) return;
    
    // Construct masked word for hints
    let maskedWord = null;
    if (room.currentWord) {
        maskedWord = room.currentWord.split('').map((char, i) => 
            (room.hints.includes(i) || char === ' ' || char === '-') ? char : null
        );
    }
    
    // Sanitize state for public
    // Don't send word to guessers during drawing
    const publicState = {
        ...room,
        timer: undefined, // remove interval object
        wordOptions: undefined, // hide options unless drawer
        currentWord: (room.status === 'DRAWING' || room.status === 'CHOOSING_WORD') ? null : room.currentWord,
        wordLength: (room.currentWord && (room.status === 'ROUND_END' || room.status === 'GAME_END' || room.lengthRevealed || room.currentDrawerId === getUserIdFromRoom(room, null))) ? room.currentWord.length : 0, // Hide length unless revealed
        maskedWord: (room.lengthRevealed || room.status === 'ROUND_END') ? maskedWord : null
    };
    
    // Send full state to drawer?
    // We can filter on client or send specific messages. 
    // For simplicity, we send masked data to everyone, and specific data to drawer via separate event if needed.
    // Or just send 2 messages.
    
    rabiscoNamespace.to(roomCode).emit('game_state', publicState);
    
    // Send secret data to drawer
    if (room.currentDrawerId) {
        const drawerSocketId = room.players.find(p => p.id === room.currentDrawerId)?.socketId;
        if (drawerSocketId) {
            rabiscoNamespace.to(drawerSocketId).emit('drawer_data', {
                word: room.currentWord,
                options: room.wordOptions
            });
        }
    }
  }

  // Simple string similarity
  function similarity(s1, s2) {
    if (s1 === s2) return 1;
    if (!s1 || !s2) return 0;

    // Levenshtein Distance
    const track = Array(s2.length + 1).fill(null).map(() =>
        Array(s1.length + 1).fill(null));
    for (let i = 0; i <= s1.length; i += 1) { track[0][i] = i; }
    for (let j = 0; j <= s2.length; j += 1) { track[j][0] = j; }
    for (let j = 1; j <= s2.length; j += 1) {
        for (let i = 1; i <= s1.length; i += 1) {
            const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
            track[j][i] = Math.min(
                track[j][i - 1] + 1, // deletion
                track[j - 1][i] + 1, // insertion
                track[j - 1][i - 1] + indicator, // substitution
            );
        }
    }
    const distance = track[s2.length][s1.length];
    const maxLength = Math.max(s1.length, s2.length);
    return 1 - (distance / maxLength);
  }
};

