let myName = "";
let myPeerId = null; 
let peer = null;
let isHost = false;
let connections = {}; 
let hostConnection = null;
let lastSeen = {};
let actionTimestamps = {};
let chatTimestamps = {};
let reactionTimestamps = {};
let lastClientChatTime = 0;
let clientChatHistory = [];
let lastClientReactionTime = 0;
let pendingPromotionTarget = null;

const HEARTBEAT_INTERVAL_MS = 4000;
const HEARTBEAT_STALE_MS = 15000;
const RATE_LIMIT_WINDOW_MS = 2000;
const RATE_LIMIT_MAX_ACTIONS = 10;
const CHAT_RATE_LIMIT_WINDOW_MS = 5000;
const CHAT_RATE_LIMIT_MAX_MSGS = 5;
const CHAT_MIN_INTERVAL_MS = 400;
const REACTION_MIN_INTERVAL_MS = 400;

function broadcastState() {
    if (!isHost) return;

    let safeState;
    try {
        safeState = getSanitizedStateForClient(null);
    } catch (e) {
        console.error('[network] broadcastState: could not build the sanitized state; nothing was sent.', e);
        safeState = null;
    }

    if (safeState) {
        Object.values(connections).forEach(conn => {
            try {
                if (!conn.open) return;
                const realPlayer = gameState.players.find(p => p.id === conn.peer);
                const clientPlayers = safeState.players.map(p =>
                    p.id === conn.peer && realPlayer ? { ...p, hand: realPlayer.hand } : p
                );
                conn.send({ type: 'STATE_UPDATE', state: { ...safeState, players: clientPlayers } });
            } catch (e) {
                console.error('[network] broadcastState: failed to send to peer ' + conn.peer + ':', e);
            }
        });
    }

    try {
        renderState();
    } catch (e) {
        console.error('[network] broadcastState: renderState failed:', e);
    }
}

function sendGameStats() {
    if (!isHost) return;

    Object.values(connections).forEach(conn => {
        try {
            if (!conn.open) return;
            conn.send({ type: 'GAME_STATS_UPDATE', stats : statsForWire() });
        } catch (e) {
            console.error('[network] sendGameStats: failed to send to peer ' + conn.peer + ':', e);
        }
    });
}

