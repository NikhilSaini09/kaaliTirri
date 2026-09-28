window.addEventListener('beforeunload', (event) => {
    if (gameState.phase !== 'LOBBY' || gameState.players.length > 1) {
        event.preventDefault();
        event.returnValue = '';
    }
});

function switchView(viewId) {
    document.querySelectorAll('.view-container').forEach(el => el.style.display = 'none');
    document.getElementById(viewId).style.display = 'flex';
}

const PHASE_LABELS = {
    LOBBY: 'Lobby',
    BIDDING: 'Bidding',
    TRUMP_SELECTION: 'Choosing Trump',
    PLAYING: 'Playing',
    TRICK_EVALUATION: 'Evaluating Trick',
    GAMEOVER: 'Round Over'
};

function renderState() {
    if (gameState.phase === 'LOBBY') {
        switchView('view-lobby');
        renderLobby();
    } else {
        switchView('view-game');
        renderGameBoard();
    }
}

function renderLobby() {
    const lobbyDiv = document.getElementById('lobby-players');
    lobbyDiv.innerHTML = '';

    gameState.players.forEach(player => {
        const pDiv = document.createElement('div');
        pDiv.className = 'lobby-player-row';

        const displayName = cleanPlayerName(player.name);
        let html = `<span>${displayName}${player.id === myPeerId ? '<span class="you-tag">YOU</span>' : ''}</span>`;
        if (isHost && player.id !== myPeerId) {
            html += `<button class="btn-danger" onclick="kickPlayer('${player.id}')" style="padding: 5px 12px; font-size: 13px;">Kick</button>`;
        }

        pDiv.innerHTML = html;
        lobbyDiv.appendChild(pDiv);
    });

    if (isHost) {
        document.getElementById('startGameBtn').style.display = gameState.players.length >= 2 ? 'block' : 'none';
    }
}

let timerBarInterval = null;
let timerBarDeadline = null;

function startTimerBarLoop(deadline, totalMs, label) {
    const labelEl = document.getElementById('timer-bar-label');
    if (labelEl) labelEl.textContent = label || '';

    if (timerBarDeadline === deadline && timerBarInterval) return;
    timerBarDeadline = deadline;
    if (timerBarInterval) clearInterval(timerBarInterval);

    const wrap = document.getElementById('timer-bar-wrap');
    const fill = document.getElementById('timer-bar-fill');
    const text = document.getElementById('timer-bar-text');

    const tick = () => {
        const remainingMs = Math.max(0, deadline - Date.now());
        const remainingSec = Math.ceil(remainingMs / 1000);
        const pct = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
        fill.style.width = `${pct}%`;
        text.textContent = `${remainingSec}s`;
        wrap.classList.toggle('urgent', remainingSec <= 10);
        if (remainingMs <= 0) {
            clearInterval(timerBarInterval);
            timerBarInterval = null;
        }
    };
    tick();
    timerBarInterval = setInterval(tick, 250);
}

function stopTimerBarLoop() {
    if (timerBarInterval) clearInterval(timerBarInterval);
    timerBarInterval = null;
    timerBarDeadline = null;
    document.getElementById('timer-bar-wrap').classList.remove('is-visible', 'urgent');
}

function cleanPlayerName(name) {
    return name.replace(' (Host)', ' (H)').replace(' (Spectator)', ' (S)');
}

