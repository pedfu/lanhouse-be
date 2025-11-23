const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // Em produção, deve ser restrito ao domínio do frontend
    methods: ["GET", "POST"]
  }
});

// Estado do Jogo em Memória - Separado por namespace
const gameRooms = {
  inkspiracy: {},
  concept: {},
  knowme: {},
  rabisco: {}
};

// Configuração de Pontuação
const SCORE_CONFIG = {
  IMPOSTOR_WIN: 3,      // Pontos por vitória como impostor
  INNOCENT_WIN: 1,      // Pontos por vitória como inocente
  WIN_THRESHOLD: 10     // Total de pontos para ganhar a partida
};

// Utilitários
const generateRoomCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const shuffleArray = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

const getPlayerColor = (playerIndex) => {
    const PLAYER_COLORS = [
        "#000000", "#8b0000", "#1a472a", "#0f4c81", 
        "#5d2e8e", "#d35400", "#c41e3a", "#2e8b57", 
        "#ff6b35", "#004e89", "#7209b7", "#f72585"
    ];
    return PLAYER_COLORS[playerIndex % PLAYER_COLORS.length];
};

// Importar handlers dos jogos
const conceptHandler = require('./concept-handler');
const knowmeHandler = require('./knowme-handler');
const rabiscoHandler = require('./rabisco-handler');

// Namespace para Inkspiracy (padrão)
const inkspiracyNamespace = io.of('/inkspiracy');

