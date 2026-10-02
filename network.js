let myName = "";
let myPeerId = null; 
let peer = null;
let isHost = false;
let connections = {}; 
let hostConnection = null;
let lastSeen = {};
let actionTimestamps = {};
let pendingPromotionTarget = null;

const HEARTBEAT_INTERVAL_MS = 4000;
const HEARTBEAT_STALE_MS = 10000;
const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_ACTIONS = 10;

function broadcastState() {
    if (!isHost) return;

    const safeState = getSanitizedStateForClient(null);
    Object.values(connections).forEach(conn => {
        try {
            const realPlayer = gameState.players.find(p => p.id === conn.peer);
            const clientPlayers = safeState.players.map(p => 
                p.id === conn.peer && realPlayer ? { ...p, hand: realPlayer.hand } : p
            );
            conn.send({ type: 'STATE_UPDATE', state: { ...safeState, players: clientPlayers } });
        } catch (e) {}
    });
    renderState(); 
}

function sendGameStats() {
    if (!isHost) return;

    Object.values(connections).forEach(conn => {
        try {
            conn.send({ type: 'GAME_STATS_UPDATE', stats : gameStats });
        } catch (e) {}
    });
}

function kickPlayer(targetId) {
    if (!isHost) return;
    if (connections[targetId]) {
        connections[targetId].send({ type: 'KICKED', message: 'You have been removed by the host.' });
        connections[targetId].close();
        delete connections[targetId];
    }
    delete lastSeen[targetId];
    delete actionTimestamps[targetId];
    gameState.players = gameState.players.filter(p => p.id !== targetId);
    gameState.spectators = (gameState.spectators || []).filter(s => s.id !== targetId);
    gameState.excludedIds = (gameState.excludedIds || []).filter(id => id !== targetId);
    gameState.lobbyOrder = (gameState.lobbyOrder || []).filter(id => id !== targetId);
    gameState.disconnectedIds = (gameState.disconnectedIds || []).filter(id => id !== targetId);
    if (gameState.disconnectedAt) delete gameState.disconnectedAt[targetId];
    if (typeof cpuBidPlans !== 'undefined') delete cpuBidPlans[targetId];
    broadcastState();
}

function markDisconnected(peerId) {
    if (!isHost) return;
    delete connections[peerId];
    delete lastSeen[peerId];
    delete actionTimestamps[peerId];
    if (pendingPromotionTarget === peerId) pendingPromotionTarget = null;

    const known = gameState.players.some(p => p.id === peerId) ||
                  (gameState.spectators || []).some(s => s.id === peerId);
    if (!known) return;

    if (!gameState.disconnectedIds) gameState.disconnectedIds = [];
    if (!gameState.disconnectedAt) gameState.disconnectedAt = {};
    if (!gameState.disconnectedIds.includes(peerId)) gameState.disconnectedIds.push(peerId);
    gameState.disconnectedAt[peerId] = Date.now();
    broadcastState();
}

function checkStaleConnections() {
    if (!isHost) return;
    const now = Date.now();
    Object.keys(connections).forEach(peerId => {
        const seen = lastSeen[peerId];
        if (seen !== undefined && now - seen > HEARTBEAT_STALE_MS) {
            markDisconnected(peerId);
        }
    });
}
setInterval(checkStaleConnections, HEARTBEAT_INTERVAL_MS);

function isRateLimited(peerId) {
    const now = Date.now();
    let stamps = actionTimestamps[peerId];
    if (!stamps) { stamps = []; actionTimestamps[peerId] = stamps; }
    while (stamps.length && now - stamps[0] > RATE_LIMIT_WINDOW_MS) stamps.shift();
    if (stamps.length >= RATE_LIMIT_MAX_ACTIONS) return true;
    stamps.push(now);
    return false;
}

let leaveSent = false;
function sendLeaveNotice() {
    if (isHost || leaveSent || !hostConnection) return;
    leaveSent = true;
    try { hostConnection.send({ type: 'LEAVE' }); } catch (e) {}
}
window.addEventListener('pagehide', sendLeaveNotice);

setInterval(() => {
    if (isHost || !hostConnection) return;
    try { if (hostConnection.open) hostConnection.send({ type: 'PING' }); } catch (e) {}
}, HEARTBEAT_INTERVAL_MS);

