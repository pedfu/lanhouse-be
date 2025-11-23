// Handler para o jogo Concept/Iconografia
const WORDS_DB = require('./words');

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

// Normalizar string para comparação
const normalizeString = (str) => {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
};

// Verificar se duas strings são similares (fuzzy matching)
const isCloseMatch = (guess, target) => {
  const normalizedGuess = normalizeString(guess);
  const normalizedTarget = normalizeString(target);
  
  if (normalizedGuess === normalizedTarget) return true;
  if (normalizedTarget.includes(normalizedGuess) || normalizedGuess.includes(normalizedTarget)) {
    return true;
  }
  
  // Levenshtein distance simples
  const distance = levenshteinDistance(normalizedGuess, normalizedTarget);
  const maxLength = Math.max(normalizedGuess.length, normalizedTarget.length);
  const similarity = 1 - (distance / maxLength);
  
  return similarity > 0.7;
};

const levenshteinDistance = (str1, str2) => {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
};

function getPublicGameState(room) {
  const safeRoom = { ...room };
  delete safeRoom.players;
  delete safeRoom.timerInterval;
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

module.exports = (io, conceptRooms) => {
  const conceptNamespace = io.of('/concept');
  
  conceptNamespace.on('connection', (socket) => {
    console.log('[CONCEPT] Novo cliente conectado:', socket.id);

    // Criar Sala
    socket.on('create_room', ({ hostId, nickname, avatar, isVip }) => {
      const roomCode = generateRoomCode();
      
      conceptRooms[roomCode] = {
        code: roomCode,
        hostId,
        gameType: 'concept',
        status: "LOBBY",
        currentTeam: [], // [PlayerA_ID, PlayerB_ID] - Mestres dos Ícones
        currentWord: {
          text: "",
          difficulty: "",
          category: ""
        },
        blockedCategory: null, // Categoria bloqueada pelos rivais
        sabotageVotes: {}, // userId -> categoryId
        wordOptions: [], // 3 opções para votação
        wordVotes: {}, // userId -> difficulty
        boardState: [], // [{ iconId, type, color, placedBy, timestamp }]
        placedOrder: [], // Ordem de colocação para replay
        players: {},
        chatMessages: [],
        round: 1,
        timer: 0,
        roundStartTime: 0,
        maxRoundTime: 120, // 2 minutos (Mais tempo para pensar)
        timerInterval: null,
        createdAt: Date.now()
      };

      conceptRooms[roomCode].players[hostId] = {
        id: hostId,
        nickname,
        avatar,
        score: 0,
        totalScore: 0,
        joinedAt: Date.now(),
        isVip,
        selectedColor: getPlayerColor(0),
        socketId: socket.id,
        isMaster: false
      };

      socket.join(roomCode);
      socket.emit('room_created', { roomCode });
      
      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(conceptRooms[roomCode]),
        players: Object.values(conceptRooms[roomCode].players).sort((a, b) => a.joinedAt - b.joinedAt)
      });
    });

    // Entrar na Sala
    socket.on('join_room', ({ roomCode, userId, nickname, avatar, isVip }) => {
      const room = conceptRooms[roomCode];
      
      if (!room) {
        socket.emit('error', { message: "Sala não encontrada." });
        return;
      }

      if (room.status !== "LOBBY" && !room.players[userId]) {
        socket.emit('error', { message: "Jogo já começou." });
        return;
      }

      const existingPlayer = room.players[userId];
      let playerColor;
      
      if (existingPlayer) {
        existingPlayer.socketId = socket.id;
        existingPlayer.nickname = nickname;
        existingPlayer.avatar = avatar;
        playerColor = existingPlayer.selectedColor;
        if (existingPlayer.totalScore === undefined) {
          existingPlayer.totalScore = 0;
        }
      } else {
        const playerIndex = Object.keys(room.players).length;
        playerColor = getPlayerColor(playerIndex);
        
        conceptRooms[roomCode].players[userId] = {
          id: userId,
          nickname,
          avatar,
          score: 0,
          totalScore: 0,
          joinedAt: Date.now(),
          isVip,
          selectedColor: playerColor,
          socketId: socket.id,
          isMaster: false
        };
      }

      socket.join(roomCode);
      socket.emit('joined_room', { roomCode });

      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room),
        players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
      });
    });

    // Iniciar Jogo - Selecionar Mestres dos Ícones
    socket.on('start_game', ({ roomCode }) => {
      const room = conceptRooms[roomCode];
      if (!room) return;

      const playerIds = Object.keys(room.players);
      if (playerIds.length < 2) {
        socket.emit('error', { message: "Mínimo 2 jogadores." });
        return;
      }

      // Resetar status de mestre para todos
      Object.values(room.players).forEach(p => p.isMaster = false);

      // Selecionar mestres (1 se apenas 2 jogadores, senão 2)
      const numMasters = playerIds.length === 2 ? 1 : 2;
      const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
      room.currentTeam = shuffled.slice(0, numMasters);
      
      // Marcar como mestres
      room.currentTeam.forEach(id => {
        if (room.players[id]) {
          room.players[id].isMaster = true;
        }
      });

      room.status = "CHOOSING_WORD";
      
      // Gerar 3 opções de palavras aleatórias do banco (Fácil, Médio, Difícil)
      room.wordOptions = [
        WORDS_DB.filter(w => w.difficulty === 'EASY').sort(() => 0.5 - Math.random())[0],
        WORDS_DB.filter(w => w.difficulty === 'MEDIUM').sort(() => 0.5 - Math.random())[0],
        WORDS_DB.filter(w => w.difficulty === 'HARD').sort(() => 0.5 - Math.random())[0]
      ];
      room.wordVotes = {};

      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room),
        players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
      });
    });

    // Votar na palavra
    socket.on('vote_word', ({ roomCode, userId, difficulty }) => {
      const room = conceptRooms[roomCode];

      if (!room || room.status !== "CHOOSING_WORD") return;

      if (!room.currentTeam.includes(userId)) {
          return; // Apenas mestres podem votar
      }

      room.wordVotes[userId] = difficulty;

      const masters = room.currentTeam;
      const mastersVoted = masters.every(id => room.wordVotes[id]);

      if (mastersVoted) {
        // Escolher palavra baseada nos votos (prioridade para dificuldade maior)
        const voteCounts = { EASY: 0, MEDIUM: 0, HARD: 0 };
        // Contar apenas votos dos mestres para garantir
        masters.forEach(id => {
            const vote = room.wordVotes[id];
            if (vote) voteCounts[vote]++;
        });
        
        let selectedDifficulty = 'HARD';
        if (voteCounts.HARD === 0 && voteCounts.MEDIUM > 0) selectedDifficulty = 'MEDIUM';
        else if (voteCounts.HARD === 0 && voteCounts.MEDIUM === 0) selectedDifficulty = 'EASY';
        
        const selectedWord = room.wordOptions.find(w => w.difficulty === selectedDifficulty);
        room.currentWord = selectedWord;
        
        // FASE DE SABOTAGEM (CURTO-CIRCUITO)
        room.status = "SABOTAGE";
        room.sabotageVotes = {};
        room.blockedCategory = null;
        
        // Timer para sabotagem/planejamento (20s)
        if (room.timerInterval) clearInterval(room.timerInterval);
        room.timer = 20;
        
        room.timerInterval = setInterval(() => {
          room.timer = Math.max(0, room.timer - 1);
          conceptNamespace.to(roomCode).emit('timer_update', { timer: room.timer, roomCode });

          if (room.timer <= 0) {
            clearInterval(room.timerInterval);
            startRound(roomCode, conceptNamespace); // Inicia rodada mesmo sem votos
          }
        }, 1000);
      }

      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room)
      });
    });

    // Votar para Sabotar Categoria
    socket.on('vote_sabotage', ({ roomCode, userId, categoryId }) => {
      const room = conceptRooms[roomCode];
      if (!room || room.status !== "SABOTAGE") return;

      // Mestres não podem sabotar a própria rodada
      if (room.currentTeam.includes(userId)) return;

      room.sabotageVotes[userId] = categoryId;

      // Verificar se todos os rivais votaram
      const rivals = Object.keys(room.players).filter(id => !room.currentTeam.includes(id));
      const allRivalsVoted = rivals.every(id => room.sabotageVotes[id]);

      if (allRivalsVoted) {
        // Contar votos
        const voteCounts = {};
        Object.values(room.sabotageVotes).forEach(cat => {
          voteCounts[cat] = (voteCounts[cat] || 0) + 1;
        });

        // Pegar categoria mais votada
        const winningCategory = Object.keys(voteCounts).reduce((a, b) => voteCounts[a] > voteCounts[b] ? a : b);
        room.blockedCategory = winningCategory;

        clearInterval(room.timerInterval);
        startRound(roomCode, conceptNamespace);
      }
    });

    // Função auxiliar para iniciar a rodada
    function startRound(roomCode, ioNamespace) {
      const room = conceptRooms[roomCode];
      room.status = "PLAYING";
      room.boardState = [];
      room.placedOrder = [];
      room.tokensPlaced = 0;
      room.roundStartTime = Date.now();

      // Se bloqueio não foi definido por votos (tempo acabou), escolhe aleatório dos votos ou nada
      if (!room.blockedCategory && Object.keys(room.sabotageVotes).length > 0) {
         const votes = Object.values(room.sabotageVotes);
         room.blockedCategory = votes[Math.floor(Math.random() * votes.length)];
      }

      // Iniciar Timer da Rodada
      if (room.timerInterval) clearInterval(room.timerInterval);
      room.timer = room.maxRoundTime;

      room.timerInterval = setInterval(() => {
        room.timer = Math.max(0, room.timer - 1);
        ioNamespace.to(roomCode).emit('timer_update', { timer: room.timer, roomCode });

        if (room.timer <= 0) {
          clearInterval(room.timerInterval);
          room.status = "ROUND_END";
          room.winner = null;
          room.winReason = "O tempo acabou! Ninguém acertou.";
          ioNamespace.to(roomCode).emit('game_state_update', {
            gameState: getPublicGameState(room)
          });
        }
      }, 1000);

      ioNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room)
      });
    }

    // Colocar peça no tabuleiro
    socket.on('place_token', ({ roomCode, userId, iconId, tool }) => {
      const room = conceptRooms[roomCode];
      if (!room || room.status !== "PLAYING") return;

      // Verificar se é um dos mestres
      if (!room.currentTeam.includes(userId)) {
        socket.emit('error', { message: "Apenas os Mestres dos Ícones podem colocar peças." });
        return;
      }

      // Validar: primeiro deve ser o Conceito Principal (Verde)
      if (room.boardState.length === 0 && tool.type !== 'MAIN_CONCEPT') {
        socket.emit('error', { message: "Coloque o peão de Conceito Principal (Verde) primeiro!" });
        return;
      }

      // Validar: Apenas 1 Conceito Principal permitido por vez (Substituição Automática)
      if (tool.type === 'MAIN_CONCEPT') {
        const existingMainIndex = room.boardState.findIndex(t => t.type === 'MAIN_CONCEPT');
        if (existingMainIndex !== -1) {
             // Remove o antigo automaticamente
             const oldToken = room.boardState[existingMainIndex];
             room.boardState.splice(existingMainIndex, 1);
             
             // Remove do histórico de replay também para manter consistência visual
             room.placedOrder = room.placedOrder.filter(t => 
                !(t.iconId === oldToken.iconId && t.type === 'MAIN_CONCEPT')
             );
             
             conceptNamespace.to(roomCode).emit('token_removed', { iconId: oldToken.iconId, userId: oldToken.placedBy });
        }
      }

      // Validar: categoria bloqueada?
      // Precisamos saber a categoria do ícone. Como não tenho o banco de ícones aqui no server (está no front),
      // vou confiar que o front bloqueia visualmente, mas idealmente deveria validar aqui.
      // Se você tiver a lista de ícones aqui, use-a. Por enquanto, vamos passar essa validação.
      // TODO: Importar ICONS e validar categoryId

      // Adicionar ao tabuleiro
      const token = {
        iconId,
        type: tool.type,
        color: tool.color,
        placedBy: userId,
        timestamp: Date.now()
      };

      room.boardState.push(token);
      room.placedOrder.push({ ...token, order: room.placedOrder.length + 1 });
      room.tokensPlaced = (room.tokensPlaced || 0) + 1;

      conceptNamespace.to(roomCode).emit('token_placed', token);
      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room)
      });
    });

    // Remover peça do tabuleiro
    socket.on('remove_token', ({ roomCode, userId, iconId }) => {
      const room = conceptRooms[roomCode];
      if (!room || room.status !== "PLAYING") return;

      if (!room.currentTeam.includes(userId)) {
        socket.emit('error', { message: "Apenas os Mestres dos Ícones podem remover peças." });
        return;
      }

      room.boardState = room.boardState.filter(t => !(t.iconId === iconId && t.placedBy === userId));
      room.placedOrder = room.placedOrder.filter(t => !(t.iconId === iconId && t.placedBy === userId));

      conceptNamespace.to(roomCode).emit('token_removed', { iconId, userId });
      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room)
      });
    });

    // Limpar tabuleiro
    socket.on('clear_board', ({ roomCode, userId }) => {
      const room = conceptRooms[roomCode];
      if (!room || room.status !== "PLAYING") return;

      if (!room.currentTeam.includes(userId)) {
        socket.emit('error', { message: "Apenas os Mestres dos Ícones podem limpar o tabuleiro." });
        return;
      }

      room.boardState = [];
      room.placedOrder = [];

      conceptNamespace.to(roomCode).emit('board_cleared');
      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room)
      });
    });

    // Mensagem de chat
    socket.on('chat_message', ({ roomCode, userId, text }) => {
      const room = conceptRooms[roomCode];
      if (!room) return;

      // Bloquear chat dos mestres (exceto se quiserem dar dicas escritas, mas a regra é não falar)
      // Vamos permitir visualização, mas impedir que o sistema considere como tentativa de acerto
      // Ou bloquear totalmente o envio. O user pediu: "mestres não deveriam poder digitar e acertar"
      if (room.currentTeam.includes(userId)) {
         // Se quiser bloquear envio: 
         // return; 
         // Mas talvez queiram conversar? Vamos permitir chat mas NÃO validar acerto.
      }

      const player = room.players[userId];
      if (!player) return;

      const message = {
        id: Date.now().toString(),
        userId,
        playerName: player.nickname,
        text,
        timestamp: Date.now(),
        isMaster: room.currentTeam.includes(userId)
      };

      room.chatMessages.push(message);
      conceptNamespace.to(roomCode).emit('chat_message', message);

      // Se for mestre, não valida acerto
      if (room.currentTeam.includes(userId)) return;

      // Verificar se acertou a palavra
      const isCorrect = isCloseMatch(text, room.currentWord.text);
      if (isCorrect && normalizeString(text) === normalizeString(room.currentWord.text)) {
        // Acerto exato - fim da rodada
        if (room.timerInterval) clearInterval(room.timerInterval);
        
        room.status = "ROUND_END";
        
        // Cálculo de Pontuação Dinâmica (Overload)
        // Base: 10 pts. Reduz 1 pt a cada 3 dicas (tokensPlaced). Mínimo 2 pts.
        const penalty = Math.floor((room.tokensPlaced || 0) / 3);
        let scoreBase = Math.max(2, 10 - penalty);
        
        // Bônus de Velocidade (Alta Voltagem)
        const timeUsed = (Date.now() - room.roundStartTime) / 1000;
        if (timeUsed < 30) {
            scoreBase += 5; // +5 pts se acertar em menos de 30s
        }

        // Pontos para o vencedor
        player.totalScore += scoreBase;
        player.score = scoreBase; // Score da rodada
        
        // Pontos para os mestres (metade do score, mín 1)
        const masterScore = Math.max(1, Math.floor(scoreBase / 2));
        room.currentTeam.forEach(id => {
          if (room.players[id]) {
            room.players[id].totalScore += masterScore;
            room.players[id].score = masterScore;
          }
        });
        
        room.winner = userId;
        room.winReason = `${player.nickname} acertou a palavra! (+${scoreBase} pts)`;

        ensureValidScores(room);
        conceptNamespace.to(roomCode).emit('round_ended', {
          winner: player.nickname,
          word: room.currentWord.text,
          score: scoreBase
        });
        
        conceptNamespace.to(roomCode).emit('game_state_update', {
            gameState: getPublicGameState(room),
            players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
        });

      } else if (isCloseMatch(text, room.currentWord.text)) {
        // Quase lá - notificar mestres
        conceptNamespace.to(roomCode).emit('close_guess', {
          playerName: player.nickname,
          guess: text
        });
      }
    });

    // Botão "Ding!" (Quase lá)
    socket.on('ding', ({ roomCode, userId }) => {
      const room = conceptRooms[roomCode];
      if (!room) return;

      if (!room.currentTeam.includes(userId)) {
        socket.emit('error', { message: "Apenas os Mestres dos Ícones podem usar o Ding!" });
        return;
      }

      conceptNamespace.to(roomCode).emit('ding_activated', {
        activatedBy: userId
      });
    });

    // Próxima rodada
    socket.on('next_round', ({ roomCode }) => {
      const room = conceptRooms[roomCode];
      if (!room) return;

      // Rotacionar mestres (selecionar próximos 2 jogadores)
      const playerIds = Object.keys(room.players).sort((a, b) => 
        room.players[a].joinedAt - room.players[b].joinedAt
      );
      
      const currentIndex = playerIds.indexOf(room.currentTeam[0]);
      const nextIndex = (currentIndex + 2) % playerIds.length;
      
      // Resetar mestres anteriores
      room.currentTeam.forEach(id => {
        if (room.players[id]) {
          room.players[id].isMaster = false;
        }
      });

      // Selecionar novos mestres
      // Ajuste para modo 2 jogadores
      const numMasters = playerIds.length === 2 ? 1 : 2;
      
      room.currentTeam = [];
      for(let i=0; i<numMasters; i++) {
          const idx = (nextIndex + i) % playerIds.length;
          room.currentTeam.push(playerIds[idx]);
      }

      room.currentTeam.forEach(id => {
        if (room.players[id]) {
          room.players[id].isMaster = true;
        }
      });

      room.status = "CHOOSING_WORD";
      room.currentWord = { text: "", difficulty: "", category: "" };
      room.boardState = [];
      room.placedOrder = [];
      room.wordVotes = {};
      room.sabotageVotes = {};
      room.blockedCategory = null;
      room.chatMessages = [];
      room.tokensPlaced = 0;
      if (room.timerInterval) clearInterval(room.timerInterval);
      room.timer = 0;
      room.round += 1;

      // Gerar novas opções de palavras aleatórias
      room.wordOptions = [
        WORDS_DB.filter(w => w.difficulty === 'EASY').sort(() => 0.5 - Math.random())[0],
        WORDS_DB.filter(w => w.difficulty === 'MEDIUM').sort(() => 0.5 - Math.random())[0],
        WORDS_DB.filter(w => w.difficulty === 'HARD').sort(() => 0.5 - Math.random())[0]
      ];

      conceptNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room),
        players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
      });
    });

    // Sair da Sala
    socket.on('leave_room', ({ roomCode, userId }) => {
      const room = conceptRooms[roomCode];
      if (room && room.players[userId]) {
        delete room.players[userId];
        socket.leave(roomCode);
        conceptNamespace.to(roomCode).emit('game_state_update', {
          gameState: getPublicGameState(room),
          players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
        });
      }
    });

    socket.on('disconnect', () => {
      console.log('[CONCEPT] Cliente desconectado:', socket.id);
    });
  });
};

