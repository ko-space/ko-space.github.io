
/**
 * 코딩 마피아 게임 서버
 * Run: node server.js
 * Open: http://localhost:3000
 */
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MAX_PLAYERS = 16;
const ROLES_CONFIG = { mafia: 3, doctor: 2, police: 2 }; // rest citizens
const PHASES = {
  LOBBY: 'LOBBY',
  SPRINT: 'SPRINT',     // 낮 - 작업 카드
  SABOTAGE: 'SABOTAGE', // 긴급 이슈
  NIGHT: 'NIGHT',       // 밤 - 제거/보호/조사
  MEETING: 'MEETING',   // 회의/투표
  END: 'END'
};

// In-memory game state (single room prototype)
const game = {
  phase: PHASES.LOBBY,
  players: {}, // socketId -> {id, name, role, alive, ready, votedFor, investigatedBy?, protectedBy?}
  order: [],   // socketId array
  hostId: null,
  projectProgress: 0, // 0~100
  dayCount: 0,
  sabotage: null, // { active, deadline, goal, progress }
  votes: {}, // targetId -> count
  night: { kills: null, protects: new Set(), investigations: [] },
  cooldowns: { sabotage: 0 }, // in days
  logs: []
};

// Simple task bank for SPRINT (multiple-choice or quick checks)
const tasks = [
  {
    id: 'bigO1',
    type: 'mcq',
    difficulty: 'easy',
    prompt: '다음 코드의 시간복잡도는? for (i=0;i<n;i++){ for (j=0;j<n;j++){ /*...*/ } }',
    choices: ['O(n)', 'O(n log n)', 'O(n^2)', 'O(log n)'],
    answerIndex: 2,
    progress: 4
  },
  {
    id: 'output1',
    type: 'mcq',
    difficulty: 'easy',
    prompt: '파이썬: print(sum([1,2,3])) 의 출력은?',
    choices: ['6', '123', '에러', 'None'],
    answerIndex: 0,
    progress: 3
  },
  {
    id: 'regex1',
    type: 'mcq',
    difficulty: 'normal',
    prompt: '이메일을 가장 단순히 매치하는 정규식은?(학습용 단순화)',
    choices: ['^.+@.+\\..+$', '^\\w+$', '^http://', '^[0-9]+$'],
    answerIndex: 0,
    progress: 5
  },
  {
    id: 'git1',
    type: 'mcq',
    difficulty: 'normal',
    prompt: 'Git 기본 순서로 적절한 것은?',
    choices: ['commit -> add -> push', 'add -> commit -> push', 'push -> commit -> add', 'clone -> push -> commit'],
    answerIndex: 1,
    progress: 5
  },
  {
    id: 'sql1',
    type: 'mcq',
    difficulty: 'hard',
    prompt: 'SQL: SELECT COUNT(*) FROM Students WHERE grade >= 90 의 의미는?',
    choices: ['모든 학생 수', '학년이 90이상인 학생 수', '점수가 90이상인 학생 수', '학생이 90명인지 확인'],
    answerIndex: 2,
    progress: 7
  },
  {
    id: 'ds1',
    type: 'mcq',
    difficulty: 'easy',
    prompt: '가장 먼저 들어온 데이터를 먼저 처리하는 구조는?',
    choices: ['스택', '큐', '트리', '그래프'],
    answerIndex: 1,
    progress: 3
  }
];

function broadcast() {
  const publicPlayers = Object.values(game.players).map(p => ({
    id: p.id, name: p.name, alive: p.alive, ready: p.ready
  }));
  io.emit('state', {
    phase: game.phase,
    players: publicPlayers,
    youAre: null,
    projectProgress: game.projectProgress,
    dayCount: game.dayCount,
    sabotage: game.sabotage ? {active: game.sabotage.active, goal: game.sabotage.goal, progress: game.sabotage.progress, deadline: game.sabotage.deadline} : null,
    logs: game.logs.slice(-12),
    hostId: game.hostId
  });
}