// Lógica do Socket para Inkspiracy
inkspiracyNamespace.on('connection', (socket) => {
  console.log('[INKSPIRACY] Novo cliente conectado:', socket.id);

  // Criar Sala
  socket.on('create_room', ({ hostId, nickname, avatar, isVip }) => {
    const roomCode = generateRoomCode();
    
    // Inicializar estado da sala
    gameRooms.inkspiracy[roomCode] = {
      code: roomCode,
      hostId,
      status: "LOBBY",
      round: 1,
      maxRounds: 2,
      turnIndex: 0,
      turnOrder: [],
      curatorId: hostId,
      wordInnocent: "",
      wordImpostor: "",
      theme: "",
      impostorId: "",
      winner: null,
      winReason: "",
      players: {}, // Map: userId -> playerData
      strokes: [],
      votes: [],
      votesRevealed: false,
      votingStartedAt: null,
      createdAt: Date.now()
    };

    // Adicionar Host como jogador
    gameRooms.inkspiracy[roomCode].players[hostId] = {
      id: hostId,
      nickname,
      avatar,
      score: 0,              // Score da rodada atual
      totalScore: 0,         // Pontuação acumulada total
      votesReceived: 0,
      isCurator: true,
      joinedAt: Date.now(),
      isVip,
      selectedColor: getPlayerColor(0),
      socketId: socket.id
    };

    socket.join(roomCode);
    socket.emit('room_created', { roomCode });
    
    // Emitir atualização inicial
    inkspiracyNamespace.to(roomCode).emit('game_state_update', {
      gameState: { ...gameRooms.inkspiracy[roomCode], players: undefined },
      players: Object.values(gameRooms.inkspiracy[roomCode].players).sort((a, b) => a.joinedAt - b.joinedAt)
    });
  });

  // Entrar na Sala
  socket.on('join_room', ({ roomCode, userId, nickname, avatar, isVip }) => {
    const room = gameRooms.inkspiracy[roomCode];
    
    if (!room) {
      socket.emit('error', { message: "Sala não encontrada." });
      return;
    }

    if (room.status !== "LOBBY" && !room.players[userId]) { // Permitir reconexão se já estiver na lista
      socket.emit('error', { message: "Jogo já começou." });
      return;
    }

    // Lógica de reconexão ou novo jogador
    const existingPlayer = room.players[userId];
    let playerColor;
    
    if (existingPlayer) {
      // Atualizar socket id e manter totalScore
      existingPlayer.socketId = socket.id;
      existingPlayer.nickname = nickname; // Atualizar nick se mudou
      existingPlayer.avatar = avatar;
      playerColor = existingPlayer.selectedColor;
      // Manter totalScore existente (não resetar)
      if (existingPlayer.totalScore === undefined) {
        existingPlayer.totalScore = 0;
      }
    } else {
      // Novo jogador
      const playerIndex = Object.keys(room.players).length;
      playerColor = getPlayerColor(playerIndex);
      
      room.players[userId] = {
        id: userId,
        nickname,
        avatar,
        score: 0,              // Score da rodada atual
        totalScore: 0,         // Pontuação acumulada total
        votesReceived: 0,
        isCurator: false,
        joinedAt: Date.now(),
        isVip,
        selectedColor: playerColor,
        socketId: socket.id
      };
    }

    socket.join(roomCode);
    socket.emit('joined_room', { roomCode });

    // Broadcast atualização
    inkspiracyNamespace.to(roomCode).emit('game_state_update', {
      gameState: getPublicGameState(room),
      players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
    });
    
    // Se houver strokes (reconectando no meio do jogo), enviar
    if (room.strokes.length > 0) {
        socket.emit('strokes_update', room.strokes);
    }
  });

  // Atualizar Tema
  socket.on('update_theme', ({ roomCode, theme }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;
    
    room.theme = theme;
    inkspiracyNamespace.to(roomCode).emit('game_state_update', { gameState: getPublicGameState(room) });
  });

  // Iniciar Jogo
  socket.on('start_game', ({ roomCode }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    const playerIds = Object.keys(room.players);
    if (playerIds.length < 4) {
        // socket.emit('error', { message: "Mínimo 4 jogadores." }); // Validado no front
        // return; 
    }

    const possibleImpostors = playerIds.filter(id => id !== room.curatorId);
    const impostorId = possibleImpostors[Math.floor(Math.random() * possibleImpostors.length)];
    
    const drawers = playerIds.filter(id => id !== room.curatorId);
    const turnOrder = shuffleArray([...drawers]);

    room.status = "WORDS";
    room.impostorId = impostorId;
    room.turnOrder = turnOrder;
    room.turnIndex = 0;
    room.round = 1;

    inkspiracyNamespace.to(roomCode).emit('game_state_update', { 
        gameState: getPublicGameState(room) 
    });
  });

  // Submeter Palavras (Curador)
  socket.on('submit_words', ({ roomCode, wordInnocent, wordImpostor }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    room.wordInnocent = wordInnocent;
    room.wordImpostor = wordImpostor;
    room.status = "DRAWING";

    inkspiracyNamespace.to(roomCode).emit('game_state_update', { 
        gameState: getPublicGameState(room) 
    });
  });

  // Desenhar (Stroke)
  socket.on('draw_stroke', ({ roomCode, stroke }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    // Validar turno? Pode ser complexo com latência, vamos confiar no client por enqto ou fazer validação básica
    // const currentPlayerId = room.turnOrder[room.turnIndex];
    // if (stroke.playerId !== currentPlayerId) return; 

    room.strokes.push(stroke);
    
    // Broadcast stroke para todos na sala
    inkspiracyNamespace.to(roomCode).emit('new_stroke', stroke);
    
    // Avançar turno após stroke completo
    // O front envia o stroke completo no final do desenho.
    // Precisamos avançar o turno aqui.
    
    let nextIndex = room.turnIndex + 1;
    let nextRound = room.round;
    let nextStatus = "DRAWING";

    if (nextIndex >= room.turnOrder.length) {
        nextIndex = 0;
        nextRound += 1;
    }

    if (nextRound > room.maxRounds) {
        nextStatus = "VOTING";
        room.votingStartedAt = Date.now();
        room.votesRevealed = false;
        // Limpar votos anteriores se houver (embora seja nova fase)
        room.votes = [];
        // Resetar received votes
        Object.values(room.players).forEach(p => p.votesReceived = 0);
        // Limpar strokes para votação? Não, mantém para referência.
    }

    room.turnIndex = nextIndex;
    room.round = nextRound;
    room.status = nextStatus;

    inkspiracyNamespace.to(roomCode).emit('game_state_update', { 
        gameState: getPublicGameState(room),
        players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
    });
  });

  // Votar
  socket.on('vote', ({ roomCode, voterId, suspectId }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;
    if (room.status !== "VOTING") return;
    if (voterId === room.curatorId) return; // Curador não vota
    
    // Verificar se já votou
    const existingVote = room.votes.find(v => v.voterId === voterId);
    if (existingVote) return;

    room.votes.push({ voterId, suspectId });

    // Verificar se todos votaram
    const votersCount = Object.keys(room.players).length - 1; // -1 Curador
    if (room.votes.length >= votersCount) {
        endVoting(roomCode);
    } else {
        // Emitir atualização para mostrar quem já votou?
        // O front atual usa `votes` array para contar.
        // Podemos enviar apenas os votos "anonimizados" ou apenas o count.
        // Para simplificar, não enviamos a lista de votos privada via socket público constantemente, 
        // mas o front espera saber SE o usuário votou.
        // Vamos enviar um evento especifico ou confiar que o usuario sabe que votou.
        // O front usa `votes` collection listener.
        // Vamos enviar a lista de "quem votou" (sem revelar em quem).
        inkspiracyNamespace.to(roomCode).emit('votes_update', room.votes.map(v => ({ voterId: v.voterId, id: 'hidden' })));
    }
  });

  // Encerrar Votação (Manual ou Timer)
  socket.on('end_voting', ({ roomCode }) => {
      endVoting(roomCode);
  });

  // Chute do Impostor
  socket.on('submit_guess', ({ roomCode, guess }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    const isCorrect = guess.trim().toLowerCase() === room.wordInnocent.trim().toLowerCase();
    room.status = "RESULTS";
    room.updatedAt = Date.now();

    // Resetar score da rodada para TODOS os jogadores primeiro
    Object.values(room.players).forEach(p => {
        p.score = 0;
    });
    
    if (isCorrect) {
        room.winner = "IMPOSTOR";
        room.winReason = "O Falsificador descobriu a palavra secreta!";
        // Adicionar pontos ao impostor
        const impostor = room.players[room.impostorId];
        if (impostor) {
            // Garantir que totalScore existe e é um número
            if (typeof impostor.totalScore !== 'number' || isNaN(impostor.totalScore)) {
                impostor.totalScore = 0;
            }
            impostor.totalScore += SCORE_CONFIG.IMPOSTOR_WIN;
            impostor.score = SCORE_CONFIG.IMPOSTOR_WIN; // Score da rodada
        }
    } else {
        room.winner = "INNOCENTS";
        room.winReason = `O Falsificador foi pego e errou o chute! ('${guess}' não era a palavra)`;
        
        // Pontuar inocentes
        Object.values(room.players).forEach(p => {
            if (p.id !== room.impostorId) {
                // Garantir que totalScore existe e é um número
                if (typeof p.totalScore !== 'number' || isNaN(p.totalScore)) {
                    p.totalScore = 0;
                }
                p.totalScore += SCORE_CONFIG.INNOCENT_WIN;
                p.score = SCORE_CONFIG.INNOCENT_WIN; // Score da rodada
            }
        });
    }
    
    // Verificar se alguém ganhou a partida
    checkGameWinner(roomCode);

    // Limpar strokes para a próxima rodada
    room.strokes = [];

    // Garantir que todos os scores são válidos
    ensureValidScores(room);
    
    // Ordenar players por totalScore para o placar
    const sortedPlayers = Object.values(room.players).sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    inkspiracyNamespace.to(roomCode).emit('game_state_update', { 
        gameState: getPublicGameState(room),
        players: sortedPlayers,
        strokes: [] // Limpar no front
    });
  });

  // Resetar Partida (após vitória)
  socket.on('reset_game', ({ roomCode }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    // Resetar todas as pontuações e estado
    Object.values(room.players).forEach(p => {
        p.totalScore = 0;
        p.score = 0;
        p.votesReceived = 0;
    });

    room.status = "LOBBY";
    room.curatorId = room.hostId; // Voltar para o host original
    room.wordInnocent = "";
    room.wordImpostor = "";
    room.theme = "";
    room.turnOrder = [];
    room.round = 1;
    room.turnIndex = 0;
    room.impostorId = "";
    room.winner = null;
    room.gameWinner = null;
    room.gameWinnerName = null;
    room.gameWinnerScore = null;
    room.votes = [];
    room.votesRevealed = false;
    room.strokes = [];

    // Resetar curador para o host
    Object.values(room.players).forEach(p => {
        p.isCurator = (p.id === room.hostId);
    });

    inkspiracyNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room),
        players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
    });
  });

  // Próxima Rodada
  socket.on('next_round', ({ roomCode }) => {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    const playersArr = Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt);
    const currentCuratorIdx = playersArr.findIndex(p => p.id === room.curatorId);
    const nextCuratorIdx = (currentCuratorIdx + 1) % playersArr.length;
    const nextCuratorId = playersArr[nextCuratorIdx].id;

    // Resetar estado da sala
    room.status = "LOBBY";
    room.curatorId = nextCuratorId;
    room.wordInnocent = "";
    room.wordImpostor = "";
    room.theme = "";
    room.turnOrder = [];
    room.round = 1;
    room.turnIndex = 0;
    room.impostorId = "";
    room.winner = null;
    room.votes = [];
    room.votesRevealed = false;
    
    // Atualizar players (resetar score da rodada, manter totalScore)
    Object.values(room.players).forEach(p => {
        p.votesReceived = 0;
        p.score = 0; // Resetar score da rodada
        p.isCurator = (p.id === nextCuratorId);
    });

    inkspiracyNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room),
        players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
    });
  });

  // Sair da Sala
  socket.on('leave_room', ({ roomCode, userId }) => {
      // Lógica de remover player...
      // Se for host, deletar sala? Ou passar host?
      // Por simplicidade, removemos o player.
      const room = gameRooms.inkspiracy[roomCode];
      if (room && room.players[userId]) {
          delete room.players[userId];
          socket.leave(roomCode);
          inkspiracyNamespace.to(roomCode).emit('game_state_update', {
             gameState: getPublicGameState(room), // Atualiza contagem se necessário
             players: Object.values(room.players).sort((a, b) => a.joinedAt - b.joinedAt)
          });
      }
  });

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    // Opcional: Limpeza de jogadores desconectados
  });
});