function renderGameBoard() {
    const myArea = document.getElementById('my-area');
    const boardArea = document.getElementById('center-board');
    const oppArea = document.getElementById('opponents-area');
    const gameInfo = document.getElementById('game-info');
    const hostControls = document.getElementById('host-controls-wrapper');
    const scorecard = document.getElementById('scorecard-modal');
    const modalBtn = document.getElementById('modalBackToLobbyBtn');
    const actionOverlay = document.getElementById('action-overlay');
    const biddingPanel = document.getElementById('bidding-panel');
    const trumpPanel = document.getElementById('trump-panel');
    const teamCardsContainer = document.getElementById('team-cards-container');
    const timerWrap = document.getElementById('timer-bar-wrap');
    const foldBanner = document.getElementById('fold-banner');

    myArea.innerHTML = ''; boardArea.innerHTML = ''; oppArea.innerHTML = '';
    document.getElementById('phase-display').innerHTML = `Phase: <span class="phase-label">${PHASE_LABELS[gameState.phase] || gameState.phase}</span>`;
    hostControls.style.display = isHost ? 'block' : 'none';

    const pauseOverlay = document.getElementById('pause-overlay');
    pauseOverlay.style.display = gameState.isPaused ? 'flex' : 'none';
    const resumeBtn = document.getElementById('resumeFromOverlayBtn');
    if (resumeBtn) resumeBtn.style.display = isHost ? 'inline-block' : 'none';
    const pauseMenuBtn = document.getElementById('hostPauseBtn');
    if (pauseMenuBtn) pauseMenuBtn.textContent = gameState.isPaused ? '▶ Resume Game' : '⏸ Pause Game';

    const activeTurnPlayer = (gameState.phase === 'PLAYING' && gameState.players.length > 0)
        ? gameState.players[gameState.turnIndex]
        : null;

    if (gameState.phase === 'BIDDING' && gameState.biddingDeadline) {
        timerWrap.classList.add('is-visible');
        startTimerBarLoop(gameState.biddingDeadline, BIDDING_TIME_MS, 'Bidding');
    } else if (gameState.phase === 'PLAYING' && gameState.turnDeadline) {
        timerWrap.classList.add('is-visible');
        const turnName = activeTurnPlayer ? cleanPlayerName(activeTurnPlayer.name) : '';
        const isMe = activeTurnPlayer && activeTurnPlayer.id === myPeerId;
        startTimerBarLoop(gameState.turnDeadline, TURN_TIME_MS, isMe ? 'Your turn' : `${turnName}'s turn`);
    } else {
        stopTimerBarLoop();
    }

    const myIndex = gameState.players.findIndex(p => p.id === myPeerId);
    const n = gameState.players.length;
    let opponents;
    if (myIndex !== -1) {
        opponents = [];
        for (let i = 1; i < n; i++) opponents.push(gameState.players[(myIndex + i) % n]);
    } else {
        opponents = gameState.players.slice();
    }

    const isMobile = window.innerWidth <= 860;
    oppArea.classList.toggle('mobile-row', isMobile);
    const totalOpp = opponents.length;
    const dense = totalOpp >= 5;
    boardArea.classList.toggle('dense-table', gameState.players.length >= 6);

    const SEAT_SPAN = 240, SEAT_START = 150;
    const seatAngle = {};
    opponents.forEach((player, index) => {
        seatAngle[player.id] = (SEAT_START + (index + 0.5) * SEAT_SPAN / totalOpp) * Math.PI / 180;
    });

    const tableWrapperEl = document.getElementById('table-wrapper');
    const tRect = tableWrapperEl.getBoundingClientRect();
    const tW = tRect.width || 380;
    const headerBottom = Math.max(
        document.getElementById('game-header').getBoundingClientRect().bottom,
        document.getElementById('status-stack').getBoundingClientRect().bottom
    );
    const halfW = dense ? 62 : 72, halfH = dense ? 54 : 62;

    function getSeatOffsetPct(index, total) {
        if (total === 1) return { left: 50, top: -38 };
        if (total === 2) return [{ left: -40, top: 50 }, { left: 140, top: 50 }][index];
        if (total === 3) return [{ left: -40, top: 56 }, { left: 50, top: -38 }, { left: 140, top: 56 }][index];
        const maxRxPx = window.innerWidth / 2 - halfW - 8;
        const maxRyPx = (tRect.top + tW / 2) - headerBottom - halfH - 8;
        const rxPx = Math.max(tW * 0.62, Math.min(tW * 1.0, maxRxPx));
        const ryPx = Math.max(tW * 0.6, Math.min(tW * 0.82, maxRyPx));
        const ang = seatAngle[opponents[index].id];
        return { left: 50 + Math.cos(ang) * rxPx / tW * 100, top: 50 + Math.sin(ang) * ryPx / tW * 100 };
    }
    function clampSeat(pos) {
        const x = tRect.left + pos.left / 100 * tW;
        const y = tRect.top + pos.top / 100 * tW;
        const cx = Math.min(Math.max(x, halfW + 6), window.innerWidth - halfW - 6);
        const cy = Math.max(y, headerBottom + halfH + 6);
        return { left: (cx - tRect.left) / tW * 100, top: (cy - tRect.top) / tW * 100 };
    }
    const seatPos = {};
    if (!isMobile) {
        opponents.forEach((player, index) => {
            seatPos[player.id] = clampSeat(getSeatOffsetPct(index, totalOpp));
        });
    }

    // 1. Center Board
    gameState.board.forEach((card) => {
        const cardEl = createCardElement(card, false);
        cardEl.classList.add('played-card');
        const rotation = (Math.random() * 12 - 6);
        cardEl.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;

        const CARD_R = isMobile ? 32 : 30;
        let leftPct = 50, topPct = 50;
        if (card.playedBy === myPeerId) {
            leftPct = 50; topPct = 50 + CARD_R;
        } else if (seatAngle[card.playedBy] !== undefined) {
            const ang = seatAngle[card.playedBy];
            leftPct = 50 + Math.cos(ang) * CARD_R;
            topPct = 50 + Math.sin(ang) * CARD_R;
        }
        cardEl.style.left = `${leftPct}%`;
        cardEl.style.top = `${topPct}%`;
        boardArea.appendChild(cardEl);
    });

    // 2. Opponents
    opponents.forEach((player) => {
        const oppDiv = document.createElement('div');
        oppDiv.className = 'opponent-container' + (isMobile ? ' compact' : '') + (dense ? ' dense' : '');

        const isActiveTurn = activeTurnPlayer && activeTurnPlayer.id === player.id;
        const showFoldState = (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION');
        const isFolded = showFoldState && !!player.hasFolded;
        if (isActiveTurn) oppDiv.classList.add('is-active-turn');
        if (isFolded) oppDiv.classList.add('is-folded');

        if (!isMobile) {
            const pos = seatPos[player.id];
            oppDiv.style.left = `${pos.left}%`;
            oppDiv.style.top = `${pos.top}%`;
            oppDiv.style.transform = 'translate(-50%, -50%)';
        }

        let teamIcon = player.team === 'BIDDER_TEAM' ? '🔥 ' : (player.team === 'DEFENDER_TEAM' ? '🛡️ ' : '');
        const cleanName = cleanPlayerName(player.name);

        let pileHtml = '';
        if (player.wonCards && player.wonCards.length > 0) {
            pileHtml = isMobile
                ? `<div class="won-pile-btn" title="Click to view won cards"><span>${player.wonCards.length}</span></div>`
                : // <div class="card face-down mini-card"></div>
                ` <div class="won-pile-btn" title="Click to view won cards">
                    <span>${player.wonCards.length}</span>
                </div>
            `;
        }

        const fanHtml = isMobile ? '' :
            `<div class="hand-fan">${'<div class="card face-down mini-card hand-fan-card"></div>'.repeat(Math.min(player.hand.length / 2 + 1, 5))}</div>`;

        oppDiv.innerHTML = `
            <span class="opp-name">${isActiveTurn ? '<span class="turn-dot"></span>' : ''}${teamIcon}${cleanName}</span>
            <span class="opp-meta">${player.hand.length} C &middot; ${player.points} Pts</span>
            ${fanHtml}
            ${isFolded ? '<span class="fold-tag">FOLDED</span>' : ''}
            ${pileHtml}
        `;

        const pileBtn = oppDiv.querySelector('.won-pile-btn');
        if (pileBtn) {
            pileBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openWonCardsModal(player);
            });
        }

        oppArea.appendChild(oppDiv);
    });

    const tableZoneEl = document.querySelector('.table-zone');
    tableZoneEl.style.paddingTop = isMobile ? `${Math.max(84, oppArea.offsetHeight + 28)}px` : '';

    if (gameState.phase !== 'LOBBY') {
        gameInfo.style.display = 'inline-flex';
        if (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION') {
            document.getElementById('bid-info').innerHTML = `High Bid: <b>${gameState.highestBid.amount || '—'}</b> (${gameState.highestBid.playerName ? cleanPlayerName(gameState.highestBid.playerName) : 'None yet'})`;
            document.getElementById('trump-info').innerHTML = '';
        } else {
            document.getElementById('bid-info').innerHTML = `Target: <b>${gameState.highestBid.amount}</b> (${cleanPlayerName(gameState.highestBid.playerName)})`;
            const trumpColor = (gameState.trumpSuit === '♥' || gameState.trumpSuit === '♦') ? 'red' : 'black';
            let trumpHtml = `Trump: <span class="trump-suit-display ${trumpColor}">${gameState.trumpSuit}</span>`;
            if (gameState.originalCalledCards && gameState.originalCalledCards.length > 0) {
                const partnerHtml = gameState.originalCalledCards.map(c => {
                    const suit = c.slice(-1);
                    const cls = (suit === '♥' || suit === '♦') ? 'red' : 'black';
                    return `<b class="${cls}">${c}</b>`;
                }).join(', ');
                trumpHtml += ` &middot; Partner: ${partnerHtml}`;
            }
            document.getElementById('trump-info').innerHTML = trumpHtml;
        }
    }

    // 3. Local Player
    const me = gameState.players.find(p => p.id === myPeerId);
    if (me) {
        const isMyTurn = activeTurnPlayer && activeTurnPlayer.id === me.id;
        const statusRow = document.createElement('div');
        statusRow.className = 'my-status-row';
        myArea.appendChild(statusRow);
        if (isMyTurn) {
            const badge = document.createElement('div');
            badge.className = 'your-turn-badge';
            badge.innerHTML = '<span class="turn-dot"></span> Your Turn';
            statusRow.appendChild(badge);
        }

        me.hand.forEach((card, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'my-card-wrapper';
            wrapper.style.zIndex = index;

            const playable = isCardPlayable(myPeerId, card);
            const cardEl = createCardElement(card, true, playable);
            if (playable) cardEl.addEventListener('click', () => requestPlayCard(card));

            wrapper.appendChild(cardEl);
            myArea.appendChild(wrapper);
        });

        const cardWrappers = myArea.querySelectorAll('.my-card-wrapper');
        if (cardWrappers.length > 0) {
            const cardCount = cardWrappers.length;
            const gap = 8;
            const naturalWidth = window.innerWidth <= 640 ? 46 : 65;
            const minWidth = window.innerWidth <= 640 ? 30 : 40;
            const availWidth = myArea.clientWidth - 44;
            let cardW = Math.floor((availWidth - (cardCount - 1) * gap) / cardCount);
            cardW = Math.max(minWidth, Math.min(naturalWidth, cardW));
            const cardH = Math.round(cardW * 1.42);
            const rankSize = Math.max(11, Math.round(cardW * 0.30));
            const suitSize = Math.max(12, Math.round(cardW * 0.34));

            cardWrappers.forEach(wrapper => {
                wrapper.style.margin = `0 ${gap / 2}px 6px`;
                const cardEl = wrapper.querySelector('.card');
                if (!cardEl) return;
                cardEl.style.width = `${cardW}px`;
                cardEl.style.height = `${cardH}px`;
                cardEl.style.fontSize = `${rankSize}px`;
                const suitEl = cardEl.querySelector('.card-suit');
                if (suitEl) suitEl.style.fontSize = `${suitSize}px`;
            });
        }

        if (me.wonCards && me.wonCards.length > 0) {
            const myPileDiv = document.createElement('div');
            myPileDiv.className = 'my-won-pile';
            myPileDiv.title = "Click to view your won cards";
                 // <div class="card face-down mini-card"></div>
            myPileDiv.innerHTML = `
                <span>${me.wonCards.length} (${me.points} pts)</span>
            `;
            myPileDiv.addEventListener('click', () => openWonCardsModal(me));
            statusRow.appendChild(myPileDiv);
        }

        if (me.hasFolded && (gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION')) {
            foldBanner.textContent = "You folded — waiting for the rest of the table";
            foldBanner.style.display = 'block';
        } else {
            foldBanner.style.display = 'none';
        }

        let showOverlay = false;
        biddingPanel.style.display = 'none';
        trumpPanel.style.display = 'none';

        if (gameState.phase === 'BIDDING' && !me.hasFolded) {
            showOverlay = true;
            biddingPanel.style.display = 'flex';

            const minBid = Math.max(MIN_BID, gameState.highestBid.amount + 5);
            const bidInput = document.getElementById('bidAmount');
            bidInput.min = minBid;
            bidInput.max = MAX_BID;
            bidInput.placeholder = `${minBid}\u2013${MAX_BID}`;

            bidInput.value = minBid;
        }
        else if (gameState.phase === 'TRUMP_SELECTION' && gameState.highestBid.playerId === myPeerId) {
            showOverlay = true;
            trumpPanel.style.display = 'flex';

            teamCardsContainer.innerHTML = '';
            let allowedCards = Math.floor((gameState.players.length - 2) / 2);
            for (let i = 0; i < allowedCards; i++) {
                const selectorDiv = document.createElement('div');

                const rankSelect = document.createElement('select');
                rankSelect.className = 'team-rank-select';
                values.forEach(v => rankSelect.appendChild(new Option(v, v)));

                const suitSelect = document.createElement('select');
                suitSelect.className = 'team-suit-select';
                suits.forEach(s => suitSelect.appendChild(new Option(s, s)));

                selectorDiv.appendChild(rankSelect); selectorDiv.appendChild(suitSelect);
                teamCardsContainer.appendChild(selectorDiv);
            }
        }

        actionOverlay.style.display = showOverlay ? 'flex' : 'none';
        actionOverlay.classList.toggle('no-dim', gameState.phase === 'BIDDING' || gameState.phase === 'TRUMP_SELECTION');
    }

    // 4. Game Over Modal
    if (gameState.phase === 'GAMEOVER') {
        scorecard.style.display = 'block';
        modalBtn.style.display = isHost ? 'block' : 'none';

        let bTeamHtml = ''; let bTotal = 0;
        let dTeamHtml = ''; let dTotal = 0;

        gameState.players.forEach(p => {
            if (p.team === 'BIDDER_TEAM') {
                bTeamHtml += `<div>${cleanPlayerName(p.name)}: ${p.points}</div>`;
                bTotal += p.points;
            } else {
                dTeamHtml += `<div>${cleanPlayerName(p.name)}: ${p.points}</div>`;
                dTotal += p.points;
            }
        });

        document.getElementById('bidder-stats').innerHTML = bTeamHtml;
        document.getElementById('defender-stats').innerHTML = dTeamHtml;
        document.getElementById('bidder-total').textContent = bTotal;
        document.getElementById('defender-total').textContent = dTotal;
        document.getElementById('bid-target').textContent = gameState.highestBid.amount;

        const won = bTotal >= gameState.highestBid.amount;
        document.getElementById('score-title').textContent = won ? "Bidder Team WON! 🎉" : "Bidder Team LOST! ❌";
        document.getElementById('score-title').style.color = won ? "#4CAF50" : "#f44336";
    } else {
        scorecard.style.display = 'none';
    }
}

