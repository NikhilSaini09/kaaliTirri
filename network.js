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
        } catch (e) {
            // Connection already dead; markDisconnected() will handle it via the close event / LEAVE message.
        }
    });
    renderState(); 
}

function kickPlayer(targetId) {
    if (!isHost) return;
    if (connections[targetId]) {
        connections[targetId].send({ type: 'KICKED' });
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

// Host side: a player closed the tab / lost connection. They stay listed (shown as disconnected in the lobby).
function markDisconnected(peerId) {
    if (!isHost) return;
    delete connections[peerId];

    const known = gameState.players.some(p => p.id === peerId) ||
                  (gameState.spectators || []).some(s => s.id === peerId);
    if (!known) return; // e.g. someone we just kicked

    if (!gameState.disconnectedIds) gameState.disconnectedIds = [];
    if (!gameState.disconnectedIds.includes(peerId)) gameState.disconnectedIds.push(peerId);
    broadcastState();
}

// Client side: tell the host we're leaving. 'pagehide' fires when the tab is really closing
// (unlike 'beforeunload', it can't be cancelled by the "leave site?" prompt).
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
                if (gameState.phase !== 'LOBBY' && gameState.phase !== 'GAMEOVER') {
                    gameState.spectators.push({ id: conn.peer, name: data.name + " (Spectator)" });
                } else {
                    gameState.players.push({ id: conn.peer, name: data.name, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
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