function kickPlayer(targetId) {
    if (!isHost) return;
    if (targetId === myPeerId) return;
    if (gameState.phase !== 'LOBBY') {
        console.warn('[network] kickPlayer ignored: players can only be removed from the waiting room.');
        return;
    }
    if (connections[targetId]) {
        try {
            connections[targetId].send({ type: 'KICKED', message: 'You have been removed by the host.' });
        } catch (e) {
            console.warn('[network] kickPlayer: could not notify ' + targetId + ':', e);
        }
        try {
            connections[targetId].close();
        } catch (e) {
            console.warn('[network] kickPlayer: could not close the connection to ' + targetId + ':', e);
        }
        delete connections[targetId];
    }
    delete lastSeen[targetId];
    delete actionTimestamps[targetId];
    delete chatTimestamps[targetId];
    delete reactionTimestamps[targetId];
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
    if (!connections[peerId] || !connections[peerId].open) {
        delete connections[peerId];
    }
    delete lastSeen[peerId];
    delete actionTimestamps[peerId];
    delete chatTimestamps[peerId];
    delete reactionTimestamps[peerId];
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
    try {
        const now = Date.now();
        Object.keys(connections).forEach(peerId => {
            const seen = lastSeen[peerId];
            if (seen !== undefined && now - seen > HEARTBEAT_STALE_MS) {
                markDisconnected(peerId);
            }
        });
    } catch (e) {
        console.error('[network] checkStaleConnections failed:', e);
    }
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

function isChatRateLimited(peerId) {
    const now = Date.now();
    let stamps = chatTimestamps[peerId];
    if (!stamps) { stamps = []; chatTimestamps[peerId] = stamps; }
    if (stamps.length > 0 && now - stamps[stamps.length - 1] < CHAT_MIN_INTERVAL_MS) {
        return true;
    }
    while (stamps.length && now - stamps[0] > CHAT_RATE_LIMIT_WINDOW_MS) stamps.shift();
    if (stamps.length >= CHAT_RATE_LIMIT_MAX_MSGS) return true;
    stamps.push(now);
    return false;
}

function isReactionRateLimited(peerId) {
    const now = Date.now();
    const last = reactionTimestamps[peerId] || 0;
    if (now - last < REACTION_MIN_INTERVAL_MS) return true;
    reactionTimestamps[peerId] = now;
    return false;
}

let leaveSent = false;
function sendLeaveNoticeAndHostControl() {
    if (isHost) {
        emergencyHostTransfer();
        return;
    }
    if (leaveSent || !hostConnection) return;
    leaveSent = true;
    try {
        hostConnection.send({ type: 'LEAVE' });
    } catch (e) {
        console.warn('[network] Could not send the LEAVE notice:', e);
    }
}
window.addEventListener('pagehide', sendLeaveNoticeAndHostControl);

setInterval(() => {
    if (isHost || !hostConnection) return;
    try {
        if (hostConnection.open) hostConnection.send({ type: 'PING' });
    } catch (e) {
        console.warn('[network] Heartbeat ping failed:', e);
    }
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

function reassignMemberId(oldId, newId) {
    if (oldId === newId) return;
    const swap = id => (id === oldId ? newId : id);

    gameState.players.forEach(p => {
        if (p.id === oldId) p.id = newId;
        (p.wonCards || []).forEach(c => {
            if (Array.isArray(c)) {
                c.forEach(x => { if (x.playedBy === oldId) x.playedBy = newId; });
            } else if (c && c.playedBy === oldId) {
                c.playedBy = newId;
            }
        });
    });
    (gameState.spectators || []).forEach(sp => { if (sp.id === oldId) sp.id = newId; });
    (gameState.board || []).forEach(c => { if (c.playedBy === oldId) c.playedBy = newId; });
    if (gameState.highestBid && gameState.highestBid.playerId === oldId) gameState.highestBid.playerId = newId;

    gameState.lobbyOrder = (gameState.lobbyOrder || []).map(swap);
    gameState.excludedIds = (gameState.excludedIds || []).map(swap);
    gameState.disconnectedIds = (gameState.disconnectedIds || []).filter(id => id !== oldId);
    if (gameState.disconnectedAt) delete gameState.disconnectedAt[oldId];

    delete lastSeen[oldId];
    delete actionTimestamps[oldId];
    delete chatTimestamps[oldId];
    delete reactionTimestamps[oldId];
}

function notifyPeer(conn, message) {
    try {
        if (conn && conn.open) conn.send({ type: 'NOTICE', message: String(message) });
    } catch (e) {
        console.warn('[network] notifyPeer failed:', e);
    }
}

function evictConnection(id, message) {
    const old = connections[id];
    if (!old) return;
    try { old.send({ type: 'KICKED', message }); } catch (e) { console.warn('[network] evictConnection: send failed:', e); }
    try { old.close(); } catch (e) { console.warn('[network] evictConnection: close failed:', e); }
    delete connections[id];
}

function attachHostConnectionHandler() {
    if (!peer) return;
    if (typeof peer.removeAllListeners === 'function') peer.removeAllListeners('connection');

    peer.on('connection', (conn) => {
        if (!connections[conn.peer] && Object.keys(connections).length >= MAX_LOBBY_MEMBERS + 10) {
            console.warn('[network] Connection limit reached; refusing peer ' + conn.peer);
            try {
                conn.on('open', () => conn.close());
            } catch (e) {
                console.warn('[network] Could not close the refused connection:', e);
            }
            return;
        }
        connections[conn.peer] = conn;
        lastSeen[conn.peer] = Date.now();

        conn.on('open', () => {
            try {
                conn.send({ type: 'STATE_UPDATE', state: getSanitizedStateForClient(conn.peer) });
            } catch (e) {
                console.error('[network] Failed to send the initial state to ' + conn.peer + ':', e);
            }
        });

        conn.on('close', () => {
            try {
                if (connections[conn.peer] && connections[conn.peer] !== conn) return;
                delete connections[conn.peer];
                markDisconnected(conn.peer);
            } catch (e) {
                console.error('[network] Error while handling a closed connection:', e);
            }
        });

        conn.on('error', (err) => {
            console.error('[network] Connection error with peer ' + conn.peer + ':', err);
        });

        conn.on('data', (data) => {
          try {
            if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
            connections[conn.peer] = conn;
            lastSeen[conn.peer] = Date.now();

            let wasDisconnected = false;
            if (gameState.disconnectedIds && gameState.disconnectedIds.includes(conn.peer)) {
                gameState.disconnectedIds = gameState.disconnectedIds.filter(id => id !== conn.peer);
                if (gameState.disconnectedAt) delete gameState.disconnectedAt[conn.peer];
                wasDisconnected = true;
            }

            if (data.type === 'PING') {
                if (wasDisconnected) broadcastState();
                return;
            }
            if (data.type && data.type.indexOf('ACTION_') === 0 && isRateLimited(conn.peer)) return;

            if (data.type === 'LEAVE') { markDisconnected(conn.peer); return; }
            if (data.type === 'JOIN_LOBBY') {
                if (gameState.players.some(p => p.id === conn.peer) ||
                    (gameState.spectators || []).some(s => s.id === conn.peer)) return;

                if (typeof data.name !== 'string') return;
                const rawName = data.name.trim().slice(0, 100);
                if (!rawName) return;

                const usingAccessCodes = typeof playerData !== 'undefined' && playerData && playerData.length > 0;
                let finalName = rawName;
                if (!usingAccessCodes) {
                    finalName = sanitizeName(rawName);
                    if (!finalName) {
                        conn.send({ type: 'ERROR', message: 'Please enter a valid name (brackets and everything after them are removed).' });
                        setTimeout(() => conn.close(), 500);
                        return;
                    }
                }

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
                        if (existingPlayer.isCPU) {
                            conn.send({ type: 'ERROR', message: 'Invalid access code.' });
                            setTimeout(() => conn.close(), 500);
                            return;
                        }
                        const oldId = existingPlayer.id;
                        evictConnection(oldId, 'Session overridden from another tab.');
                        reassignMemberId(oldId, conn.peer);
                        broadcastState();
                        return;
                    }
                    if (existingSpectator) {
                        const oldId = existingSpectator.id;
                        evictConnection(oldId, 'Session overridden from another tab.');
                        reassignMemberId(oldId, conn.peer);
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
                        const oldId = gameState.disconnectedIds[dcPlayerIndex];
                        const player = gameState.players.find(p => p.id === oldId);
                        if (player) {
                            reassignMemberId(oldId, conn.peer);
                            broadcastState();
                            return;
                        }
                    }

                    const dcSpecIndex = (gameState.disconnectedIds || []).findIndex(dcId => {
                        const sp = (gameState.spectators || []).find(s => s.id === dcId);
                        return sp && sp.name.replace(/\s*\((Host|H|Spectator|S)\)\s*/gi, '').trim() === finalName;
                    });

                    if (dcSpecIndex !== -1) {
                        const oldId = gameState.disconnectedIds[dcSpecIndex];
                        const spectator = (gameState.spectators || []).find(s => s.id === oldId);
                        if (spectator) {
                            reassignMemberId(oldId, conn.peer);
                            broadcastState();
                            return;
                        }
                    }
                }

                const memberCount = gameState.players.length + (gameState.spectators || []).length;
                if (memberCount >= MAX_LOBBY_MEMBERS) {
                    conn.send({ type: 'ERROR', message: `Room is full (max ${MAX_LOBBY_MEMBERS} people).` });
                    setTimeout(() => conn.close(), 500);
                    return;
                }

                if (!gameState.spectators) gameState.spectators = [];
                if (gameState.phase !== 'LOBBY' && gameState.phase !== 'GAMEOVER') {
                    gameState.spectators.push({ id: conn.peer, name: finalName + " (Spectator)" });
                } else {
                    gameState.players.push({ id: conn.peer, name: finalName, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
                }
                broadcastState();
            }
            if (data.type === 'ACTION_PLACE_BID') {
                const result = handlePlaceBid(conn.peer, data.amount);
                if (result && result.error) notifyPeer(conn, result.error);
                broadcastState();
            }
            if (data.type === 'ACTION_FOLD') { handleFold(conn.peer); broadcastState(); }
            if (data.type === 'ACTION_SET_TRUMP') { handleSetTrump(conn.peer, data.suit, data.cards); broadcastState(); }
            if (data.type === 'ACTION_PLAY_CARD') { handlePlayCard(conn.peer, data.card); broadcastState(); }
            if (data.type === 'ACTION_TOGGLE_AI') {
                const p = gameState.players.find(pl => pl.id === conn.peer);
                if (p && !p.isCPU) {
                    p.isAutoPlay = !p.isAutoPlay;
                    try {
                        const safeState = getSanitizedStateForClient(conn.peer);
                        const clientPlayers = safeState.players.map(pl =>
                            pl.id === conn.peer ? { ...pl, hand: p.hand } : pl
                        );
                        conn.send({ type: 'STATE_UPDATE', state: { ...safeState, players: clientPlayers } });
                    } catch (e) {
                        console.warn('[network] Failed to send updated autoplay state to ' + conn.peer + ':', e);
                    }
                }
            }
            if (data.type === 'ACTION_PARTIAL_TRUMP') {
                if (gameState.highestBid.playerId === conn.peer && gameState.phase === 'TRUMP_SELECTION') {
                    gameState.draftTrump = { suit: data.suit, cards: Array.isArray(data.cards) ? data.cards : [] };
                }
            }
            if (data.type === 'CHAT_MSG') {
                if (isChatRateLimited(conn.peer)) {
                    console.warn('[network] Rate limited CHAT_MSG from ' + conn.peer);
                    return;
                }
                if (typeof data.text === 'string' && data.text.trim()) {
                    const cleanText = data.text.trim().slice(0, 150);
                    const sender = gameState.players.find(p => p.id === conn.peer) || (gameState.spectators || []).find(s => s.id === conn.peer);
                    const senderName = sender ? sender.name : (data.senderName || 'Player');
                    const chatPayload = {
                        type: 'CHAT_BROADCAST',
                        senderId: conn.peer,
                        senderName: senderName,
                        text: cleanText,
                        time: Date.now()
                    };
                    if (typeof handleIncomingChatMessage === 'function') handleIncomingChatMessage(chatPayload);
                    Object.values(connections).forEach(c => {
                        try { if (c.open) c.send(chatPayload); } catch (e) {
                            console.warn('[network] Failed to relay CHAT_BROADCAST to ' + c.peer + ':', e);
                        }
                    });
                }
            }
            if (data.type === 'EMOJI_REACTION') {
                if (isReactionRateLimited(conn.peer)) {
                    console.warn('[network] Rate limited EMOJI_REACTION from ' + conn.peer);
                    return;
                }
                if (typeof data.emoji === 'string') {
                    const sender = gameState.players.find(p => p.id === conn.peer) || (gameState.spectators || []).find(s => s.id === conn.peer);
                    const senderName = sender ? sender.name : (data.senderName || 'Player');
                    const reactionPayload = {
                        type: 'EMOJI_REACTION_BROADCAST',
                        senderId: conn.peer,
                        senderName: senderName,
                        emoji: data.emoji
                    };
                    if (typeof handleIncomingEmojiReaction === 'function') handleIncomingEmojiReaction(reactionPayload);
                    Object.values(connections).forEach(c => {
                        try { if (c.open) c.send(reactionPayload); } catch (e) {
                            console.warn('[network] Failed to relay EMOJI_REACTION_BROADCAST to ' + c.peer + ':', e);
                        }
                    });
                }
            }

            if (data.type === 'PROMOTION_READY') {
                if (conn.peer !== pendingPromotionTarget) return;
                pendingPromotionTarget = null;

                Object.keys(connections).forEach(id => {
                    if (id !== conn.peer) {
                        try {
                            connections[id].send({ type: 'HOST_MIGRATED', newHostId: conn.peer });
                        } catch (e) {
                            console.warn('[network] Could not tell ' + id + ' about the new host:', e);
                        }
                    }
                });
                isHost = false;

                if (typeof peer.removeAllListeners === 'function') peer.removeAllListeners('connection');
                Object.values(connections).forEach(c => {
                    try {
                        c.close();
                    } catch (e) {
                        console.warn('[network] Could not close a connection during host migration:', e);
                    }
                });
                connections = {};

                connectToHost(conn.peer);
                renderState();
            }
          } catch (e) {
            console.error('[network] Error while handling "' + (data && data.type) + '" from ' + conn.peer + ':', e);
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
    
    const isOffline = safeId === '000000';
    const tag = isOffline ? ' <span style="font-size: 11px; font-weight: 700; color: var(--brass-300); margin-left: 6px; padding: 2px 8px; background: rgba(201,162,77,0.18); border-radius: 999px; border: 1px solid rgba(201,162,77,0.4);">Offline Mode</span>' : '';

    display.innerHTML = `Room ID: <b style="letter-spacing: 1px;">${safeId}</b>${tag} <button id="copyRoomIdBtn" style="margin-left: 12px; padding: 4px 10px; font-size: 12px;" class="btn-ghost" title="Copy Room ID"> 📋 </button>`;
    
    const copyBtn = document.getElementById('copyRoomIdBtn');
    if (copyBtn) {
        copyBtn.onclick = () => {
            try {
                navigator.clipboard.writeText(id).catch(err => console.warn('[network] Clipboard write was rejected:', err));
            } catch (e) {
                console.warn('[network] Clipboard is unavailable (insecure context?):', e);
            }
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
    try {
        conn.send({ type: 'PROMOTE_TO_HOST', state: gameState, gameStats: statsForWire(), playerData: playerData });
    } catch (e) {
        console.error('[network] promoteToHost: failed to send the game state to ' + targetId + ':', e);
        pendingPromotionTarget = null;
        alert("Could not hand over hosting. Please try again.");
    }
}

let hostTransferDone = false;
function emergencyHostTransfer() {
    if (!isHost || hostTransferDone) return;

    const activeHumans = (gameState.players || []).filter(p => !p.isCPU && p.id !== myPeerId && !isDisconnected(p.id) && connections[p.id] && connections[p.id].open);
    const specHumans = (gameState.spectators || []).filter(s => !s.isCPU && s.id !== myPeerId && !isDisconnected(s.id) && connections[s.id] && connections[s.id].open);
    const candidates = activeHumans.length > 0 ? activeHumans : specHumans;

    if (candidates.length === 0) return;

    hostTransferDone = true;

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    const newHostId = chosen.id;

    if (gameState.phase !== 'LOBBY') {
        gameState.phase = 'LOBBY';
        gameState.deck = [];
        gameState.board = [];
        gameState.highestBid = { playerId: null, amount: 0, playerName: "" };
        gameState.trumpSuit = null;
        gameState.calledCards = [];
        gameState.originalCalledCards = [];
        gameState.biddingDeadline = null;
        gameState.turnDeadline = null;
        gameState.trumpSelectionDeadline = null;
        gameState.isPaused = false;
        gameState.pausedRemaining = null;
        gameState.excludedIds = (gameState.spectators || []).map(sp => sp.id);
        gameState.players.forEach(p => {
            p.hand = [];
            p.wonCards = [];
            p.points = 0;
            p.currentBid = 0;
            p.hasFolded = false;
            p.team = 'UNKNOWN';
            p.isAutoPlay = false;
        });
    }

    gameState.players = gameState.players.filter(p => p.id !== myPeerId);
    gameState.spectators = (gameState.spectators || []).filter(s => s.id !== myPeerId);
    gameState.excludedIds = (gameState.excludedIds || []).filter(id => id !== myPeerId);
    gameState.lobbyOrder = (gameState.lobbyOrder || []).filter(id => id !== myPeerId);
    gameState.disconnectedIds = (gameState.disconnectedIds || []).filter(id => id !== myPeerId);

    const targetPlayer = gameState.players.find(p => p.id === newHostId);
    if (targetPlayer) {
        targetPlayer.name = targetPlayer.name.replace(/\s*\((Host|H)\)\s*/gi, '').trim() + ' (Host)';
    } else {
        const targetSpec = (gameState.spectators || []).find(s => s.id === newHostId);
        if (targetSpec) {
            targetSpec.name = targetSpec.name.replace(/\s*\((Host|H|Spectator)\)\s*/gi, '').trim() + ' (Host)';
        }
    }

    try {
        if (connections[newHostId] && connections[newHostId].open) {
            connections[newHostId].send({
                type: 'PROMOTE_TO_HOST',
                state: gameState,
                gameStats: statsForWire(),
                playerData: playerData
            });
        }
    } catch (e) {
        console.warn('[network] emergencyHostTransfer failed to send to new host:', e);
    }

    Object.keys(connections).forEach(id => {
        if (id !== newHostId) {
            try {
                if (connections[id] && connections[id].open) {
                    connections[id].send({ type: 'HOST_MIGRATED', newHostId: newHostId });
                }
            } catch (e) {
                console.warn('[network] emergencyHostTransfer failed to notify ' + id + ':', e);
            }
        }
    });

    isHost = false;
}

function connectToHost(targetId, onFirstJoin) {
    if (!peer) {
        console.error('[network] connectToHost called before the peer exists.');
        return;
    }
    if (hostConnection) {
        try {
            hostConnection.close();
        } catch (e) {
            console.warn('[network] Could not close the previous host connection:', e);
        }
    }

    let thisConn;
    try {
        thisConn = peer.connect(targetId);
    } catch (e) {
        console.error('[network] peer.connect failed:', e);
        alert('Could not connect to that room. Check the Room ID and try again.');
        resetPeer();
        return;
    }
    hostConnection = thisConn;
    updateRoomIdDisplay(targetId);

    thisConn.on('open', () => {
        try {
            if (onFirstJoin) onFirstJoin();
        } catch (e) {
            console.error('[network] Error while joining the room:', e);
        }
    });

    thisConn.on('error', (err) => {
        console.error('[network] Host connection error:', err);
    });

    thisConn.on('close', () => {
        if (thisConn === hostConnection && !isHost) {
            console.warn('[network] The connection to the host was closed.');
        }
    });

    thisConn.on('data', (data) => {
        try {
            if (!data || typeof data !== 'object' || typeof data.type !== 'string') return;
            if (isHost) return;

            if (data.type === 'STATE_UPDATE') {
                if (!data.state || typeof data.state !== 'object' || !Array.isArray(data.state.players)) {
                    console.warn('[network] Ignoring a malformed STATE_UPDATE.');
                    return;
                }
                gameState = data.state;
                if (typeof updateMinBid === 'function') {
                    updateMinBid(gameState.players.length);
                } else if (typeof gameState.minBid === 'number') {
                    MIN_BID = gameState.minBid;
                }
                renderState();
            }
            if (data.type === 'GAME_STATS_UPDATE') {
                gameStats = toStatsMap(data.stats);
            }
            if (data.type === 'NOTICE') {
                alert(String(data.message));
            }
            if (data.type === 'KICKED') {
                alert("You have been kicked by the host.");
                location.reload();
            }
            if (data.type === 'ERROR') {
                alert(String(data.message));
                location.reload();
            }
            if (data.type === 'PROMOTE_TO_HOST') {
                if (!data.state || typeof data.state !== 'object' || !Array.isArray(data.state.players)) {
                    console.warn('[network] Ignoring a malformed PROMOTE_TO_HOST.');
                    return;
                }
                gameState = data.state;
                if (typeof updateMinBid === 'function') {
                    updateMinBid(gameState.players.length);
                }
                gameStats = toStatsMap(data.gameStats);
                playerData = data.playerData || [];
                connections = {};
                lastSeen = {};
                actionTimestamps = {};
                chatTimestamps = {};
                reactionTimestamps = {};
                attachHostConnectionHandler();
                isHost = true;
                leaveSent = false;

                const oldHostConn = hostConnection;
                hostConnection = null;
                updateRoomIdDisplay(myPeerId);
                try {
                    oldHostConn.send({ type: 'PROMOTION_READY' });
                } catch (e) {
                    console.error('[network] Could not confirm the promotion to the old host:', e);
                }
                if (typeof startGameLoops === 'function') startGameLoops();
                renderState();
            }
            if (data.type === 'HOST_MIGRATED') {
                connectToHost(data.newHostId);
            }
            if (data.type === 'CHAT_BROADCAST') {
                if (typeof handleIncomingChatMessage === 'function') handleIncomingChatMessage(data);
            }
            if (data.type === 'EMOJI_REACTION_BROADCAST') {
                if (typeof handleIncomingEmojiReaction === 'function') handleIncomingEmojiReaction(data);
            }
        } catch (e) {
            console.error('[network] Error while handling "' + (data && data.type) + '" from the host:', e);
        }
    });
}

function resetPeer() {
    try {
        if (hostConnection) hostConnection.close();
    } catch (e) {
        console.warn('[network] resetPeer: could not close the host connection:', e);
    }
    try {
        if (peer && !peer.destroyed) peer.destroy();
    } catch (e) {
        console.warn('[network] resetPeer: could not destroy the peer:', e);
    }
    hostConnection = null;
    peer = null;
    myPeerId = null;
    isHost = false;
    hostTransferDone = false;
    gameState.players = [];
    gameState.spectators = [];
    chatTimestamps = {};
    reactionTimestamps = {};
    lastClientChatTime = 0;
    clientChatHistory = [];
    lastClientReactionTime = 0;
}

function startOfflineRoom(nameInput) {
    if (peer && !peer.destroyed) {
        try { peer.destroy(); } catch (e) {
            console.warn('[network] startOfflineRoom: error destroying previous peer:', e);
        }
    }
    resetPeer();

    const raw = (nameInput || document.getElementById('playerName')?.value || 'Player').trim();
    const cleanName = sanitizeName(raw) || 'Player';

    myName = cleanName + " (Host)";
    myPeerId = "000000";
    isHost = true;
    peer = null;
    connections = {};
    hostTransferDone = false;

    gameState.players = [];
    gameState.spectators = [];
    gameState.excludedIds = [];
    gameState.lobbyOrder = [];
    gameState.disconnectedIds = [];
    gameState.phase = 'LOBBY';

    gameState.players.push({
        id: myPeerId,
        name: myName,
        hand: [],
        wonCards: [],
        points: 0,
        currentBid: 0,
        team: 'UNKNOWN'
    });

    updateRoomIdDisplay("000000");
    renderState();
}

function attachPeerErrorHandlers(p, fallbackName) {
    p.on('error', (err) => {
        console.error('[network] PeerJS error (' + (err && err.type) + '):', err);
        const type = err && err.type;
        if (type === 'peer-unavailable') {
            alert('That room could not be found. Check the Room ID and make sure the host is still online.');
            resetPeer();
        } else if (!myPeerId && p === peer) {
            if (fallbackName && confirm('Could not connect to online multiplayer server (' + (type || 'offline') + '). Would you like to create an offline room (000000) to play with bots?')) {
                startOfflineRoom(fallbackName);
            } else {
                alert('Could not connect to the game server (' + (type || 'unknown error') + '). Please try again.');
                resetPeer();
            }
        }
    });

    p.on('disconnected', () => {
        console.warn('[network] Lost the signalling server connection; trying to reconnect.');
        try {
            if (!p.destroyed) p.reconnect();
        } catch (e) {
            console.error('[network] Reconnect to the signalling server failed:', e);
        }
    });
}

document.getElementById('hostBtn').addEventListener('click', () => {
    if (peer && !peer.destroyed) return;
    const nameInput = sanitizeName(document.getElementById('playerName').value);
    if (!nameInput) { alert("Please enter a valid name (max " + MAX_NAME_LENGTH + " characters; brackets and anything after them are removed)."); return; }

    if (!navigator.onLine || typeof Peer === 'undefined') {
        startOfflineRoom(nameInput);
        return;
    }

    myName = nameInput + " (Host)";
    try {
        peer = new Peer(iceConfig());
    } catch (e) {
        console.warn('[network] Could not create peer, falling back to offline room:', e);
        startOfflineRoom(nameInput);
        return;
    }

    hostTransferDone = false;
    gameState.players = [];
    gameState.spectators = [];
    gameState.excludedIds = [];
    gameState.lobbyOrder = [];
    gameState.disconnectedIds = [];
    gameState.phase = 'LOBBY';

    peer.on('open', (id) => {
        try {
            myPeerId = id;
            isHost = true;
            updateRoomIdDisplay(id);

            if (!gameState.players.some(p => p.id === id)) {
                gameState.players.push({ id: myPeerId, name: myName, hand: [], wonCards: [], points: 0, currentBid: 0, team: 'UNKNOWN' });
            }

            renderState();
        } catch (e) {
            console.error('[network] Error while opening the room:', e);
        }
    });

    attachPeerErrorHandlers(peer, nameInput);
    attachHostConnectionHandler();
});

document.getElementById('offlineBtn')?.addEventListener('click', () => {
    const nameInput = document.getElementById('playerName')?.value;
    startOfflineRoom(nameInput);
});

document.getElementById('joinBtn').addEventListener('click', () => {
    if (peer && !peer.destroyed) return;
    const nameInput = document.getElementById('playerName').value.trim();
    const roomId = document.getElementById('joinId').value.trim();

    if (!nameInput || !roomId) { alert("Name and Room ID required."); return; }

    if (/^0+$/.test(roomId)) {
        startOfflineRoom(nameInput);
        return;
    }

    if (!navigator.onLine || typeof Peer === 'undefined') {
        alert('You are currently offline. To play with bots, enter Room ID 000000 or click Play Offline.');
        return;
    }

    myName = nameInput;
    try {
        peer = new Peer(iceConfig());
    } catch (e) {
        console.error('[network] Could not create the peer (is PeerJS blocked or offline?):', e);
        alert('Could not start the game networking. Check your connection and reload the page.');
        peer = null;
        return;
    }

    peer.on('open', (id) => {
        try {
            myPeerId = id;
            if (hostConnection && hostConnection.open) return;
            connectToHost(roomId, () => {
                try {
                    hostConnection.send({ type: 'JOIN_LOBBY', name: myName });
                } catch (e) {
                    console.error('[network] Could not send the join request:', e);
                    alert('Could not join the room. Please try again.');
                    return;
                }
                renderState();
            });
        } catch (e) {
            console.error('[network] Error while joining the room:', e);
        }
    });

    attachPeerErrorHandlers(peer);
});

function sendChatMessage(text) {
    if (!text || typeof text !== 'string') return;
    const cleanText = text.trim().slice(0, 150);
    if (!cleanText) return;

    const now = Date.now();
    if (now - lastClientChatTime < CHAT_MIN_INTERVAL_MS) return;
    clientChatHistory = clientChatHistory.filter(t => now - t < CHAT_RATE_LIMIT_WINDOW_MS);
    if (clientChatHistory.length >= CHAT_RATE_LIMIT_MAX_MSGS) return;
    clientChatHistory.push(now);
    lastClientChatTime = now;

    const sender = (gameState.players || []).find(p => p.id === myPeerId) || (gameState.spectators || []).find(s => s.id === myPeerId);
    const senderName = sender ? sender.name : (myName || 'Me');
    const chatPayload = {
        type: 'CHAT_BROADCAST',
        senderId: myPeerId || 'local',
        senderName: senderName,
        text: cleanText,
        time: now
    };
    if (isHost) {
        if (typeof handleIncomingChatMessage === 'function') handleIncomingChatMessage(chatPayload);
        Object.values(connections).forEach(c => {
            try { if (c.open) c.send(chatPayload); } catch (e) {
                console.warn('[network] sendChatMessage: failed to send to ' + c.peer + ':', e);
            }
        });
    } else if (hostConnection && hostConnection.open) {
        hostConnection.send({ type: 'CHAT_MSG', text: cleanText, senderName: myName });
    } else {
        if (typeof handleIncomingChatMessage === 'function') handleIncomingChatMessage(chatPayload);
    }
}

function sendEmojiReaction(emoji) {
    if (!emoji || typeof emoji !== 'string') return;

    const now = Date.now();
    if (now - lastClientReactionTime < REACTION_MIN_INTERVAL_MS) return;
    lastClientReactionTime = now;

    const sender = (gameState.players || []).find(p => p.id === myPeerId) || (gameState.spectators || []).find(s => s.id === myPeerId);
    const senderName = sender ? sender.name : (myName || 'Me');
    const reactionPayload = {
        type: 'EMOJI_REACTION_BROADCAST',
        senderId: myPeerId || 'local',
        senderName: senderName,
        emoji: emoji
    };
    if (isHost) {
        if (typeof handleIncomingEmojiReaction === 'function') handleIncomingEmojiReaction(reactionPayload);
        Object.values(connections).forEach(c => {
            try { if (c.open) c.send(reactionPayload); } catch (e) {
                console.warn('[network] sendEmojiReaction: failed to send to ' + c.peer + ':', e);
            }
        });
    } else if (hostConnection && hostConnection.open) {
        hostConnection.send({ type: 'EMOJI_REACTION', emoji: emoji, senderName: myName });
    } else {
        if (typeof handleIncomingEmojiReaction === 'function') handleIncomingEmojiReaction(reactionPayload);
    }
}