function personalUpdate(socket) {
  const me = game.players[socket.id];
  if (!me) return;
  socket.emit('you', {
    id: me.id,
    name: me.name,
    role: me.role,
    alive: me.alive
  });
}

function resetVotes() {
  game.votes = {};
  for (const p of Object.values(game.players)) {
    p.votedFor = null;
  }
}

function assignRoles() {
  const ids = game.order.slice();
  // Shuffle
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  const counts = { mafia: ROLES_CONFIG.mafia, doctor: ROLES_CONFIG.doctor, police: ROLES_CONFIG.police };
  for (const id of ids) {
    const p = game.players[id];
    if (!p) continue;
    if (counts.mafia > 0) { p.role = 'mafia'; counts.mafia--; continue; }
    if (counts.doctor > 0) { p.role = 'doctor'; counts.doctor--; continue; }
    if (counts.police > 0) { p.role = 'police'; counts.police--; continue; }
    p.role = 'citizen';
  }
}

function alivePlayers() {
  return Object.values(game.players).filter(p => p.alive);
}

function countByRole(includeDead=false) {
  const base = includeDead ? Object.values(game.players) : alivePlayers();
  const c = { mafia:0, doctor:0, police:0, citizen:0 };
  for (const p of base) c[p.role]++;
  return c;
}

function winCheck() {
  const alive = alivePlayers();
  const tally = countByRole(false);
  if (tally.mafia === 0) {
    game.phase = PHASES.END;
    game.logs.push('팀(시민 진영) 승리! 마피아 전원 퇴출.');
    return true;
  }
  if (tally.mafia >= (alive.length - tally.mafia)) {
    game.phase = PHASES.END;
    game.logs.push('마피아 승리! 인원 균형 역전.');
    return true;
  }
  if (game.projectProgress >= 100) {
    game.phase = PHASES.END;
    game.logs.push('팀(시민 진영) 승리! 프로젝트 100% 달성!');
    return true;
  }
  return false;
}

function startGame() {
  if (Object.keys(game.players).length < 6) return;
  assignRoles();
  game.dayCount = 1;
  game.phase = PHASES.SPRINT;
  game.projectProgress = 0;
  game.logs = ['게임 시작!', `Day ${game.dayCount} - 스프린트 시작.`];
  game.cooldowns.sabotage = 0;
  resetVotes();

  for (const p of Object.values(game.players)) {
    p.alive = true;
    p.ready = false;
  }
  io.emit('privateRoles', Object.fromEntries(Object.entries(game.players).map(([id,p])=>[id,p.role])));
}

function nextPhase() {
  if (winCheck()) return;
  switch (game.phase) {
    case PHASES.SPRINT:
      // 옵션: 자동으로 NIGHT로 전환(데모용 60초 타이머는 클라이언트에서 컨트롤)
      game.phase = PHASES.NIGHT;
      game.logs.push('밤(리뷰) 시작.');
      // reset night actions
      game.night = { kills: null, protects: new Set(), investigations: [] };
      break;
    case PHASES.NIGHT:
      // resolve actions
      resolveNight();
      if (winCheck()) return;
      game.phase = PHASES.MEETING;
      game.logs.push('회의/투표 시작.');
      resetVotes();
      break;
    case PHASES.MEETING:
      // tally votes
      const tally = game.votes;
      let max = 0, target = null, tie=false;
      for (const [pid, count] of Object.entries(tally)) {
        if (count > max) { max = count; target = pid; tie = false; }
        else if (count === max) { tie = true; }
      }
      if (!tie && target && game.players[target] && game.players[target].alive) {
        game.players[target].alive = false;
        game.logs.push(`투표로 ${game.players[target].name} 추방! (역할 공개: 비공개)`);
      } else {
        game.logs.push('동률 혹은 표 부족으로 추방 없음.');
      }
      if (winCheck()) return;
      game.dayCount += 1;
      game.phase = PHASES.SPRINT;
      game.logs.push(`Day ${game.dayCount} - 스프린트 시작.`);
      game.cooldowns.sabotage = Math.max(0, game.cooldowns.sabotage - 1);
      break;
  }
}

