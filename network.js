let myName = "";
let myPeerId = null; 
let peer = null;
let isHost = false;
let connections = {}; 
let hostConnection = null;

function broadcastState() {
    if (!isHost) return;
    Object.values(connections).forEach(conn => {
        const safeState = getSanitizedStateForClient(conn.peer);
        conn.send({ type: 'STATE_UPDATE', state: safeState });
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
    broadcastState();
}

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
        
        conn.on('data', (data) => {
            if (data.type === 'JOIN_LOBBY') {
                if (gameState.phase !== 'LOBBY' && gameState.phase !== 'GAMEOVER') {
                    gameState.spectators.push({ id: conn.peer, name: data.name + " (Spectator)" });
                    conn.send({ type: 'STATE_UPDATE', state: gameState, isSpectator: true });
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