function iceConfig() {
    return {
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },

                { urls: 'stun:openrelay.metered.ca:80' },

                { urls: "stun:stun.relay.metered.ca:80" },

                { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" },

                { urls: "turn:standard.relay.metered.ca:80",
                    username: atob("ZjcxZjU2NzkyZmZjOGViZDUzMTY1YWY3"), credential: atob("TXBYTU8wTGZ4MFJhaG9kUQ==")},
                { urls: "turn:standard.relay.metered.ca:80?transport=tcp",
                    username: atob("ZjcxZjU2NzkyZmZjOGViZDUzMTY1YWY3"), credential: atob("TXBYTU8wTGZ4MFJhaG9kUQ==")},
                { urls: "turn:standard.relay.metered.ca:443",
                    username: atob("ZjcxZjU2NzkyZmZjOGViZDUzMTY1YWY3"), credential: atob("TXBYTU8wTGZ4MFJhaG9kUQ==")},
                { urls: "turns:standard.relay.metered.ca:443?transport=tcp",
                    username: atob("ZjcxZjU2NzkyZmZjOGViZDUzMTY1YWY3"), credential: atob("TXBYTU8wTGZ4MFJhaG9kUQ==")},

                { urls: "turn:free.expressturn.com:3478",
                    username: atob("MDAwMDAwMDAyMTA2MDU0Njkz"), credential: atob("US95aXc1UXdGRVVmTDRqR3BuMkRvYWtUNU1BPQ==") }
            ]
        }
    };
}