function createCardElement(card, isClickable, isPlayable = true) {
    const cardEl = document.createElement('div');
    cardEl.className = `card ${card.suit === '♥' || card.suit === '♦' ? 'red' : 'black'}`;
    cardEl.innerHTML = `<span class="card-rank">${card.value}</span><span class="card-suit">${card.suit}</span>`;

    if (isClickable && !isPlayable) {
        cardEl.style.opacity = '0.5';
        cardEl.style.cursor = 'not-allowed';
    }
    return cardEl;
}

function requestPlayCard(card) {
    if (!isCardPlayable(myPeerId, card)) { alert("You cannot play this card."); return; }
    if (isHost) { handlePlayCard(myPeerId, card); broadcastState(); }
    else if (hostConnection) hostConnection.send({ type: 'ACTION_PLAY_CARD', card: card });
}

function saveGame() {
    const payload = {
        gameState: gameState,
        gameStats: gameStats
    };

    const dataStr = JSON.stringify(payload, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', `kalli_tilli_backup_${Date.now()}.json`);
    linkElement.click();
}

function loadGame(event) {
    if (!isHost) {
        alert("Only the room host can load save files.");
        return;
    }

    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const parsed = JSON.parse(e.target.result);

            if (parsed.gameState) {
                const currentConnections = gameState.players.map(p => ({ id: p.id, name: p.name }));

                gameState = parsed.gameState;
                gameStats = parsed.gameStats || {};

                currentConnections.forEach((conn, index) => {
                    if (gameState.players[index]) {
                        gameState.players[index].id = conn.id;
                    }
                });

                broadcastState();
                alert("Game state and stats restored.");
            } else {
                throw new Error("Invalid structure");
            }
        } catch(err) {
            alert("Failed to parse the save file.");
        }
    };
    reader.readAsText(file);
}