function resolveNight() {
  const killTarget = game.night.kills;
  let killed = null;
  if (killTarget && game.players[killTarget] && game.players[killTarget].alive) {
    const protectedSet = game.night.protects;
    if (!protectedSet.has(killTarget)) {
      game.players[killTarget].alive = false;
      killed = game.players[killTarget].name;
    }
  }
  if (killed) game.logs.push(`밤 사건: ${killed} 제거됨(의사 보호 실패).`);
  else game.logs.push('밤 사건: 아무도 죽지 않았습니다(의사 보호 성공 또는 마피아 미행동).');

  // Reveal investigation results privately
  for (const inv of game.night.investigations) {
    const { policeId, targetId } = inv;
    const policeSocket = io.sockets.sockets.get(policeId);
    if (policeSocket) {
      const isMafia = game.players[targetId]?.role === 'mafia';
      policeSocket.emit('investigationResult', {
        targetName: game.players[targetId]?.name || '알수없음',
        mafia: !!isMafia
      });
    }
  }
}

function randomTask() {
  return tasks[Math.floor(Math.random() * tasks.length)];
}

// Socket.IO handlers
io.on('connection', (socket) => {
  if (Object.keys(game.players).length >= MAX_PLAYERS) {
    socket.emit('full', {message:'방이 가득 찼습니다(16/16).'});
    socket.disconnect();
    return;
  }

  const defaultName = 'Player' + String(Math.floor(Math.random()*900)+100);
  game.players[socket.id] = {
    id: socket.id, name: defaultName, role: null, alive: true, ready: false, votedFor: null
  };
  game.order.push(socket.id);
  if (!game.hostId) game.hostId = socket.id;
  game.logs.push(`${defaultName} 입장.`);
  personalUpdate(socket);
  broadcast();

  socket.on('setName', (name) => {
    name = String(name||'').trim();
    if (!name) return;
    if (name.length > 20) name = name.slice(0,20);
    const p = game.players[socket.id];
    if (!p) return;
    p.name = name;
    game.logs.push(`${name} 닉네임 설정.`);
    personalUpdate(socket);
    broadcast();
  });

  socket.on('ready', (flag) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.LOBBY) return;
    p.ready = !!flag;
    broadcast();
  });

  socket.on('hostStart', () => {
    if (socket.id !== game.hostId) return;
    const allReady = Object.values(game.players).length >= 6;
    if (!allReady) return;
    startGame();
    // send each player their role
    for (const [id,p] of Object.entries(game.players)) {
      const s = io.sockets.sockets.get(id);
      if (s) s.emit('you', { id: p.id, name: p.name, role: p.role, alive: p.alive });
    }
    broadcast();
  });

  socket.on('requestTask', () => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.SPRINT || !p.alive) return;
    socket.emit('task', randomTask());
  });

  socket.on('submitTask', (payload) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.SPRINT || !p.alive) return;
    const { id, answerIndex } = payload||{};
    const t = tasks.find(x=>x.id===id);
    if (!t) return;
    if (t.answerIndex === answerIndex) {
      game.projectProgress = Math.min(100, game.projectProgress + t.progress);
      socket.emit('taskResult', { correct: true, progress: game.projectProgress });
      game.logs.push(`${p.name} 작업 성공(+${t.progress}%).`);
      if (winCheck()) {
        broadcast();
        return;
      }
    } else {
      socket.emit('taskResult', { correct: false, progress: game.projectProgress });
      game.logs.push(`${p.name} 작업 실패.`);
    }
    broadcast();
  });

  socket.on('triggerSabotage', () => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.SPRINT || !p.alive) return;
    if (p.role !== 'mafia') return;
    if (game.sabotage?.active) return;
    if (game.cooldowns.sabotage > 0) return;

    game.sabotage = {
      active: true,
      goal: 4, // 팀이 4개의 easy급 질문을 시간 내 맞춰야 함
      progress: 0,
      deadline: Date.now() + 90*1000 // 90s
    };
    game.phase = PHASES.SABOTAGE;
    game.logs.push('사보타주 발생! 제한 시간 내 복구 필요.');
    broadcast();
  });

  socket.on('sabotageAnswer', (payload) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.SABOTAGE || !p.alive || !game.sabotage?.active) return;
    const { correct } = payload||{};
    if (correct) {
      game.sabotage.progress += 1;
      game.logs.push(`${p.name} 사보타주 복구 기여(진행 ${game.sabotage.progress}/${game.sabotage.goal}).`);
    }
    if (game.sabotage.progress >= game.sabotage.goal) {
      game.logs.push('사보타주 복구 성공! 게임 정상화.');
      game.sabotage = null;
      game.phase = PHASES.SPRINT;
      game.cooldowns.sabotage = 1; // 다음 낮에만 쿨다운
    }
    broadcast();
  });

  // 서버가 주기적으로 사보타주 시간 초과를 체크
  const sabotageTimer = setInterval(()=>{
    if (game.phase === PHASES.SABOTAGE && game.sabotage?.active) {
      if (Date.now() >= game.sabotage.deadline) {
        // 실패
        game.logs.push('사보타주 복구 실패! 프로젝트 -10%');
        game.projectProgress = Math.max(0, game.projectProgress - 10);
        game.sabotage = null;
        game.phase = PHASES.SPRINT;
        game.cooldowns.sabotage = 1;
        broadcast();
      }
    }
  }, 1000);

  socket.on('nightKill', (targetId) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.NIGHT || !p.alive) return;
    if (p.role !== 'mafia') return;
    if (!game.players[targetId] || !game.players[targetId].alive) return;
    game.night.kills = targetId; // 단순화: 마지막 선택만 유효
    socket.emit('ack', {ok:true});
  });

  socket.on('nightProtect', (targetId) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.NIGHT || !p.alive) return;
    if (p.role !== 'doctor') return;
    if (!game.players[targetId] || !game.players[targetId].alive) return;
    game.night.protects.add(targetId);
    socket.emit('ack', {ok:true});
  });

  socket.on('nightInvestigate', (targetId) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.NIGHT || !p.alive) return;
    if (p.role !== 'police') return;
    if (!game.players[targetId] || !game.players[targetId].alive) return;
    game.night.investigations.push({policeId: socket.id, targetId});
    socket.emit('ack', {ok:true});
  });

  socket.on('vote', (targetId) => {
    const p = game.players[socket.id];
    if (!p || game.phase !== PHASES.MEETING || !p.alive) return;
    if (p.votedFor) return; // 1인 1표
    if (targetId && !game.players[targetId]) return;
    p.votedFor = targetId || 'skip';
    if (!game.votes[p.votedFor]) game.votes[p.votedFor] = 0;
    game.votes[p.votedFor] += 1;
    broadcast();
  });

  socket.on('advancePhase', () => {
    // host only
    if (socket.id !== game.hostId) return;
    if (game.phase === PHASES.SABOTAGE && game.sabotage?.active) return; // 진행중이면 스킵 불가
    nextPhase();
    broadcast();
  });

  socket.on('disconnect', () => {
    const p = game.players[socket.id];
    if (p) {
      game.logs.push(`${p.name} 퇴장.`);
      delete game.players[socket.id];
      game.order = game.order.filter(x => x !== socket.id);
      if (game.hostId === socket.id) {
        game.hostId = game.order[0] || null;
        if (game.hostId) game.logs.push(`${game.players[game.hostId]?.name || '새 호스트'} 가 호스트가 되었습니다.`);
      }
    }
    clearInterval(sabotageTimer);
    broadcast();
  });
});

server.listen(3000, () => {
  console.log('Coding Mafia server running on http://localhost:3000');
});
