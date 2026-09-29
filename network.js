let myName = "";
let myPeerId = null; 
let peer = null;
let isHost = false;
let connections = {}; 
let hostConnection = null;

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
    gameState.players = gameState.players.filter(p => p.id !== targetId);
    gameState.spectators = (gameState.spectators || []).filter(s => s.id !== targetId);
    gameState.excludedIds = (gameState.excludedIds || []).filter(id => id !== targetId);
    gameState.lobbyOrder = (gameState.lobbyOrder || []).filter(id => id !== targetId);
    gameState.disconnectedIds = (gameState.disconnectedIds || []).filter(id => id !== targetId);
    broadcastState();
}

function markDisconnected(peerId) {
    if (!isHost) return;
    delete connections[peerId];

    const known = gameState.players.some(p => p.id === peerId) ||
                  (gameState.spectators || []).some(s => s.id === peerId);
    if (!known) return;

    if (!gameState.disconnectedIds) gameState.disconnectedIds = [];
    if (!gameState.disconnectedIds.includes(peerId)) gameState.disconnectedIds.push(peerId);
    broadcastState();
}

let leaveSent = false;
function sendLeaveNotice() {
    if (isHost || leaveSent || !hostConnection) return;
    leaveSent = true;
    try { hostConnection.send({ type: 'LEAVE' }); } catch (e) {}
}
window.addEventListener('pagehide', sendLeaveNotice);

document.getElementById('hostBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('playerName').value.trim();
    if (!nameInput) { alert("Please enter your name."); return; }
    
    myName = nameInput + " (Host)";
    peer = new Peer({
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { 
                    urls: "turn:openrelay.metered.ca:80", 
                    username: "openrelayproject", 
                    credential: "openrelayproject" 
                },
                { 
                    urls: "turn:openrelay.metered.ca:443", 
                    username: "openrelayproject", 
                    credential: "openrelayproject" 
                },
                {
                    urls: "turn:openrelay.metered.ca:443?transport=tcp", 
                    username: "openrelayproject", 
                    credential: "openrelayproject" 
                }
            ]
        }
    });

    gameState.spectators = [];
    
    peer.on('open', (id) => {
        myPeerId = id;
        isHost = true;
        gameState.players.push({ id: myPeerId, name: myName, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
        
        document.getElementById('roomIdDisplay').textContent = `Room ID: ${id}`;
        switchView('view-lobby');
    });

    peer.on('connection', (conn) => {
        connections[conn.peer] = conn;

        conn.on('close', () => markDisconnected(conn.peer));

        conn.on('data', (data) => {
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
                    // NB: don't also send the raw gameState here - it's unsanitized (every
                    // player's hand in full) and broadcastState() below already delivers this
                    // connection a properly sanitized copy a moment later.
                } else {
                    gameState.players.push({ id: conn.peer, name: finalName, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
                }
                broadcastState();
            }
            if (data.type === 'ACTION_PLACE_BID') { handlePlaceBid(conn.peer, data.amount); broadcastState(); }
            if (data.type === 'ACTION_FOLD') { handleFold(conn.peer); broadcastState(); }
            if (data.type === 'ACTION_SET_TRUMP') { handleSetTrump(conn.peer, data.suit, data.cards); broadcastState(); }
            if (data.type === 'ACTION_PLAY_CARD') { handlePlayCard(conn.peer, data.card); broadcastState(); }
        });
    });
});

document.getElementById('joinBtn').addEventListener('click', () => {
    const nameInput = document.getElementById('playerName').value.trim();
    const roomId = document.getElementById('joinId').value.trim();
    
    if (!nameInput || !roomId) { alert("Name and Room ID required."); return; }
    
    myName = nameInput;
    peer = new Peer({
        config: {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                { urls: 'stun:stun2.l.google.com:19302' },
                { urls: 'stun:stun3.l.google.com:19302' },
                { 
                    urls: "turn:openrelay.metered.ca:80", 
                    username: "openrelayproject", 
                    credential: "openrelayproject" 
                },
                { 
                    urls: "turn:openrelay.metered.ca:443", 
                    username: "openrelayproject", 
                    credential: "openrelayproject" 
                },
                { 
                    urls: "turn:openrelay.metered.ca:443?transport=tcp", 
                    username: "openrelayproject", 
                    credential: "openrelayproject" 
                }
            ]
        }
    });
    
    peer.on('open', (id) => {
        myPeerId = id;
        hostConnection = peer.connect(roomId);
        
        hostConnection.on('open', () => {
            hostConnection.send({ type: 'JOIN_LOBBY', name: myName });
            document.getElementById('roomIdDisplay').textContent = `Room ID: ${roomId}`;
            switchView('view-lobby');
        });

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
        });
    });
});