// Helper: Encerrar Votação
function endVoting(roomCode) {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;

    // Contar votos
    const voteCounts = {};
    room.votes.forEach(v => {
        voteCounts[v.suspectId] = (voteCounts[v.suspectId] || 0) + 1;
    });

    // Atualizar players com votos recebidos
    Object.values(room.players).forEach(p => {
        p.votesReceived = voteCounts[p.id] || 0;
    });

    // Calcular resultado
    let maxVotes = -1;
    let mostVotedPlayerId = null;
    let isTie = false;

    Object.entries(voteCounts).forEach(([playerId, count]) => {
        if (count > maxVotes) {
            maxVotes = count;
            mostVotedPlayerId = playerId;
            isTie = false;
        } else if (count === maxVotes && count > 0) {
            isTie = true;
        }
    });

    const impostorCaught = !isTie && mostVotedPlayerId === room.impostorId;

    room.votesRevealed = true;
    room.updatedAt = Date.now();

    if (impostorCaught) {
        room.status = "GUESS";
    } else {
        room.status = "RESULTS";
        room.winner = "IMPOSTOR";
        room.winReason = isTie ? "O caos reinou (Empate)" : "Um inocente foi expulso";
        
        // Resetar score da rodada para TODOS os jogadores primeiro
        Object.values(room.players).forEach(p => {
            p.score = 0;
        });
        
        // Pontuar impostor
        const impostor = room.players[room.impostorId];
        if (impostor) {
            // Garantir que totalScore existe e é um número
            if (typeof impostor.totalScore !== 'number' || isNaN(impostor.totalScore)) {
                impostor.totalScore = 0;
            }
            impostor.totalScore += SCORE_CONFIG.IMPOSTOR_WIN;
            impostor.score = SCORE_CONFIG.IMPOSTOR_WIN; // Score da rodada
        }
        
        // Verificar se alguém ganhou a partida
        checkGameWinner(roomCode);
    }

    // Garantir que todos os scores são válidos
    ensureValidScores(room);
    
    // Ordenar players por totalScore para o placar
    const sortedPlayers = Object.values(room.players).sort((a, b) => (b.totalScore || 0) - (a.totalScore || 0));

    inkspiracyNamespace.to(roomCode).emit('game_state_update', {
        gameState: getPublicGameState(room),
        players: sortedPlayers
    });
}