function attachHostConnectionHandler() {
    if (typeof peer.removeAllListeners === 'function') peer.removeAllListeners('connection');

    peer.on('connection', (conn) => {
        connections[conn.peer] = conn;
        lastSeen[conn.peer] = Date.now();

        conn.on('open', () => {
            try { conn.send({ type: 'STATE_UPDATE', state: getSanitizedStateForClient(conn.peer) }); } catch (e) {}
        });

        conn.on('close', () => markDisconnected(conn.peer));

        conn.on('data', (data) => {
            lastSeen[conn.peer] = Date.now();
            if (data.type === 'PING') return;
            if (data.type && data.type.indexOf('ACTION_') === 0 && isRateLimited(conn.peer)) return;

            if (data.type === 'LEAVE') { markDisconnected(conn.peer); return; }
            if (data.type === 'JOIN_LOBBY') {
                let finalName = (data.name || '').trim();
                if (!finalName) return;

                if (typeof playerData !== 'undefined' && playerData && playerData.length > 0) {
                    const entry = playerData.find(pd => pd.code === finalName);
                    if (!entry || !entry.name || entry.name.trim() === "") {
                        conn.send({ type: 'ERROR', message: 'Invalid access code.' });
                        setTimeout(() => conn.close(), 500);
                        return;
                    }
                    finalName = entry.name.trim();

                    const existingPlayer = gameState.players.find(p => p.name === finalName);
                    const existingSpectator = (gameState.spectators || []).find(s => s.name.replace(' (Spectator)','') === finalName);

                    if (existingPlayer) {
                        if (connections[existingPlayer.id]) {
                            connections[existingPlayer.id].send({ type: 'KICKED', message: 'Session overridden from another tab.' });
                            connections[existingPlayer.id].close();
                            delete connections[existingPlayer.id];
                        }
                        const oldId = existingPlayer.id;
                        existingPlayer.id = conn.peer;
                        gameState.board.forEach(c => { if (c.playedBy === oldId) c.playedBy = conn.peer; });
                        if (gameState.highestBid.playerId === oldId) gameState.highestBid.playerId = conn.peer;
                        gameState.disconnectedIds = (gameState.disconnectedIds || []).filter(id => id !== oldId);
                        broadcastState();
                        return;
                    }
                    if (existingSpectator) {
                        if (connections[existingSpectator.id]) {
                            connections[existingSpectator.id].send({ type: 'KICKED', message: 'Session overridden from another tab.' });
                            connections[existingSpectator.id].close();
                            delete connections[existingSpectator.id];
                        }
                        const oldId = existingSpectator.id;
                        existingSpectator.id = conn.peer;
                        gameState.disconnectedIds = (gameState.disconnectedIds || []).filter(id => id !== oldId);
                        broadcastState();
                        return;
                    }
                } else {
                    const isDupPlayer = gameState.players.some(p => p.name.replace(/\s*\((Host|H|Spectator|S)\)\s*/gi, '') === finalName && !isDisconnected(p.id));
                    const isDupSpec = (gameState.spectators||[]).some(s => s.name.replace(/\s*\((Host|H|Spectator|S)\)\s*/gi, '') === finalName && !isDisconnected(s.id));
                    if (isDupPlayer || isDupSpec) {
                        conn.send({ type: 'ERROR', message: 'Name already taken. Please choose another or wait for disconnect.' });
                        setTimeout(() => conn.close(), 500);
                        return;
                    }

                    const dcPlayerIndex = (gameState.disconnectedIds || []).findIndex(dcId => {
                        const pl = gameState.players.find(p => p.id === dcId);
                        return pl && pl.name.replace(/\s*\((Host|H|Spectator|S)\)\s*/gi, '').trim() === finalName;
                    });

                    if (dcPlayerIndex !== -1) {
                        const oldId = gameState.disconnectedIds.splice(dcPlayerIndex, 1)[0];
                        const player = gameState.players.find(p => p.id === oldId);
                        if (player) {
                            player.id = conn.peer;
                            gameState.board.forEach(c => { if (c.playedBy === oldId) c.playedBy = conn.peer; });
                            if (gameState.highestBid.playerId === oldId) gameState.highestBid.playerId = conn.peer;
                            broadcastState();
                            return;
                        }
                    }

                    const dcSpecIndex = (gameState.disconnectedIds || []).findIndex(dcId => {
                        const sp = (gameState.spectators || []).find(s => s.id === dcId);
                        return sp && sp.name.replace(/\s*\((Host|H|Spectator|S)\)\s*/gi, '').trim() === finalName;
                    });

                    if (dcSpecIndex !== -1) {
                        const oldId = gameState.disconnectedIds.splice(dcSpecIndex, 1)[0];
                        const spectator = (gameState.spectators || []).find(s => s.id === oldId);
                        if (spectator) {
                            spectator.id = conn.peer;
                            broadcastState();
                            return;
                        }
                    }
                }

                if (gameState.phase !== 'LOBBY' && gameState.phase !== 'GAMEOVER') {
                    gameState.spectators.push({ id: conn.peer, name: finalName + " (Spectator)" });
                } else {
                    gameState.players.push({ id: conn.peer, name: finalName, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
                }
                broadcastState();
            }
            if (data.type === 'ACTION_PLACE_BID') { handlePlaceBid(conn.peer, data.amount); broadcastState(); }
            if (data.type === 'ACTION_FOLD') { handleFold(conn.peer); broadcastState(); }
            if (data.type === 'ACTION_SET_TRUMP') { handleSetTrump(conn.peer, data.suit, data.cards); broadcastState(); }
            if (data.type === 'ACTION_PLAY_CARD') { handlePlayCard(conn.peer, data.card); broadcastState(); }

            if (data.type === 'PROMOTION_READY') {
                if (conn.peer !== pendingPromotionTarget) return;
                pendingPromotionTarget = null;

                Object.keys(connections).forEach(id => {
                    if (id !== conn.peer) {
                        try { connections[id].send({ type: 'HOST_MIGRATED', newHostId: conn.peer }); } catch (e) {}
                    }
                });
                isHost = false;

                if (typeof peer.removeAllListeners === 'function') peer.removeAllListeners('connection');
                Object.values(connections).forEach(c => { try { c.close(); } catch (e) {} });
                connections = {};

                connectToHost(conn.peer);
                renderState();
            }
        });
    });
}

function updateRoomIdDisplay(id) {
    const display = document.getElementById('roomIdDisplay');
    if (!display) return;

    const safeId = String(id)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    
    display.innerHTML = `Room ID: <b style="letter-spacing: 1px;">${safeId}</b> <button id="copyRoomIdBtn" style="margin-left: 12px; padding: 4px 10px; font-size: 12px;" class="btn-ghost" title="Copy Room ID"> 📋 </button>`;
    
    const copyBtn = document.getElementById('copyRoomIdBtn');
    if (copyBtn) {
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(id).catch(() => {});
            copyBtn.textContent = ' ✓ ';
            copyBtn.style.color = 'var(--success)';
            copyBtn.style.borderColor = 'var(--success)';
            setTimeout(() => { 
                if (document.getElementById('copyRoomIdBtn')) {
                    document.getElementById('copyRoomIdBtn').textContent = ' 📋 ';
                    document.getElementById('copyRoomIdBtn').style.color = 'var(--ivory)';
                    document.getElementById('copyRoomIdBtn').style.borderColor = 'rgba(255,255,255,0.2)';
                }
            }, 2000);
        };
    }
}

function promoteToHost(targetId) {
    if (!isHost) return;
    if (targetId === myPeerId) return;
    const conn = connections[targetId];
    if (!conn) { alert("That player isn't currently connected."); return; }
    if (isDisconnected(targetId)) { alert("That player is disconnected."); return; }
    const targetPlayer = gameState.players.find(p => p.id === targetId);
    if (!targetPlayer) { alert("Only an active player can be made host."); return; }
    if (targetPlayer.isCPU) { alert("A CPU player can't be made host."); return; }

    const mePlayer = gameState.players.find(p => p.id === myPeerId);
    if (mePlayer) mePlayer.name = mePlayer.name.replace(' (Host)', '').trim();
    targetPlayer.name = targetPlayer.name.replace(' (Host)', '').trim() + ' (Host)';

    pendingPromotionTarget = targetId;
    conn.send({ type: 'PROMOTE_TO_HOST', state: gameState, gameStats: gameStats, playerData: playerData });
}

function connectToHost(targetId, onFirstJoin) {
    if (hostConnection) { try { hostConnection.close(); } catch (e) {} }
    hostConnection = peer.connect(targetId);
    updateRoomIdDisplay(targetId);

    hostConnection.on('open', () => { if (onFirstJoin) onFirstJoin(); });

    hostConnection.on('data', (data) => {
        if (data.type === 'STATE_UPDATE') {
            gameState = data.state;
            renderState(); 
        }
        if (data.type === 'GAME_STATS_UPDATE') {
            gameStats = data.stats;
        }
        if (data.type === 'KICKED') {
            alert("You have been kicked by the host.");
            location.reload();
        }
        if (data.type === 'ERROR') {
            alert(data.message);
            location.reload();
        }
        if (data.type === 'PROMOTE_TO_HOST') {
            gameState = data.state;
            gameStats = data.gameStats || {};
            playerData = data.playerData || [];
            connections = {};
            lastSeen = {};
            actionTimestamps = {};
            attachHostConnectionHandler();
            isHost = true;
            leaveSent = false;

            const oldHostConn = hostConnection;
            hostConnection = null;
            updateRoomIdDisplay(myPeerId);
            try { oldHostConn.send({ type: 'PROMOTION_READY' }); } catch (e) {}
            if (typeof startGameLoops === 'function') startGameLoops();
            renderState();
        }
        if (data.type === 'HOST_MIGRATED') {
            connectToHost(data.newHostId);
        }
    });
}

document.getElementById('hostBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('playerName').value.trim();
    if (!nameInput) { alert("Please enter your name."); return; }
    
    myName = nameInput + " (Host)";
    peer = new Peer(iceConfig());

    gameState.spectators = [];
    
    peer.on('open', (id) => {
        myPeerId = id;
        isHost = true;
        gameState.players.push({ id: myPeerId, name: myName, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
        
        updateRoomIdDisplay(id);
        renderState();
    });

    attachHostConnectionHandler();
});

document.getElementById('joinBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('playerName').value.trim();
    const roomId = document.getElementById('joinId').value.trim();
    
    if (!nameInput || !roomId) { alert("Name and Room ID required."); return; }
    
    myName = nameInput;
    peer = new Peer(iceConfig());
    
    peer.on('open', (id) => {
        myPeerId = id;
        connectToHost(roomId, () => {
            hostConnection.send({ type: 'JOIN_LOBBY', name: myName });
            renderState();
        });
    });
});
