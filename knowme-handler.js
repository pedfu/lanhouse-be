const CONCEPTS = require('./concepts');

const generateRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const getPlayerColor = (playerIndex) => {
  const PLAYER_COLORS = [
    "#000000", "#8b0000", "#1a472a", "#0f4c81", 
    "#5d2e8e", "#d35400", "#c41e3a", "#2e8b57", 
    "#ff6b35", "#004e89", "#7209b7", "#f72585"
  ];
  return PLAYER_COLORS[playerIndex % PLAYER_COLORS.length];
};

function getPublicGameState(room) {
  const safeRoom = { ...room };
  delete safeRoom.players;
  
  // Always hide target position by default.
  // We inject it selectively via broadcastGameState.
  if (room.status !== 'REVEAL' && room.status !== 'ROUND_END') {
      delete safeRoom.targetPosition;
  }

  return safeRoom;
}

function ensureValidScores(room) {
  Object.values(room.players).forEach(p => {
    if (typeof p.totalScore !== 'number' || isNaN(p.totalScore)) {
      p.totalScore = 0;
    }
    if (typeof p.score !== 'number' || isNaN(p.score)) {
      p.score = 0;
    }
  });
}

module.exports = (io, knowmeRooms) => {
  const knowmeNamespace = io.of('/knowme');
  
  // Helper to broadcast state with role-based visibility
  const broadcastGameState = (roomCode) => {
      const room = knowmeRooms[roomCode];
      if (!room) return;
      
      const playersList = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
      const publicState = getPublicGameState(room);
      
      // Iterate over players to send personalized state
      Object.values(room.players).forEach(player => {
          if (player.socketId) {
              const isMaster = (player.id === room.currentMasterId);
              
              // Clone state for this specific player
              const stateToSend = { ...publicState };
              
              // Inject private info for Master
              // Master needs to see targetPosition during CLUE_WRITING and GUESSING
              if (isMaster && (room.status === 'CLUE_WRITING' || room.status === 'GUESSING')) {
                  stateToSend.targetPosition = room.targetPosition;
              }
              
              knowmeNamespace.to(player.socketId).emit('game_state_update', {
                  gameState: stateToSend,
                  players: playersList
              });
          }
      });
  };
  
  knowmeNamespace.on('connection', (socket) => {
    console.log('[KNOWME] Novo cliente conectado:', socket.id);

    // Create Room
    socket.on('create_room', ({ hostId, nickname, avatar, isVip }) => {
      const roomCode = generateRoomCode();
      
      knowmeRooms[roomCode] = {
        code: roomCode,
        hostId,
        gameType: 'knowme',
        mode: 'SINGLE', // 'SINGLE' or 'TEAM'
        status: "LOBBY",
        
        currentMasterId: null,
        turnOrder: [],
        turnIndex: 0,
        
        // Game State
        targetPosition: 50, // 0-100
        cardOptions: [], // 3 pairs
        selectedCard: null, // { left: "Hot", right: "Cold" }
        clue: "",
        
        guesses: {}, // userId -> position (0-100)
        
        teams: {
            1: { name: "Equipe 1", score: 0, players: [] },
            2: { name: "Equipe 2", score: 0, players: [] }
        },
        currentTeamTurn: 1, // 1 or 2 (for TEAM mode)
        
        players: {},
        chatMessages: [],
        round: 1,
        createdAt: Date.now()
      };

      knowmeRooms[roomCode].players[hostId] = {
        id: hostId,
        nickname,
        avatar,
        score: 0,
        totalScore: 0,
        joinedAt: Date.now(),
        isVip,
        selectedColor: getPlayerColor(0),
        socketId: socket.id,
        team: 1 // Default team
      };
      
      // Add to team 1
      knowmeRooms[roomCode].teams[1].players.push(hostId);

      socket.join(roomCode);
      socket.emit('room_created', { roomCode });
      
      broadcastGameState(roomCode);
    });

    // Join Room
    socket.on('join_room', ({ roomCode, userId, nickname, avatar, isVip }) => {
      const room = knowmeRooms[roomCode];
      
      if (!room) {
        socket.emit('error', { message: "Sala não encontrada." });
        return;
      }

      const existingPlayer = room.players[userId];
      let playerColor;
      
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.nickname = nickname;
        existingPlayer.avatar = avatar;
        playerColor = existingPlayer.selectedColor;
      } else {
        const playerIndex = Object.keys(room.players).length;
        playerColor = getPlayerColor(playerIndex);
        
        // Assign team (balance)
        const team1Count = room.teams[1].players.length;
        const team2Count = room.teams[2].players.length;
        const assignedTeam = team1Count <= team2Count ? 1 : 2;

        room.players[userId] = {
          id: userId,
          nickname,
          avatar,
          score: 0,
          totalScore: 0,
          joinedAt: Date.now(),
          isVip,
          selectedColor: playerColor,
          socketId: socket.id,
          team: assignedTeam
        };
        
        room.teams[assignedTeam].players.push(userId);
      }

      socket.join(roomCode);
      socket.emit('joined_room', { roomCode });

      broadcastGameState(roomCode);
    });

    // Change Game Mode
    socket.on('set_mode', ({ roomCode, mode }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "LOBBY") return;
        if (mode !== 'SINGLE' && mode !== 'TEAM') return;
        
        room.mode = mode;
        broadcastGameState(roomCode);
    });
    
    // Switch Team
    socket.on('switch_team', ({ roomCode, userId, teamId }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "LOBBY") return;
        
        const player = room.players[userId];
        if (!player) return;
        
        // Remove from old team
        room.teams[player.team].players = room.teams[player.team].players.filter(id => id !== userId);
        
        // Update player
        player.team = teamId;
        
        // Add to new team
        room.teams[teamId].players.push(userId);
        
        broadcastGameState(roomCode);
    });

    // Start Game
    socket.on('start_game', ({ roomCode }) => {
      const room = knowmeRooms[roomCode];
      if (!room) return;

      const playerIds = Object.keys(room.players);
      if (playerIds.length < 2) {
        socket.emit('error', { message: "Mínimo 2 jogadores." });
        return;
      }

      room.turnOrder = playerIds.sort(() => Math.random() - 0.5);
      room.turnIndex = 0;

      if (room.mode === 'SINGLE') {
          room.currentMasterId = room.turnOrder[0];
      } else {
          // TEAM MODE
          // Ensure we pick a master from the current team
          const teamPlayers = room.teams[room.currentTeamTurn].players;
          room.currentMasterId = teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
      }
      
      // Start first turn setup
      startTurn(room);

      broadcastGameState(roomCode);
    });
    
    function startTurn(room) {
        room.status = "SETUP_TURN";
        room.clue = "";
        room.selectedCard = null;
        room.guesses = {};
        
        // Generate 3 random card options
        room.cardOptions = [];
        for (let i = 0; i < 3; i++) {
            const pair = CONCEPTS[Math.floor(Math.random() * CONCEPTS.length)];
            room.cardOptions.push({ left: pair[0], right: pair[1], id: i });
        }
        
        // Generate target position (0-100)
        // In Wavelength it's usually not purely random, but let's assume uniform random 0-100
        room.targetPosition = Math.floor(Math.random() * 101);
    }

    // Master selects card
    socket.on('select_card', ({ roomCode, userId, cardIndex }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "SETUP_TURN") return;
        if (userId !== room.currentMasterId) return;
        
        const card = room.cardOptions[cardIndex];
        if (!card) return;
        
        room.selectedCard = card;
        room.status = "CLUE_WRITING";
        
        broadcastGameState(roomCode);
    });
    
    // Master submits clue
    socket.on('submit_clue', ({ roomCode, userId, clue }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "CLUE_WRITING") return;
        if (userId !== room.currentMasterId) return;
        
        room.clue = clue;
        room.status = "GUESSING";
        
        broadcastGameState(roomCode);
    });
    
    // Player submits guess (Dial Position)
    socket.on('submit_guess', ({ roomCode, userId, position }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "GUESSING") return;
        
        // Master can't guess
        if (userId === room.currentMasterId) return;
        
        if (room.mode === 'SINGLE') {
            room.guesses[userId] = position;
            
            // Check if all players (except master) have guessed
            const players = Object.keys(room.players);
            const guessers = players.filter(id => id !== room.currentMasterId);
            const allGuessed = guessers.every(id => room.guesses[id] !== undefined);
            
            broadcastGameState(roomCode);
        } else {
            // TEAM MODE
            const player = room.players[userId];
            if (player.team === room.currentTeamTurn) {
                room.guesses['TEAM_' + player.team] = position;
            }
        }
    });

    // Confirm Guess (Used for triggering Reveal)
    socket.on('confirm_guess', ({ roomCode, userId }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "GUESSING") return;

        // Logic to transition to REVEAL
        if (room.mode === 'SINGLE') {
             // Let's check if everyone guessed.
             const players = Object.keys(room.players);
             const guessers = players.filter(id => id !== room.currentMasterId);
             const allGuessed = guessers.every(id => room.guesses[id] !== undefined);
             
             if (allGuessed) {
                 calculateScores(room);
                 room.status = "REVEAL";
                 broadcastGameState(roomCode);
             }
        } else {
            // TEAM MODE
            const player = room.players[userId];
            if (player.team === room.currentTeamTurn) {
                 if (room.guesses['TEAM_' + player.team] !== undefined) {
                     calculateScores(room);
                     room.status = "REVEAL";
                     broadcastGameState(roomCode);
                 }
            }
        }
    });

    function calculateScores(room) {
        const target = room.targetPosition;
        
        if (room.mode === 'SINGLE') {
            // Score for each player
            Object.entries(room.guesses).forEach(([pid, guess]) => {
                const diff = Math.abs(target - guess);
                let points = 0;
                // Updated to be strictly within 20% (diff <= 10)
                if (diff <= 2) points = 4;
                else if (diff <= 5) points = 3;
                else if (diff <= 8) points = 2;
                else if (diff <= 10) points = 1; 
                
                const player = room.players[pid];
                if (player) {
                    player.score = points;
                    player.totalScore += points;
                }
            });
            // Master score
            const anyPoints = Object.values(room.players).some(p => p.id !== room.currentMasterId && p.score > 0);
            if (anyPoints) {
                const master = room.players[room.currentMasterId];
                if (master) {
                    master.score = 2; 
                    master.totalScore += 2;
                }
            }
        } else {
            // TEAM MODE
            const teamGuess = room.guesses['TEAM_' + room.currentTeamTurn];
            const diff = Math.abs(target - teamGuess);
            let points = 0;
            // Updated to be strictly within 20% (diff <= 10)
            if (diff <= 2) points = 4;
            else if (diff <= 5) points = 3;
            else if (diff <= 8) points = 2;
            else if (diff <= 10) points = 1;
            
            room.teams[room.currentTeamTurn].score += points;
            
            // "Se a equipe chutar no maior número (4), ela joga novamente."
            room.lastRoundPoints = points;
            
            // Check for win condition (10 points)
            if (room.teams[room.currentTeamTurn].score >= 10) {
                room.status = "GAME_OVER";
                room.winnerTeam = room.currentTeamTurn;
            }
        }
    }

    // Next Round
    socket.on('next_round', ({ roomCode }) => {
        const room = knowmeRooms[roomCode];
        if (!room || room.status !== "REVEAL") return;
        
        // Update turn order
        if (room.mode === 'SINGLE') {
            room.turnIndex = (room.turnIndex + 1) % room.turnOrder.length;
            room.currentMasterId = room.turnOrder[room.turnIndex];
        } else {
            // TEAM MODE
            if (room.lastRoundPoints !== 4) {
                room.currentTeamTurn = room.currentTeamTurn === 1 ? 2 : 1;
            }
            
            const teamPlayers = room.teams[room.currentTeamTurn].players;
            room.currentMasterId = teamPlayers[Math.floor(Math.random() * teamPlayers.length)];
        }
        
        // Reset round scores
         Object.values(room.players).forEach(p => p.score = 0);
        
        startTurn(room);
        
        broadcastGameState(roomCode);
    });
    
    // Leave/Disconnect
    socket.on('leave_room', ({ roomCode, userId }) => {
      const room = knowmeRooms[roomCode];
      if (room && room.players[userId]) {
          delete room.players[userId];
          room.teams[1].players = room.teams[1].players.filter(id => id !== userId);
          room.teams[2].players = room.teams[2].players.filter(id => id !== userId);
          
          socket.leave(roomCode);
          broadcastGameState(roomCode);
      }
    });
  });
};