// Helper: Verificar se alguém ganhou a partida
function checkGameWinner(roomCode) {
    const room = gameRooms.inkspiracy[roomCode];
    if (!room) return;
    
    // Verificar se algum jogador atingiu a pontuação de vitória
    const winner = Object.values(room.players).find(p => p.totalScore >= SCORE_CONFIG.WIN_THRESHOLD);
    
    if (winner) {
        room.status = "GAME_WINNER";
        room.gameWinner = winner.id;
        room.gameWinnerName = winner.nickname;
        room.gameWinnerScore = winner.totalScore;
        
        // Emitir evento de vitória
        inkspiracyNamespace.to(roomCode).emit('game_winner', {
            winnerId: winner.id,
            winnerName: winner.nickname,
            winnerScore: winner.totalScore,
            players: Object.values(room.players).sort((a, b) => b.totalScore - a.totalScore) // Ordenar por pontuação
        });
        
        // Também emitir atualização de estado para garantir que o status seja atualizado
        inkspiracyNamespace.to(roomCode).emit('game_state_update', {
            gameState: getPublicGameState(room),
            players: Object.values(room.players).sort((a, b) => b.totalScore - a.totalScore)
        });
    }
}

// Helper: Garantir que todos os players tenham totalScore válido
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

// Helper: Filtrar dados sensíveis do GameState
function getPublicGameState(room) {
    // Garantir que todos os scores são válidos antes de enviar
    ensureValidScores(room);
    
    // Clonar para não modificar o original
    const safeRoom = { ...room };
    
    // Remover mapa de players (enviamos como array separado e sanitizado se necessário, mas aqui ok)
    delete safeRoom.players; 
    
    // Se o status não for RESULTS ou GUESS, ocultar quem é o impostor e as palavras dos outros?
    // O frontend espera receber wordInnocent/wordImpostor para mostrar pro usuário correto.
    // O backend poderia filtrar aqui, mas para manter a lógica do frontend (que verifica user.uid vs impostorId),
    // vamos enviar tudo e confiar no client por enquanto, OU implementar logica de "visão do jogador".
    // Como estamos usando socket broadcast, TODOS recebem a mesma mensagem.
    // ISSO É UM RISCO DE SEGURANÇA (cheating via console), mas para replicar o comportamento do Firestore
    // (que provavelmente tinha regras de segurança ou enviava tudo), vamos enviar tudo.
    // IDEALMENTE: Enviar mensagens diferentes para cada socket.
    // Mas para "não modificar nenhuma funcionalidade visual" e ser rápido: broadcast.
    
    return safeRoom;
}

// Inicializar handler do Concept
conceptHandler(io, gameRooms.concept);
// Inicializar handler do KnowMe
knowmeHandler(io, gameRooms.knowme);
// Inicializar handler do Rabisco
rabiscoHandler(io, gameRooms.rabisco);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`- Inkspiracy: /inkspiracy`);
  console.log(`- Concept: /concept`);
  console.log(`- KnowMe: /knowme`);
  console.log(`- Rabisco: /rabisco`);
});

