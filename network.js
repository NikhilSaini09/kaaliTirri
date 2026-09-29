let myName = "";
let myPeerId = null; 
let peer = null;
let isHost = false;
let connections = {}; 
let hostConnection = null;
let lastSeen = {}; // peerId -> last time the host heard anything from that connection (heartbeat)
let actionTimestamps = {}; // peerId -> recent ACTION_ message timestamps, for basic flood protection

const HEARTBEAT_INTERVAL_MS = 4000;
const HEARTBEAT_STALE_MS = 10000;   // a couple of missed pings before we stop waiting for a clean 'close' event
const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_ACTIONS = 10;

function broadcastState() {
    if (!isHost) return;
    Object.values(connections).forEach(conn => {
        try {
            const safeState = getSanitizedStateForClient(conn.peer);
            conn.send({ type: 'STATE_UPDATE', state: safeState });
        } catch (e) {}
    });
    renderState(); 
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
    broadcastState();
}

function markDisconnected(peerId) {
    if (!isHost) return;
    delete connections[peerId];
    delete lastSeen[peerId];

    const known = gameState.players.some(p => p.id === peerId) ||
                  (gameState.spectators || []).some(s => s.id === peerId);
    if (!known) return;

    if (!gameState.disconnectedIds) gameState.disconnectedIds = [];
    if (!gameState.disconnectedAt) gameState.disconnectedAt = {};
    if (!gameState.disconnectedIds.includes(peerId)) gameState.disconnectedIds.push(peerId);
    gameState.disconnectedAt[peerId] = Date.now();
    broadcastState();
}

// Fallback for a killed tab/process, where neither a clean 'close' event nor our own LEAVE
// message is guaranteed to arrive - the host also watches for connections gone quiet.
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

// Small flood guard: a modified client spamming ACTION_ messages shouldn't be able to force
// a broadcastState() (a full sanitized-state send to every connection) many times a second.
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

// Clients ping the host every few seconds so a killed tab (no clean close, no LEAVE message)
// still gets caught by checkStaleConnections instead of sitting there as a ghost seat. This
// is a handful of bytes on an already-open data channel - negligible next to a single full
// state broadcast, which is what every bid/fold/card play already triggers for everyone.
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
                { urls: "turn:openrelay.metered.ca:80", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443", username: "openrelayproject", credential: "openrelayproject" },
                { urls: "turn:openrelay.metered.ca:443?transport=tcp", username: "openrelayproject", credential: "openrelayproject" }
            ]
        }
    };
}

// Wires up acceptance of incoming connections and routes their messages. Used both when a
// room is first created and when an existing player is promoted to host mid-session - in
// both cases `peer` is already open and `myPeerId` already set, so no new Peer() is needed.
function attachHostConnectionHandler() {
    // Guard against double-registration if this peer is promoted to host more than once
    // across a session (each `.on('connection', ...)` call otherwise stacks another listener).
    if (typeof peer.removeAllListeners === 'function') peer.removeAllListeners('connection');

    peer.on('connection', (conn) => {
        connections[conn.peer] = conn;
        lastSeen[conn.peer] = Date.now();

        // Give them the current state right away - JOIN_LOBBY (fresh join) or a migration
        // reconnect would otherwise sit blank until some unrelated broadcast happens to fire.
        try { conn.send({ type: 'STATE_UPDATE', state: getSanitizedStateForClient(conn.peer) }); } catch (e) {}

        conn.on('close', () => markDisconnected(conn.peer));

        conn.on('data', (data) => {
            lastSeen[conn.peer] = Date.now();
            if (data.type === 'PING') return;
            if (data.type && data.type.indexOf('ACTION_') === 0 && isRateLimited(conn.peer)) return;

            if (data.type === 'LEAVE') { markDisconnected(conn.peer); return; }
            if (data.type === 'JOIN_LOBBY') {
                let finalName = (data.name || '').trim();
                if (!finalName) return; // malformed/empty name - ignore rather than crash below

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

                    // Same idea for a spectator who dropped and is now rejoining - without this
                    // they'd come back as a brand-new spectator row while their old disconnected
                    // one sits there forever as an unremovable ghost entry in the lobby list.
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
                // conn.peer just finished setting itself up as the new host - tell everyone
                // else where to reconnect, then step down and reconnect ourselves.
                Object.keys(connections).forEach(id => {
                    if (id !== conn.peer) {
                        try { connections[id].send({ type: 'HOST_MIGRATED', newHostId: conn.peer }); } catch (e) {}
                    }
                });
                isHost = false;
                connectToHost(conn.peer);
            }
        });
    });
}

// Host-only: hand the authoritative role to another currently-connected active player.
function promoteToHost(targetId) {
    if (!isHost) return;
    if (targetId === myPeerId) return;
    const conn = connections[targetId];
    if (!conn) { alert("That player isn't currently connected."); return; }
    if (isDisconnected(targetId)) { alert("That player is disconnected."); return; }
    const targetPlayer = gameState.players.find(p => p.id === targetId);
    if (!targetPlayer) { alert("Only an active player can be made host."); return; }

    const mePlayer = gameState.players.find(p => p.id === myPeerId);
    if (mePlayer) mePlayer.name = mePlayer.name.replace(' (Host)', '').trim();
    targetPlayer.name = targetPlayer.name.replace(' (Host)', '').trim() + ' (Host)';

    conn.send({ type: 'PROMOTE_TO_HOST', state: gameState, gameStats: gameStats, playerData: playerData });
}

// Establishes (or re-establishes) this client's connection to whoever is currently hosting.
// Used both for the initial "Join Room" flow and for reconnecting after the host role
// migrates - in the latter case no JOIN_LOBBY is sent, since this peer is already a known
// player/spectator in the state it's about to receive.
function connectToHost(targetId, onFirstJoin) {
    if (hostConnection) { try { hostConnection.close(); } catch (e) {} }
    hostConnection = peer.connect(targetId);
    document.getElementById('roomIdDisplay').textContent = `Room ID: ${targetId}`;

    hostConnection.on('open', () => { if (onFirstJoin) onFirstJoin(); });

    hostConnection.on('data', (data) => {
        if (data.type === 'STATE_UPDATE') {
            gameState = data.state;
            renderState(); 
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
            leaveSent = false; // a fresh chance to notify whoever hosts next, should that change again

            const oldHostConn = hostConnection;
            hostConnection = null;
            document.getElementById('roomIdDisplay').textContent = `Room ID: ${myPeerId}`;
            try { oldHostConn.send({ type: 'PROMOTION_READY' }); } catch (e) {}
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
        
        document.getElementById('roomIdDisplay').textContent = `Room ID: ${id}`;
        switchView('view-lobby');
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
            switchView('view-lobby');
        });
    });
});