function openWonCardsModal(player) {
    const modal = document.getElementById('won-cards-modal');
    const title = document.getElementById('won-cards-title');
    const list = document.getElementById('won-cards-list');

    const cleanName = cleanPlayerName(player.name);
    title.textContent = `${cleanName}'s Won Cards (${player.wonCards ? player.wonCards.length : 0} cards, ${player.points} pts)`;
    list.innerHTML = '';

    if (!player.wonCards || player.wonCards.length === 0) {
        list.innerHTML = '<p style="color: #aaa; margin: auto;">No tricks won yet.</p>';
    } else {
        player.wonCards.forEach(card => {
            const cardEl = createCardElement(card, false);
            cardEl.style.cursor = 'default';
            list.appendChild(cardEl);
        });
    }
    modal.style.display = 'block';
    document.getElementById('won-cards-modal-backdrop').style.display = 'block';
}

// UI Bindings
document.getElementById('startGameBtn').addEventListener('click', () => {
    if (isHost) { startDeal(); broadcastState(); }
});

document.getElementById('modalBackToLobbyBtn').addEventListener('click', () => {
    if (isHost) {
        gameState.phase = 'LOBBY';

        if (gameState.spectators && gameState.spectators.length > 0) {
            gameState.spectators.forEach(s => {
                const cleanName = s.name.replace(" (Spectator)", "");
                gameState.players.push({ 
                    id: s.id, 
                    name: cleanName, 
                    hand: [], 
                    wonCards: [], 
                    points: 0, 
                    currentBid: 0, 
                    team: 'UNKNOWN' 
                });
            });
            gameState.spectators = [];
        }

        gameState.players.forEach(p => {
            p.hand = [];
            p.wonCards = [];
            p.points = 0;
            p.currentBid = 0;
            p.hasFolded = false;
            p.team = 'UNKNOWN';
        });

        gameState.board = [];
        gameState.highestBid = { playerId: null, amount: 0, playerName: "" };
        gameState.trumpSuit = null;
        gameState.calledCards = [];
        gameState.originalCalledCards = [];
        gameState.biddingDeadline = null;
        gameState.turnDeadline = null;
        gameState.isPaused = false;
        gameState.pausedRemaining = null;

        broadcastState();
    }
});

document.getElementById('submitBidBtn').addEventListener('click', () => {
    const bidInput = document.getElementById('bidAmount');
    const bid = bidInput.value;

    if (!bid || bid === "") return;

    if (isHost) { 
        const res = handlePlaceBid(myPeerId, bid); 
        if (res && res.error) {
            alert(res.error);
        } else {
            broadcastState(); 
        }
    }
    else if (hostConnection) {
        hostConnection.send({ type: 'ACTION_PLACE_BID', amount: bid });
    }
});

document.getElementById('foldBtn').addEventListener('click', () => {
    if (gameState.highestBid.playerId === myPeerId) { alert("You have the highest bid, you cannot fold!"); return; }
    if (isHost) { handleFold(myPeerId); broadcastState(); }
    else if (hostConnection) hostConnection.send({ type: 'ACTION_FOLD' });
});

document.getElementById('setTrumpBtn').addEventListener('click', () => {
    const suit = document.getElementById('trumpSuitSelect').value;
    const ranks = document.querySelectorAll('.team-rank-select');
    const suits = document.querySelectorAll('.team-suit-select');
    let chosenCards = [];

    for (let i = 0; i < ranks.length; i++) {
        chosenCards.push(`${ranks[i].value}${suits[i].value}`);
    }

    if (isHost) { handleSetTrump(myPeerId, suit, chosenCards); broadcastState(); }
    else if (hostConnection) hostConnection.send({ type: 'ACTION_SET_TRUMP', suit: suit, cards: chosenCards });
});

function closeWonCardsModal() {
    document.getElementById('won-cards-modal').style.display = 'none';
    document.getElementById('won-cards-modal-backdrop').style.display = 'none';
}
document.getElementById('closeWonCardsBtn')?.addEventListener('click', closeWonCardsModal);
document.getElementById('won-cards-modal-backdrop')?.addEventListener('click', closeWonCardsModal);

function closeHostMenu() {
    const menu = document.getElementById('host-dropdown');
    if (menu) menu.style.display = 'none';
}

document.getElementById('hostMenuToggle')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = document.getElementById('host-dropdown');
    const currentDisplay = window.getComputedStyle(menu).display;
    menu.style.display = (currentDisplay === 'none') ? 'flex' : 'none';
});

document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('host-controls-wrapper');
    if (wrapper && !wrapper.contains(e.target)) closeHostMenu();
});

document.getElementById('hostReshuffleBtn')?.addEventListener('click', () => {
    if(isHost) { startDeal(); broadcastState(); }
    closeHostMenu();
});
document.getElementById('hostPauseBtn')?.addEventListener('click', () => {
    if (isHost) { togglePause(); }
    closeHostMenu();
});
document.getElementById('resumeFromOverlayBtn')?.addEventListener('click', () => {
    if (isHost) { togglePause(); }
});
document.getElementById('hostBackToLobbyBtn')?.addEventListener('click', () => {
    if(isHost) { document.getElementById('modalBackToLobbyBtn').click(); }
    closeHostMenu();
});

document.getElementById('saveBtn')?.addEventListener('click', saveGame);
document.getElementById('loadInput')?.addEventListener('change', loadGame);
document.getElementById('hostSaveBtn')?.addEventListener('click', () => { saveGame(); closeHostMenu(); });
document.getElementById('hostLoadInput')?.addEventListener('change', (e) => { loadGame(e); closeHostMenu(); });

let lastIsMobile = window.innerWidth <= 860;
window.addEventListener('resize', () => {
    const nowMobile = window.innerWidth <= 860;
    if (nowMobile !== lastIsMobile) {
        lastIsMobile = nowMobile;
        if (gameState.phase !== 'LOBBY' && document.getElementById('view-game').style.display !== 'none') renderGameBoard();
    }
});